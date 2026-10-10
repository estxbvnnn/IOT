import { describe, expect, it } from 'vitest'
import { frameBuilder, inRollback, plus, send, T0, tokenFor } from './helpers'

const GH = 3 // I3

describe('POST /api/ingest · sensor de suelo desconectado', () => {
  it('suelo_raw null + falla «suelo» (lo que envía el nodo sin YL-38): bloq_sensor, sin % de humedad y alerta de falla', async () => {
    await inRollback(async (tx) => {
      const token = await tokenFor(tx, GH)
      await tx`update iot.alerts set status = 'resolved', resolved_at = now(), resolved_reason = 'manual' where greenhouse_id = ${GH} and status <> 'resolved'`
      const r = await send(tx, token, frameBuilder()({ suelo_raw: null, est: 'bloq_sensor', fallas: ['suelo'] }), T0)
      expect(r.status).toBe(200)
      const [st] = await tx<{ pump_state: string; soil_raw: number | null; soil_pct: number | null; faults: string[] }[]>`
        select s.pump_state, s.soil_raw, s.soil_pct, s.faults from iot.node_state s join iot.nodes n on n.id = s.node_id where n.greenhouse_id = ${GH}`
      expect(st).toMatchObject({ pump_state: 'bloq_sensor', soil_raw: null, soil_pct: null, faults: ['suelo'] })
      const alerts = await tx<{ type: string; status: string }[]>`select type, status from iot.alerts where greenhouse_id = ${GH}`
      expect(alerts.find((a) => a.type === 'sensor_fault')?.status).toBe('open')
      // Un sensor desconectado NO debe verse como «suelo saturado».
      expect(alerts.find((a) => a.type === 'soil_saturated')).toBeUndefined()
    })
  })
})

describe('POST /api/ingest · autenticación y validación', () => {
  it('rechaza sin token, con token inválido o de otro formato (401)', async () => {
    await inRollback(async (tx) => {
      const f = frameBuilder()
      expect((await send(tx, null, f(), T0)).status).toBe(401)
      expect((await send(tx, 'A'.repeat(43), f(), T0)).status).toBe(401)
      const r = await send(tx, 'corto', f(), T0)
      expect(r.status).toBe(401)
    })
  })

  it('un nodo deshabilitado no puede reportar', async () => {
    await inRollback(async (tx) => {
      const token = await tokenFor(tx, GH)
      await tx`update iot.nodes set enabled = false where greenhouse_id = ${GH}`
      expect((await send(tx, token, frameBuilder()(), T0)).status).toBe(401)
    })
  })

  it('rechaza cuerpos demasiado grandes (413), JSON roto y tramas inválidas (400)', async () => {
    await inRollback(async (tx) => {
      const token = await tokenFor(tx, GH)
      expect((await send(tx, token, null, T0, { raw: 'x'.repeat(5000) })).status).toBe(413)
      expect((await send(tx, token, null, T0, { raw: '{no es json' })).status).toBe(400)
      const bad = await send(tx, token, { ...frameBuilder()(), bomba: 7 }, T0)
      expect(bad.status).toBe(400)
      if (bad.status === 400) expect(bad.body.detalle.join(' ')).toMatch(/bomba/)
    })
  })
})

