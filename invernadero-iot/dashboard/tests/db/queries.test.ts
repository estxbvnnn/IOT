import { describe, expect, it } from 'vitest'
import { ForbiddenError } from '@/lib/rbac'
import { acknowledgeAlert, listAlerts, sweepOfflineNodes, _resetSweepThrottle } from '@/lib/services/alerts'
import { listDevices, rotateNodeToken, setNodeEnabled } from '@/lib/services/devices'
import { exportReadingsCsv, getGreenhouseDetail, getGreenhouseSeries, getSiteOverview, resolveGreenhouse } from '@/lib/services/queries'
import { listAudit, verifyAuditChain } from '@/lib/services/audit'
import { T0, frameBuilder, inRollback, makeUser, plus, send, tokenFor } from './helpers'

/** «Ahora» de las pruebas: poco después del último dato sembrado, así los nodos figuran en línea. */
const NOW = new Date()

/** Historial propio de la prueba (24 h cada 10 min + un riego) para un invernadero: no depende de datos sembrados ni de nodos reales. */
async function seedHistory(tx: Parameters<typeof inRollback>[0] extends (tx: infer T) => unknown ? T : never, gh: number): Promise<void> {
  const [n] = await tx<{ id: number }[]>`select id from iot.nodes where greenhouse_id = ${gh}`
  for (let m = 24 * 60 - 20; m >= 0; m -= 10) {
    const ts = new Date(NOW.getTime() - m * 60_000)
    await tx`
      insert into iot.readings (node_id, greenhouse_id, ts, temp_c, hum_air, soil_raw, soil_pct, pump_on, rssi)
      values (${n!.id}, ${gh}, ${ts}, 24, 60, 600, 40, false, -60)`
  }
  const start = new Date(NOW.getTime() - 3 * 3600_000)
  await tx`
    insert into iot.irrigation_events (node_id, greenhouse_id, started_at, ended_at, duration_s, trigger, end_reason, soil_raw_start, soil_raw_end, water_l)
    values (${n!.id}, ${gh}, ${start}, ${new Date(start.getTime() + 20_000)}, 20, 'auto', 'objetivo', 720, 480, 0.5)`
}

const insertAlert = (tx: Parameters<typeof inRollback>[0] extends (tx: infer T) => unknown ? T : never, gh: number | null, type: string) =>
  tx`insert into iot.alerts (greenhouse_id, type, severity, message) values (${gh}, ${type}, 'warning', ${`prueba ${type} ${gh}`}) on conflict do nothing`

describe('panel: alcance por rol (un operador nunca ve sectores ajenos)', () => {
  it('dueño, agrónomo, técnico y administrador ven los 10 invernaderos; el operador solo los asignados', async () => {
    await inRollback(async (tx) => {
      for (const role of ['owner', 'agronomist', 'technician', 'admin'] as const) {
        const u = await makeUser(tx, role)
        const o = await getSiteOverview(tx, u.actor, NOW)
        expect(o.greenhouses.map((g) => g.code)).toEqual(['I1', 'I2', 'I3', 'I4', 'I5', 'I6', 'I7', 'I8', 'I9', 'I10'])
      }
      const op = await makeUser(tx, 'operator', { greenhouseIds: [2, 9] })
      const o = await getSiteOverview(tx, op.actor, NOW)
      expect(o.greenhouses.map((g) => g.code)).toEqual(['I2', 'I9'])
      expect(o.kpis.total).toBe(2)
      const none = await makeUser(tx, 'operator')
      expect((await getSiteOverview(tx, none.actor, NOW)).greenhouses).toEqual([])
    })
  })

  it('cada resumen trae distancia a la subestación (tabla 6 del informe), banda de suelo y estado coherentes', async () => {
    await inRollback(async (tx) => {
      const owner = await makeUser(tx, 'owner')
      const o = await getSiteOverview(tx, owner.actor, NOW)
      const dist = Object.fromEntries(o.greenhouses.map((g) => [g.code, g.distanceM]))
      expect(dist).toEqual({ I1: 48, I2: 33, I3: 36, I4: 34, I5: 39, I6: 39, I7: 40, I8: 20, I9: 41, I10: 51 })
      expect(o.substation).toEqual({ x: 50, y: 50 })
      for (const g of o.greenhouses) {
        expect(g.soilSpark).toHaveLength(24)
        expect(['ok', 'warning', 'critical', 'offline', 'nodata']).toContain(g.status)
        if (g.soilRaw !== null) expect(g.band).toBe(g.soilRaw < g.thresholds.soilSat ? 'saturado' : g.soilRaw >= g.thresholds.soilOn ? 'seco' : 'optimo')
      }
      const k = o.kpis
      expect(k.ok + k.warning + k.critical + k.offline + k.nodata).toBe(k.total)
    })
  })

  it('un nodo que reporta queda «en línea» con sus valores, y sin reportar figura «fuera de línea»', async () => {
    await inRollback(async (tx) => {
      const owner = await makeUser(tx, 'owner')
      const token = await tokenFor(tx, 3)
      await send(tx, token, frameBuilder()({ temp: 27.5, hum_aire: 48, suelo_raw: 610, luz: 30000, bomba: 1, est: 'riego', riego_s: 8 }), NOW)
      const o = await getSiteOverview(tx, owner.actor, plus(NOW, 30))
      const g = o.greenhouses.find((x) => x.code === 'I3')!
      expect(g).toMatchObject({ online: true, tempC: 27.5, humAir: 48, soilRaw: 610, band: 'optimo', lightLux: 30000, pumpOn: true, pumpState: 'riego', pumpRunS: 8 })
      expect(['ok', 'warning', 'critical']).toContain(g.status)
      const later = await getSiteOverview(tx, owner.actor, plus(NOW, 3600))
      expect(later.greenhouses.find((x) => x.code === 'I3')).toMatchObject({ online: false, status: 'offline' })
    })
  })

  it('el viento del mástil se resume con su nivel', async () => {
    await inRollback(async (tx) => {
      const owner = await makeUser(tx, 'owner')
      const mast = await tokenFor(tx, 'mast')
      await send(tx, mast, { ...frameBuilder()(), temp: null, hum_aire: null, suelo_raw: null, viento: 17.5 }, NOW)
      const o = await getSiteOverview(tx, owner.actor, plus(NOW, 10))
      expect(o.wind).toMatchObject({ ms: 17.5, online: true, level: 'warning', warn: 15, crit: 25 })
    })
  })
})

