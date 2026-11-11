import { type Frame, ackSchema, frameSchema, pumpEventSchema, PUMP_STATES } from './schema'

/**
 * Adaptación de JSON ajenos al protocolo del dashboard. `parseFrame` es el único punto de entrada para validar una trama:
 *  1. renombra campos con nombres alternativos (temperature → temp, soil → suelo_raw…),
 *  2. convierte booleanos de bomba (true/false → 1/0),
 *  3. descarta, sin rechazar la trama, los elementos inválidos de listas (ev, acks, fallas) y los campos opcionales mal formados
 *     (est desconocido, rssi fuera de rango…),
 *  4. aparta los campos que no conoce en `extra` (se guardan tal cual en la base),
 *  5. valida el resto con `frameSchema` (que solo exige `seq`).
 * Los valores de sensores con tipo equivocado (temp: "24") siguen siendo un error 400: mejor avisar que adivinar.
 */

/** nombre canónico → nombres alternativos aceptados (en este orden de prioridad) */
export const ALIASES: Readonly<Record<string, readonly string[]>> = {
  seq: ['sequence', 'secuencia', 'contador', 'counter'],
  boot: ['boot_id', 'arranque'],
  up: ['uptime', 'uptime_s', 'tiempo_activo'],
  fw: ['firmware', 'fw_version', 'version'],
  temp: ['temperature', 'temperatura', 'temp_c', 'tempc'],
  hum_aire: ['humidity', 'humedad_aire', 'hum_air', 'humedad_relativa', 'hum', 'humedad'],
  suelo_raw: ['suelo', 'soil', 'soil_raw', 'soil_moisture', 'humedad_suelo'],
  luz: ['lux', 'light', 'luminosidad'],
  viento: ['wind', 'wind_ms', 'viento_ms'],
  flujo_lmin: ['flujo', 'flujo_agua', 'caudal', 'caudal_lmin', 'flow', 'flow_lmin', 'flow_rate', 'water_flow'],
  bomba: ['pump','pump_on', 'bomba_on', 'relay', 'rele'],
  rssi: ['wifi_rssi', 'signal'],
  fallas: ['faults', 'errores'],
}

const KNOWN = new Set<string>([
  'v', 'fw', 'boot', 'seq', 'up', 'temp', 'hum_aire', 'suelo_raw', 'luz', 'viento', 'flujo_lmin', 'bomba', 'riego_s', 'est', 'esp', 'rssi', 'snr',
  'fallas', 'ev', 'acks',
])

const EXTRA_MAX_KEYS = 20
const EXTRA_MAX_CHARS = 2000

export type ParsedFrame =
  | { ok: true; frame: Frame; extra: Record<string, unknown> | null }
  | { ok: false; detalle: string[] }

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

export function parseFrame(input: unknown): ParsedFrame {
  if (!isObj(input)) return { ok: false, detalle: ['cuerpo: se esperaba un objeto JSON'] }
  const data: Record<string, unknown> = { ...input }

  // 1) nombres alternativos
  const consumed = new Set<string>()
  for (const [canon, alts] of Object.entries(ALIASES)) {
    for (const alt of alts) {
      if (!(alt in data)) continue
      consumed.add(alt)
      if (!(canon in data)) data[canon] = data[alt]
      delete data[alt]
    }
  }

  // 2) bomba booleana
  if (typeof data.bomba === 'boolean') data.bomba = data.bomba ? 1 : 0

  // 3) campos opcionales mal formados → se ignoran
  if (typeof data.fw === 'number') data.fw = String(data.fw)
  if (typeof data.fw === 'string') {
    const fw = data.fw.trim().slice(0, 16)
    if (fw) data.fw = fw
    else delete data.fw
  }
  if ('est' in data && !(PUMP_STATES as readonly unknown[]).includes(data.est)) delete data.est
  if ('rssi' in data) {
    const r = typeof data.rssi === 'number' && Number.isFinite(data.rssi) ? Math.round(data.rssi) : NaN
    if (r >= -160 && r <= 0) data.rssi = r
    else delete data.rssi
  }
  for (const k of ['riego_s', 'esp'] as const) {
    if (!(k in data)) continue
    const n = typeof data[k] === 'number' && Number.isFinite(data[k]) ? Math.round(data[k] as number) : NaN
    if (n >= 0 && n <= 86_400) data[k] = n
    else delete data[k]
  }
  if ('snr' in data && !(data.snr === null || (typeof data.snr === 'number' && data.snr >= -40 && data.snr <= 40))) delete data.snr
  if ('fallas' in data) {
    if (Array.isArray(data.fallas)) data.fallas = data.fallas.filter((x) => typeof x === 'string' && x.length >= 1 && x.length <= 24).slice(0, 8)
    else delete data.fallas
  }
  if ('ev' in data) {
    if (Array.isArray(data.ev)) data.ev = data.ev.filter((x) => pumpEventSchema.safeParse(x).success).slice(0, 8)
    else delete data.ev
  }
  if ('acks' in data) {
    if (Array.isArray(data.acks)) data.acks = data.acks.filter((x) => ackSchema.safeParse(x).success).slice(0, 8)
    else delete data.acks
  }

  // 4) desconocidos → extra (acotado)
  const extra: Record<string, unknown> = {}
  let chars = 2
  for (const [k, v] of Object.entries(data)) {
    if (KNOWN.has(k) || consumed.has(k)) continue
    if (Object.keys(extra).length >= EXTRA_MAX_KEYS) break
    let size: number
    try { size = JSON.stringify({ [k]: v }).length } catch { continue }
    if (chars + size > EXTRA_MAX_CHARS) continue
    chars += size
    extra[k] = v
  }

  // 5) validación de lo conocido
  const parsed = frameSchema.safeParse(data)
  if (!parsed.success) {
    const detalle = parsed.error.issues.slice(0, 6).map((i) => `${i.path.join('.') || 'cuerpo'}: ${i.message}`)
    return { ok: false, detalle }
  }
  return { ok: true, frame: parsed.data, extra: Object.keys(extra).length > 0 ? extra : null }
}