describe('POST /api/ingest · recepción de telemetría', () => {
  it('guarda la lectura, actualiza el estado y devuelve cfg con los umbrales del invernadero', async () => {
    await inRollback(async (tx) => {
      const token = await tokenFor(tx, GH)
      const f = frameBuilder()
      const r = await send(tx, token, f({ temp: 25.5, hum_aire: 55, suelo_raw: 640, luz: 12000, bomba: 0, est: 'idle', esp: 0, rssi: -70 }), T0)
      expect(r.status).toBe(200)
      if (r.status !== 200) return
      expect(r.body).toMatchObject({ ok: true, t: T0.toISOString() })
      expect(r.body.dup).toBeUndefined()
      expect(r.body.cfg).toMatchObject({ intervalo_s: 300, suelo_on: 700, suelo_off: 500, suelo_sat: 300, temp_max: 40, riego_max_s: 30, espera_s: 300 })
      expect(r.body.ordenes).toEqual([])

      const [row] = await tx<{ temp_c: number; soil_raw: number; soil_pct: number; light_lux: number; greenhouse_id: number; rssi: number }[]>`
        select temp_c, soil_raw, soil_pct, light_lux, greenhouse_id, rssi from iot.readings
         where greenhouse_id = ${GH} and ts = ${T0}`
      expect(row).toMatchObject({ temp_c: 25.5, soil_raw: 640, light_lux: 12000, greenhouse_id: GH, rssi: -70 })
      expect(row!.soil_pct).toBeCloseTo(37.4, 0) // (1023-640)/1023
      const [st] = await tx<{ ts: Date; fw_version: string; soil_raw: number; pump_state: string; last_seq: number }[]>`
        select s.ts, s.fw_version, s.soil_raw, s.pump_state, s.last_seq from iot.node_state s join iot.nodes n on n.id = s.node_id where n.greenhouse_id = ${GH}`
      expect(st).toMatchObject({ fw_version: 'test-1.0', soil_raw: 640, pump_state: 'idle', last_seq: 1 })
      expect(st!.ts.toISOString()).toBe(T0.toISOString())
    })
  })

  it('la identidad sale del token: un nodo solo puede escribir en su propio invernadero', async () => {
    await inRollback(async (tx) => {
      const token = await tokenFor(tx, GH)
      const before = await tx`select count(*)::int as n from iot.readings where greenhouse_id <> ${GH} and ts = ${T0}`
      // Aunque el cuerpo intente indicar otro nodo/invernadero, se ignora.
      await send(tx, token, { ...frameBuilder()(), greenhouse_id: 7, node_id: 9 }, T0)
      const after = await tx`select count(*)::int as n from iot.readings where greenhouse_id <> ${GH} and ts = ${T0}`
      expect(after[0]!.n).toBe(before[0]!.n)
      const mine = await tx`select count(*)::int as n from iot.readings where greenhouse_id = ${GH} and ts = ${T0}`
      expect(mine[0]!.n).toBe(1)
    })
  })

  it('descarta lecturas imposibles, las guarda como null y deja la falla registrada', async () => {
    await inRollback(async (tx) => {
      const token = await tokenFor(tx, GH)
      await send(tx, token, frameBuilder()({ temp: 120, hum_aire: 150, suelo_raw: 5000 }), T0)
      const [r] = await tx<{ temp_c: number | null; hum_air: number | null; soil_raw: number | null; faults: string[] }[]>`
        select temp_c, hum_air, soil_raw, faults from iot.readings where greenhouse_id = ${GH} and ts = ${T0}`
      expect(r).toMatchObject({ temp_c: null, hum_air: null, soil_raw: null })
      expect(r!.faults).toEqual(expect.arrayContaining(['temp_rango', 'hum_rango', 'suelo_rango']))
    })
  })

  it('la calibración del nodo define el porcentaje de humedad', async () => {
    await inRollback(async (tx) => {
      const token = await tokenFor(tx, GH)
      await tx`update iot.nodes set cal_dry = 800, cal_wet = 325 where greenhouse_id = ${GH}`
      await send(tx, token, frameBuilder()({ suelo_raw: 325 }), T0)
      const [r] = await tx<{ soil_pct: number }[]>`select soil_pct from iot.readings where greenhouse_id = ${GH} and ts = ${T0}`
      expect(r!.soil_pct).toBe(100)
    })
  })
})

