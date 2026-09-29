/**
 * Datos iniciales del sistema (idempotente: puede ejecutarse varias veces).
 *
 *   npm run db:seed                  → configuración + usuarios demo + nodos (SIN datos simulados)
 *   npm run db:seed -- --history 48  → además 48 h de historial sintético, solo para demostraciones
 *
 * Crea (solo lo que falte, nunca pisa datos existentes):
 *   - El predio: 10 invernaderos en las posiciones de la figura 2 del informe + el mástil central.
 *   - Umbrales por defecto (bandas del YL-38 de la imagen: 300 / 500 / 700).
 *   - Un nodo por invernadero + el nodo del mástil, con token propio (se guardan en .demo-devices.json).
 *   - Un usuario demo por rol, con contraseña aleatoria (se guardan en .demo-credentials.md).
 *   - Historial sintético (DEMOSTRATIVO), solo si se pide con --history N: por defecto NO se genera, para no mezclar
 *     datos simulados con los de los nodos reales.
 */
import fs from 'node:fs'
import path from 'node:path'
import { adminDb, DASHBOARD_DIR } from './lib/scriptenv'
import { hashPassword } from '../src/lib/auth/password'
import { generatePassword } from '../src/lib/auth/tokens'
import { createNode } from '../src/lib/services/devices'
import { audit } from '../src/lib/services/audit'
import { soilPct } from '../src/lib/domain/soil'
import { DEFAULT_CONFIG } from '../src/lib/sim/controller'
import { generateHistory } from '../src/lib/sim/history'
import { gaussian, mulberry32 } from '../src/lib/sim/world'
import { ROLE_LABELS, type Role } from '../src/lib/rbac'

/**
 * Posiciones (m) medidas de la figura 2 del informe, con origen en la esquina superior izquierda del
 * predio de 100 × 100 m y la subestación en (50, 50). Reproducen las distancias de la tabla 6:
 * I1 48 · I2 33 · I3 36 · I4 34 · I5 39 · I6 39 · I7 40 · I8 20 · I9 41 · I10 51 m.
 */
const GREENHOUSES: { id: number; code: string; x: number; y: number }[] = [
  { id: 1, code: 'I1', x: 16, y: 16 },
  { id: 2, code: 'I2', x: 55, y: 17 },
  { id: 3, code: 'I3', x: 15, y: 42 },
  { id: 4, code: 'I4', x: 77, y: 30 },
  { id: 5, code: 'I5', x: 82, y: 72 },
  { id: 6, code: 'I6', x: 17, y: 70 },
  { id: 7, code: 'I7', x: 26, y: 82 },
  { id: 8, code: 'I8', x: 52, y: 70 },
  { id: 9, code: 'I9', x: 60, y: 90 },
  { id: 10, code: 'I10', x: 86, y: 86 },
]

const DEMO_USERS: { email: string; name: string; role: Role; greenhouses?: number[] }[] = [
  { email: 'admin@invernadero.local', name: 'Administrador (demo)', role: 'admin' },
  { email: 'dueno@invernadero.local', name: 'Dueño de la empresa (demo)', role: 'owner' },
  { email: 'agronomo@invernadero.local', name: 'Ingeniera agrónoma (demo)', role: 'agronomist' },
  { email: 'operador1@invernadero.local', name: 'Operador sectores I1–I5 (demo)', role: 'operator', greenhouses: [1, 2, 3, 4, 5] },
  { email: 'operador2@invernadero.local', name: 'Operador sectores I6–I10 (demo)', role: 'operator', greenhouses: [6, 7, 8, 9, 10] },
  { email: 'tecnico@invernadero.local', name: 'Técnico de mantenimiento (demo)', role: 'technician' },
]

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(name)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback
}

const devicesFile = path.join(DASHBOARD_DIR, '.demo-devices.json')
const credentialsFile = path.join(DASHBOARD_DIR, '.demo-credentials.md')

function readJson<T>(file: string, fallback: T): T {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) as T } catch { return fallback }
}