describe('detalle del invernadero, series y exportación', () => {
  it('resolveGreenhouse valida el código y el alcance', async () => {
    await inRollback(async (tx) => {
      const owner = await makeUser(tx, 'owner')
      const op = await makeUser(tx, 'operator', { greenhouseIds: [4] })
      expect(await resolveGreenhouse(tx, owner.actor, 'I10')).toBe(10)
      expect(await resolveGreenhouse(tx, op.actor, 'I4')).toBe(4)
      expect(await resolveGreenhouse(tx, op.actor, 'I5')).toBeNull() // sector ajeno
      expect(await resolveGreenhouse(tx, owner.actor, 'i4')).toBe(4) // la búsqueda no distingue mayúsculas (lower(code) = lower(...))
      for (const bad of ['I0x', 'I', '4', "I4'; --", 'I100', '../etc']) expect(await resolveGreenhouse(tx, owner.actor, bad)).toBeNull()
    })
  })

  it('devuelve series por rango; la calidad de enlace (RSSI) solo para quien puede verla', async () => {
    await inRollback(async (tx) => {
      const owner = await makeUser(tx, 'owner')
      const tech = await makeUser(tx, 'technician')
      await seedHistory(tx, 2)
      const a = await getGreenhouseSeries(tx, owner.actor, 2, '24h', NOW)
      const b = await getGreenhouseSeries(tx, tech.actor, 2, '24h', NOW)
      expect(a.temp.length).toBeGreaterThan(20)
      expect(a.temp.length).toBeLessThanOrEqual(150) // ≤ 144 promedios de 10 min
      expect(a.rssi).toBeNull()
      expect(b.rssi?.length).toBe(b.temp.length)
      for (const [t, v] of a.soilRaw) { expect(t).toBeGreaterThan(a.from); if (v !== null) expect(v).toBeLessThanOrEqual(1023) }
      expect(a.events.length).toBeGreaterThanOrEqual(1)
      const week = await getGreenhouseSeries(tx, owner.actor, 2, '7d', NOW)
      expect(week.bucketS).toBe(3600)
      expect(week.temp.length).toBeLessThanOrEqual(24 * 7 + 1)
    })
  })

  it('el detalle exige permiso y alcance', async () => {
    await inRollback(async (tx) => {
      const op = await makeUser(tx, 'operator', { greenhouseIds: [1] })
      const d = await getGreenhouseDetail(tx, op.actor, 1, '6h', NOW)
      expect(d.summary.code).toBe('I1')
      expect(d.range).toBe('6h')
      await expect(getGreenhouseDetail(tx, op.actor, 2, '6h', NOW)).rejects.toBeInstanceOf(ForbiddenError)
      await expect(getGreenhouseSeries(tx, op.actor, 2, '6h', NOW)).rejects.toBeInstanceOf(ForbiddenError)
    })
  })

  it('exportar CSV: dueño, agrónomo y administrador sí; técnico y operador no', async () => {
    await inRollback(async (tx) => {
      const from = new Date(NOW.getTime() - 3 * 3600_000)
      const owner = await makeUser(tx, 'owner')
      const csv = await exportReadingsCsv(tx, owner.actor, 1, from, NOW)
      const lines = csv.trim().split('\n')
      expect(lines[0]).toBe('timestamp_utc,temperatura_c,humedad_aire_pct,suelo_raw_0_1023,suelo_pct,luz_lux,bomba')
      expect(lines.length).toBeGreaterThan(10)
      expect(lines[1]!.split(',')).toHaveLength(7)
      for (const role of ['technician', 'operator'] as const) {
        const u = await makeUser(tx, role, { greenhouseIds: [1] })
        await expect(exportReadingsCsv(tx, u.actor, 1, from, NOW)).rejects.toBeInstanceOf(ForbiddenError)
      }
    })
  })
})