describe('POST /api/ingest · anti-repetición e idempotencia', () => {
  it('una trama repetida (mismo arranque y seq) responde dup:true y NO se guarda otra vez', async () => {
    await inRollback(async (tx) => {
      const token = await tokenFor(tx, GH)
      const f = frameBuilder()
      const frame = f()
      expect((await send(tx, token, frame, T0)).status).toBe(200)
      const again = await send(tx, token, frame, plus(T0, 30))
      expect(again.status).toBe(200)
      if (again.status === 200) expect(again.body.dup).toBe(true)
      const [n] = await tx<{ n: number }[]>`select count(*)::int as n from iot.readings where greenhouse_id = ${GH} and ts in (${T0}, ${plus(T0, 30)})`
      expect(n!.n).toBe(1)
    })
  })

  it('un seq menor dentro del mismo arranque (reenvío antiguo) también se descarta', async () => {
    await inRollback(async (tx) => {
      const token = await tokenFor(tx, GH)
      const f = frameBuilder()
      const first = f()
      await send(tx, token, first, T0)
      await send(tx, token, f(), plus(T0, 10))
      await send(tx, token, f(), plus(T0, 20))
      const replay = await send(tx, token, first, plus(T0, 40))
      expect(replay.status === 200 && replay.body.dup).toBe(true)
    })
  })

  it('tras un reinicio (boot distinto) el contador vuelve a empezar y se acepta', async () => {
    await inRollback(async (tx) => {
      const token = await tokenFor(tx, GH)
      const a = frameBuilder(), b = frameBuilder()
      await send(tx, token, a(), T0)
      await send(tx, token, a(), plus(T0, 10))
      const r = await send(tx, token, b(), plus(T0, 20)) // seq = 1 con otro boot
      expect(r.status === 200 && r.body.dup).toBeFalsy()
      expect(r.status).toBe(200)
    })
  })

  it('limita la cadencia: dos tramas nuevas con menos de 1 s de diferencia → 429', async () => {
    await inRollback(async (tx) => {
      const token = await tokenFor(tx, GH)
      const f = frameBuilder()
      expect((await send(tx, token, f(), T0)).status).toBe(200)
      const fast = await send(tx, token, f(), new Date(T0.getTime() + 400))
      expect(fast.status).toBe(429)
      expect((await send(tx, token, f(), plus(T0, 2))).status).toBe(200)
    })
  })
})

describe('POST /api/ingest · eventos de la bomba y riegos', () => {
  it('registra el riego completo (encendido + apagado) con duración, motivo y agua estimada', async () => {
    await inRollback(async (tx) => {
      const token = await tokenFor(tx, GH)
      const f = frameBuilder()
      await send(tx, token, f({
        bomba: 0, ev: [{ t: 'pump_on', why: 'auto', ago: 65 }, { t: 'pump_off', why: 'tiempo_max', ago: 35, dur: 30 }],
      }), T0)
      const [e] = await tx<{ trigger: string; end_reason: string; duration_s: number; water_l: number; started_at: Date; ended_at: Date }[]>`
        select trigger, end_reason, duration_s, water_l, started_at, ended_at from iot.irrigation_events where greenhouse_id = ${GH} and started_at = ${plus(T0, -65)}`
      expect(e).toMatchObject({ trigger: 'auto', end_reason: 'tiempo_max', duration_s: 30 })
      expect(e!.water_l).toBeCloseTo(0.833, 2) // 30 s a 100 L/h
      expect(e!.ended_at.toISOString()).toBe(plus(T0, -35).toISOString())
    })
  })

  it('es idempotente: reenviar el mismo evento no duplica riegos; bomba encendida sin evento se reconstruye', async () => {
    await inRollback(async (tx) => {
      const token = await tokenFor(tx, GH)
      const f = frameBuilder()
      // Se «perdió» el evento pump_on: la trama solo informa bomba encendida.
      await send(tx, token, f({ bomba: 1, riego_s: 12, est: 'riego' }), T0)
      let open = await tx<{ trigger: string }[]>`select trigger from iot.irrigation_events where greenhouse_id = ${GH} and ended_at is null`
      expect(open).toHaveLength(1)
      // Otra trama con la bomba aún encendida no abre un segundo riego.
      await send(tx, token, f({ bomba: 1, riego_s: 22, est: 'riego' }), plus(T0, 10))
      open = await tx<{ trigger: string }[]>`select trigger from iot.irrigation_events where greenhouse_id = ${GH} and ended_at is null`
      expect(open).toHaveLength(1)
      // Se pierde el evento de apagado: la trama con bomba apagada cierra el riego como «desconocido».
      await send(tx, token, f({ bomba: 0 }), plus(T0, 40))
      const [closed] = await tx<{ end_reason: string; ended_at: Date | null }[]>`
        select end_reason, ended_at from iot.irrigation_events where greenhouse_id = ${GH} order by started_at desc limit 1`
      expect(closed).toMatchObject({ end_reason: 'desconocido' })
      expect(closed!.ended_at).not.toBeNull()
    })
  })

  it('un pump_off sin riego abierto se ignora sin error', async () => {
    await inRollback(async (tx) => {
      const token = await tokenFor(tx, GH)
      const r = await send(tx, token, frameBuilder()({ ev: [{ t: 'pump_off', why: 'objetivo', ago: 3, dur: 20 }] }), T0)
      expect(r.status).toBe(200)
    })
  })
})