async function main(): Promise<void> {
  const historyHours = Math.max(0, Math.min(24 * 30, Number(arg('--history', '0'))))
  const sql = adminDb(4)
  const summary: string[] = []
  try {
    // 1) Predio y umbrales.
    await sql`insert into iot.site_settings (id) values (1) on conflict do nothing`
    for (const g of GREENHOUSES) {
      await sql`
        insert into iot.greenhouses (id, code, name, crop, x_m, y_m, area_m2)
        values (${g.id}, ${g.code}, ${`Invernadero ${g.id}`}, null, ${g.x}, ${g.y}, 200)
        on conflict (id) do nothing`
      await sql`insert into iot.thresholds (greenhouse_id) values (${g.id}) on conflict do nothing`
    }
    summary.push(`✓ predio: ${GREENHOUSES.length} invernaderos con umbrales por defecto (riego ≥ 700, apagar ≤ 500, saturado < 300)`)

    // 2) Nodos y tokens.
    const tokens = readJson<Record<string, string>>(devicesFile, {})
    const existing = await sql<{ greenhouse_id: number | null; kind: string; id: number }[]>`select id, kind, greenhouse_id from iot.nodes`
    const haveGh = new Set(existing.filter((n) => n.greenhouse_id !== null).map((n) => n.greenhouse_id))
    let created = 0
    for (const g of GREENHOUSES) {
      if (haveGh.has(g.id)) continue
      const n = await createNode(sql, { kind: 'greenhouse', greenhouseId: g.id, label: `Nodo ${g.code}` })
      tokens[g.code] = n.token
      created++
    }
    if (!existing.some((n) => n.kind === 'mast')) {
      const n = await createNode(sql, { kind: 'mast', greenhouseId: null, label: 'Mástil central (anemómetro)' })
      tokens.MAST = n.token
      created++
    }
    if (created > 0) {
      fs.writeFileSync(devicesFile, JSON.stringify(tokens, null, 2), { mode: 0o600 })
      summary.push(`✓ nodos: ${created} creados; tokens en .demo-devices.json (solo existen ahí: la base guarda su SHA-256)`)
    } else summary.push('= nodos: ya existen')

    // 3) Usuarios demo.
    const newCreds: { email: string; password: string; role: Role }[] = []
    for (const u of DEMO_USERS) {
      const [exists] = await sql`select id from iot.app_users where email = ${u.email}`
      if (exists) continue
      const password = generatePassword(16)
      const [row] = await sql<{ id: string }[]>`
        insert into iot.app_users (email, name, role, password_hash)
        values (${u.email}, ${u.name}, ${u.role}, ${await hashPassword(password)}) returning id`
      for (const gid of u.greenhouses ?? []) {
        await sql`insert into iot.user_greenhouses (user_id, greenhouse_id) values (${row!.id}, ${gid})`
      }
      newCreds.push({ email: u.email, password, role: u.role })
    }
    if (newCreds.length > 0) {
      const old = fs.existsSync(credentialsFile) ? fs.readFileSync(credentialsFile, 'utf8') : ''
      const lines = newCreds.map((c) => `| ${ROLE_LABELS[c.role]} | \`${c.email}\` | \`${c.password}\` |`)
      const header = old.includes('| Rol |') ? '' : '# Cuentas demo\n\nGeneradas por `npm run db:seed`. Solo para desarrollo: cámbialas o desactívalas antes de exponer el sistema.\n\n| Rol | Correo | Contraseña |\n|---|---|---|\n'
      fs.writeFileSync(credentialsFile, `${old}${header}${lines.join('\n')}\n`, { mode: 0o600 })
      summary.push(`✓ usuarios demo: ${newCreds.length} creados; contraseñas en .demo-credentials.md`)
    } else summary.push('= usuarios demo: ya existen')

    // 4) Historial sintético (solo para nodos sin lecturas).
    if (historyHours > 0) {
      const now = Date.now()
      const nodes = await sql<{ id: number; greenhouse_id: number | null; kind: string; flow: number | null }[]>`
        select n.id, n.greenhouse_id, n.kind, g.flow_lph as flow
          from iot.nodes n left join iot.greenhouses g on g.id = n.greenhouse_id
         where not exists (select 1 from iot.readings r where r.node_id = n.id)`
      for (const n of nodes) {
        if (n.kind === 'mast') { await seedMast(sql, n.id, now, historyHours); continue }
        const gid = n.greenhouse_id!
        const h = generateHistory({ seed: 1000 + gid, startMs: now - historyHours * 3600_000, endMs: now, config: DEFAULT_CONFIG })
        for (let i = 0; i < h.readings.length; i += 1000) {
          const chunk = h.readings.slice(i, i + 1000).map((r) => ({
            node_id: n.id, greenhouse_id: gid, ts: new Date(r.ts), temp_c: r.tempC, hum_air: r.humAir,
            soil_raw: r.soilRaw, soil_pct: soilPct(r.soilRaw), light_lux: r.lightLux, pump_on: r.pumpOn, rssi: r.rssi,
          }))
          await sql`insert into iot.readings ${sql(chunk, 'node_id', 'greenhouse_id', 'ts', 'temp_c', 'hum_air', 'soil_raw', 'soil_pct', 'light_lux', 'pump_on', 'rssi')}`
        }
        for (const e of h.irrigations) {
          await sql`
            insert into iot.irrigation_events (node_id, greenhouse_id, started_at, ended_at, duration_s, trigger, end_reason, soil_raw_start, soil_raw_end, water_l)
            values (${n.id}, ${gid}, ${new Date(e.startedAt)}, ${new Date(e.endedAt)}, ${e.durationS}, ${e.trigger}, ${e.endReason},
                    ${e.soilRawStart}, ${e.soilRawEnd}, ${Math.round((e.durationS / 3600) * (n.flow ?? 100) * 1000) / 1000})`
        }
        const last = h.readings[h.readings.length - 1]!
        await sql`
          update iot.node_state set ts = ${new Date(last.ts)}, fw_version = 'historial-demo', temp_c = ${last.tempC}, hum_air = ${last.humAir},
                 soil_raw = ${last.soilRaw}, soil_pct = ${soilPct(last.soilRaw)}, light_lux = ${last.lightLux}, pump_on = false,
                 pump_state = 'idle', rssi = ${last.rssi}, faults = '{}'
           where node_id = ${n.id}`
      }
      summary.push(`✓ historial demo: ${historyHours} h para ${nodes.length} nodos sin lecturas`)
    } else {
      summary.push('= sin datos simulados (para historial de demostración: npm run db:seed -- --history 48)')
    }

    await audit(sql, { actorLabel: 'sistema', action: 'system.seed', detail: { historyHours, nodesCreated: created } })
  } finally {
    await sql.end({ timeout: 5 })
  }
  console.log(summary.join('\n'))
  if (fs.existsSync(credentialsFile)) console.log(`\nCuentas demo: ${path.relative(process.cwd(), credentialsFile)}\nTokens de nodos: ${path.relative(process.cwd(), devicesFile)}`)
}