describe('alertas: alcance y reconocimiento', () => {
  it('el operador solo ve las alertas de sus sectores (y las del predio); los demás roles ven todas', async () => {
    await inRollback(async (tx) => {
      await insertAlert(tx, 1, 'hum_air_low')
      await insertAlert(tx, 8, 'hum_air_low')
      await insertAlert(tx, null, 'wind_high')
      const op = await makeUser(tx, 'operator', { greenhouseIds: [1] })
      const owner = await makeUser(tx, 'owner')
      const mine = await listAlerts(tx, op.actor, { state: 'active' })
      expect(mine.some((a) => a.greenhouseId === 1)).toBe(true)
      expect(mine.some((a) => a.greenhouseId === 8)).toBe(false)
      expect(mine.some((a) => a.greenhouseId === null)).toBe(true)
      const all = await listAlerts(tx, owner.actor, { state: 'active' })
      expect(all.some((a) => a.greenhouseId === 8)).toBe(true)
    })
  })

  it('reconocer exige permiso (el dueño y el técnico no) y alcance; queda en la bitácora', async () => {
    await inRollback(async (tx) => {
      await insertAlert(tx, 1, 'hum_air_low')
      await insertAlert(tx, 8, 'hum_air_low')
      const [mine] = await tx<{ id: number }[]>`select id from iot.alerts where greenhouse_id = 1 and type = 'hum_air_low' and status = 'open'`
      const [theirs] = await tx<{ id: number }[]>`select id from iot.alerts where greenhouse_id = 8 and type = 'hum_air_low' and status = 'open'`
      const op = await makeUser(tx, 'operator', { greenhouseIds: [1] })
      expect(await acknowledgeAlert(tx, op.actor, theirs!.id, T0)).toBe(false) // sector ajeno
      expect(await acknowledgeAlert(tx, op.actor, mine!.id, T0)).toBe(true)
      expect(await acknowledgeAlert(tx, op.actor, mine!.id, T0)).toBe(false) // ya reconocida
      const [row] = await tx<{ status: string; acknowledged_by: string }[]>`select status, acknowledged_by from iot.alerts where id = ${mine!.id}`
      expect(row).toMatchObject({ status: 'acknowledged', acknowledged_by: op.id })
      for (const role of ['owner', 'technician'] as const) {
        const u = await makeUser(tx, role)
        await expect(acknowledgeAlert(tx, u.actor, theirs!.id, T0)).rejects.toBeInstanceOf(ForbiddenError)
      }
      const admin = await makeUser(tx, 'admin')
      expect(await acknowledgeAlert(tx, admin.actor, theirs!.id, T0)).toBe(true)
      const a = await tx<{ action: string }[]>`select action from iot.audit_log where action = 'alert.ack' and actor_id in (${op.id}, ${admin.id})`
      expect(a.length).toBe(2)
    })
  })

  it('el barrido levanta «nodo fuera de línea» (crítica en invernaderos, aviso en el mástil) y no duplica', async () => {
    await inRollback(async (tx) => {
      _resetSweepThrottle()
      // El barrido solo mira nodos que ya reportaron: en la base real no todos lo han hecho, así que la prueba los deja a todos en línea «ahora».
      await tx`insert into iot.node_state (node_id, ts) select id, ${NOW} from iot.nodes on conflict (node_id) do update set ts = excluded.ts`
      await tx`update iot.alerts set status = 'resolved', resolved_at = now(), resolved_reason = 'manual' where type = 'node_offline' and status <> 'resolved'`
      const later = plus(NOW, 6 * 3600)
      const n1 = await sweepOfflineNodes(tx, later, true)
      expect(n1).toBe(11) // 10 invernaderos + mástil
      const rows = await tx<{ severity: string; greenhouse_id: number | null; message: string }[]>`
        select severity, greenhouse_id, message from iot.alerts where type = 'node_offline' and status <> 'resolved' order by greenhouse_id nulls last`
      expect(rows.filter((r) => r.greenhouse_id !== null).every((r) => r.severity === 'critical')).toBe(true)
      expect(rows.find((r) => r.greenhouse_id === null)?.severity).toBe('warning')
      expect(rows[0]!.message).toMatch(/sin reportar/)
      await sweepOfflineNodes(tx, plus(later, 60), true)
      const [c] = await tx<{ n: number }[]>`select count(*)::int as n from iot.alerts where type = 'node_offline' and status <> 'resolved'`
      expect(c!.n).toBe(11) // sin duplicados
    })
  })
})