describe('POST /api/ingest · alertas', () => {
  it('levanta una alerta crítica por temperatura y la despeja sola cuando baja', async () => {
    await inRollback(async (tx) => {
      const token = await tokenFor(tx, GH)
      await tx`update iot.alerts set status = 'resolved', resolved_at = now(), resolved_reason = 'manual' where greenhouse_id = ${GH} and status <> 'resolved'`
      const f = frameBuilder()
      await send(tx, token, f({ temp: 41.2 }), T0)
      const [a] = await tx<{ severity: string; status: string; message: string }[]>`
        select severity, status, message from iot.alerts where greenhouse_id = ${GH} and type = 'temp_high' and status <> 'resolved'`
      expect(a).toMatchObject({ severity: 'critical', status: 'open' })
      expect(a!.message).toMatch(/riego automático queda bloqueado/)
      // Otra trama caliente: no crea una segunda alerta, cuenta la ocurrencia.
      await send(tx, token, f({ temp: 42 }), plus(T0, 10))
      const n = await tx<{ n: number; occ: number }[]>`select count(*)::int as n, max(occurrences)::int as occ from iot.alerts where greenhouse_id = ${GH} and type = 'temp_high' and status <> 'resolved'`
      expect(n[0]).toMatchObject({ n: 1, occ: 2 })
      // Baja la temperatura: se despeja sola.
      await send(tx, token, f({ temp: 26 }), plus(T0, 20))
      const [r] = await tx<{ status: string; resolved_reason: string }[]>`
        select status, resolved_reason from iot.alerts where greenhouse_id = ${GH} and type = 'temp_high' order by id desc limit 1`
      expect(r).toMatchObject({ status: 'resolved', resolved_reason: 'auto' })
    })
  })

  it('una alerta reconocida se reabre si la gravedad sube', async () => {
    await inRollback(async (tx) => {
      const token = await tokenFor(tx, GH)
      await tx`update iot.alerts set status = 'resolved', resolved_at = now(), resolved_reason = 'manual' where greenhouse_id = ${GH} and status <> 'resolved'`
      const f = frameBuilder()
      await send(tx, token, f({ temp: 36 }), T0) // aviso
      await tx`update iot.alerts set status = 'acknowledged', acknowledged_at = now() where greenhouse_id = ${GH} and type = 'temp_high' and status = 'open'`
      await send(tx, token, f({ temp: 36.5 }), plus(T0, 10)) // sigue aviso: continúa reconocida
      let [a] = await tx<{ status: string; severity: string }[]>`select status, severity from iot.alerts where greenhouse_id = ${GH} and type = 'temp_high' and status <> 'resolved'`
      expect(a).toMatchObject({ status: 'acknowledged', severity: 'warning' })
      await send(tx, token, f({ temp: 41 }), plus(T0, 20)) // sube a crítica
      ;[a] = await tx<{ status: string; severity: string }[]>`select status, severity from iot.alerts where greenhouse_id = ${GH} and type = 'temp_high' and status <> 'resolved'`
      expect(a).toMatchObject({ status: 'open', severity: 'critical' })
    })
  })

  it('una falla de sensor levanta alerta; el nodo mástil evalúa viento; llegar una trama despeja «fuera de línea»', async () => {
    await inRollback(async (tx) => {
      const token = await tokenFor(tx, GH)
      await tx`update iot.alerts set status = 'resolved', resolved_at = now(), resolved_reason = 'manual' where greenhouse_id = ${GH} and status <> 'resolved'`
      // Alerta previa de nodo caído.
      await tx`insert into iot.alerts (greenhouse_id, type, severity, message) values (${GH}, 'node_offline', 'critical', 'prueba')`
      const f = frameBuilder()
      await send(tx, token, f({ temp: null, fallas: ['dht'] }), T0)
      const rows = await tx<{ type: string; status: string }[]>`select type, status from iot.alerts where greenhouse_id = ${GH} order by id`
      expect(rows.find((r) => r.type === 'sensor_fault')?.status).toBe('open')
      expect(rows.find((r) => r.type === 'node_offline')?.status).toBe('resolved')

      const mast = await tokenFor(tx, 'mast')
      await tx`update iot.alerts set status = 'resolved', resolved_at = now(), resolved_reason = 'manual' where greenhouse_id is null and status <> 'resolved'`
      const m = frameBuilder()
      const r = await send(tx, mast, { ...m(), temp: null, hum_aire: null, suelo_raw: null, viento: 27 }, T0)
      expect(r.status).toBe(200)
      if (r.status === 200) expect(r.body.cfg).toEqual({ ver: 1, intervalo_s: 60 })
      const [w] = await tx<{ severity: string; greenhouse_id: number | null }[]>`select severity, greenhouse_id from iot.alerts where type = 'wind_high' and status <> 'resolved'`
      expect(w).toMatchObject({ severity: 'critical', greenhouse_id: null })
    })
  })

  it('anomalía de bomba: 3 riegos automáticos seguidos a menos de 15 min entre sí = crítica; se despeja al recuperar la humedad', async () => {
    await inRollback(async (tx) => {
      const token = await tokenFor(tx, GH)
      await tx`update iot.alerts set status = 'resolved', resolved_at = now(), resolved_reason = 'manual' where greenhouse_id = ${GH} and status <> 'resolved'`
      // Historial: dos riegos automáticos previos, con 7,5 min entre ellos y 11,5 min hasta el nuevo (todos < 15 min).
      const [nid] = await tx<{ id: number }[]>`select id from iot.nodes where greenhouse_id = ${GH}`
      const at = (min: number) => plus(T0, min * 60)
      await tx`
        insert into iot.irrigation_events (node_id, greenhouse_id, started_at, ended_at, duration_s, trigger, end_reason) values
          (${nid!.id}, ${GH}, ${at(-20)}, ${at(-19.5)}, 30, 'auto', 'tiempo_max'),
          (${nid!.id}, ${GH}, ${at(-12)}, ${at(-11.5)}, 30, 'auto', 'tiempo_max')`
      const f = frameBuilder()
      await send(tx, token, f({ suelo_raw: 760, bomba: 1, est: 'riego', ev: [{ t: 'pump_on', why: 'auto', ago: 0 }] }), T0)
      const [a] = await tx<{ severity: string; message: string }[]>`select severity, message from iot.alerts where greenhouse_id = ${GH} and type = 'pump_anomaly' and status <> 'resolved'`
      expect(a).toMatchObject({ severity: 'critical' })
      expect(a!.message).toMatch(/3 riegos automáticos/)
      // La humedad llega al objetivo (≤ 500): la anomalía se despeja sola.
      await send(tx, token, f({ suelo_raw: 480, bomba: 0, ev: [{ t: 'pump_off', why: 'objetivo', ago: 0, dur: 20 }] }), plus(T0, 30))
      const [r] = await tx<{ status: string }[]>`select status from iot.alerts where greenhouse_id = ${GH} and type = 'pump_anomaly' order by id desc limit 1`
      expect(r!.status).toBe('resolved')
    })
  })

  it('riegos separados por horas NO generan anomalía aunque terminen por tiempo máximo', async () => {
    await inRollback(async (tx) => {
      const token = await tokenFor(tx, GH)
      await tx`update iot.alerts set status = 'resolved', resolved_at = now(), resolved_reason = 'manual' where greenhouse_id = ${GH} and status <> 'resolved'`
      const [nid] = await tx<{ id: number }[]>`select id from iot.nodes where greenhouse_id = ${GH}`
      const h = (hours: number) => plus(T0, hours * 3600)
      await tx`
        insert into iot.irrigation_events (node_id, greenhouse_id, started_at, ended_at, duration_s, trigger, end_reason) values
          (${nid!.id}, ${GH}, ${h(-20)}, ${plus(h(-20), 30)}, 30, 'auto', 'tiempo_max'),
          (${nid!.id}, ${GH}, ${h(-9)}, ${plus(h(-9), 30)}, 30, 'auto', 'tiempo_max')`
      await send(tx, token, frameBuilder()({ suelo_raw: 760, bomba: 1, ev: [{ t: 'pump_on', why: 'auto', ago: 0 }] }), T0)
      const rows = await tx`select 1 from iot.alerts where greenhouse_id = ${GH} and type = 'pump_anomaly' and status <> 'resolved'`
      expect(rows).toHaveLength(0)
    })
  })
})