/** Viento del mástil: brisa base + ráfagas ocasionales. */
async function seedMast(sql: ReturnType<typeof adminDb>, nodeId: number, now: number, hours: number): Promise<void> {
  const rng = mulberry32(7)
  const rows: { node_id: number; ts: Date; wind_ms: number; rssi: number }[] = []
  for (let t = now - hours * 3600_000; t <= now; t += 60_000) {
    const h = ((t / 3600_000) % 24 + 24) % 24
    const base = 3.2 + 2.2 * Math.max(0, Math.sin(((h - 10) / 24) * 2 * Math.PI))
    const gust = rng() < 0.01 ? 4 + rng() * 5 : 0
    rows.push({ node_id: nodeId, ts: new Date(t), wind_ms: Math.max(0, Math.round((base + gust + gaussian(rng) * 0.6) * 10) / 10), rssi: -60 })
  }
  for (let i = 0; i < rows.length; i += 1000) {
    await sql`insert into iot.readings ${sql(rows.slice(i, i + 1000), 'node_id', 'ts', 'wind_ms', 'rssi')}`
  }
  const last = rows[rows.length - 1]!
  await sql`update iot.node_state set ts = ${last.ts}, fw_version = 'historial-demo', wind_ms = ${last.wind_ms}, rssi = -60 where node_id = ${nodeId}`
}

main().catch((e: Error) => {
  console.error(`✗ ${e.message}`)
  process.exit(1)
})