describe('equipos y bitácora', () => {
  it('el técnico y el administrador ven el estado de enlace; el dueño no', async () => {
    await inRollback(async (tx) => {
      await tx`update iot.thresholds set interval_s = 300` // independiente de los ajustes que tenga hoy la base real
      const tech = await makeUser(tx, 'technician')
      const owner = await makeUser(tx, 'owner')
      const devices = await listDevices(tx, tech.actor, NOW)
      expect(devices).toHaveLength(11)
      expect(devices.filter((d) => d.kind === 'mast')).toHaveLength(1)
      for (const d of devices) {
        expect(d.tokenPrefix).toHaveLength(6)
        expect(d.rssiSpark).toHaveLength(24)
        expect(d.expected24h).toBe(d.kind === 'mast' ? 1440 : 288)
      }
      await expect(listDevices(tx, owner.actor, NOW)).rejects.toBeInstanceOf(ForbiddenError)
    })
  })

  it('rotar el token invalida el anterior de inmediato; solo el administrador puede', async () => {
    await inRollback(async (tx) => {
      const admin = await makeUser(tx, 'admin')
      const tech = await makeUser(tx, 'technician')
      const token = await tokenFor(tx, 5)
      const f = frameBuilder()
      expect((await send(tx, token, f(), T0)).status).toBe(200)
      const [n] = await tx<{ id: number }[]>`select id from iot.nodes where greenhouse_id = 5`
      await expect(rotateNodeToken(tx, tech.actor, n!.id)).rejects.toBeInstanceOf(ForbiddenError)
      const fresh = await rotateNodeToken(tx, admin.actor, n!.id)
      expect(fresh.token).not.toBe(token)
      expect((await send(tx, token, f(), plus(T0, 10))).status).toBe(401) // el viejo ya no sirve
      expect((await send(tx, fresh.token, f(), plus(T0, 20))).status).toBe(200)
      await setNodeEnabled(tx, admin.actor, n!.id, false)
      expect((await send(tx, fresh.token, f(), plus(T0, 30))).status).toBe(401)
      const a = await tx<{ action: string; detail: Record<string, unknown> }[]>`select action, detail from iot.audit_log where action = 'device.rotate_token'`
      expect(JSON.stringify(a[0]!.detail)).not.toContain(fresh.token)
    })
  })

  it('la bitácora se puede leer con filtros y su cadena de hashes es íntegra', async () => {
    await inRollback(async (tx) => {
      const admin = await makeUser(tx, 'admin')
      const u = await makeUser(tx, 'operator', { greenhouseIds: [1] })
      await rotateNodeToken(tx, admin.actor, (await tx<{ id: number }[]>`select id from iot.nodes where greenhouse_id = 1`)[0]!.id)
      const page = await listAudit(tx, { limit: 5, actionPrefix: 'device.' })
      expect(page.rows.length).toBeGreaterThanOrEqual(1)
      for (const r of page.rows) expect(r.action.startsWith('device.')).toBe(true)
      expect(page.rows[0]!.hash).toMatch(/^[0-9a-f]{16}$/)
      const byActor = await listAudit(tx, { actor: admin.email })
      expect(byActor.rows.every((r) => r.actorLabel.includes(admin.email))).toBe(true)
      void u
      const v = await verifyAuditChain(tx)
      expect(v.firstBrokenId).toBeNull()
      expect(v.checked).toBeGreaterThan(0)
    })
  })
})
