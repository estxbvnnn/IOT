/**
 * Núcleo del envío Raspberry Pi → nube (AWS), el último tramo del diagrama del proyecto:
 *
 *   PostgreSQL local (Pi) ──cada UPLINK_INTERVAL_S (5 s)──HTTPS POST──► API de AWS (S3 / RDS)
 *
 * Cada ciclo toma las lecturas nuevas (iot.readings con id mayor al del cursor iot.uplink_state), arma un lote JSON y lo manda.
 * El lote viaja CIFRADO con la clave pública de AWS (RSA-2048 + AES-256-GCM, el mismo formato «rsa1:» del resto del proyecto):
 * solo quien tenga la clave privada de AWS puede abrirlo. El cursor avanza SOLO si AWS responde 2xx, así que un corte de internet
 * no pierde datos: el siguiente ciclo reintenta el mismo lote (el id de cada lectura permite descartar repetidos en el destino).
 * La Pi no depende de la nube: si el envío falla, todo lo demás sigue funcionando.
 */
import type { KeyObject } from 'node:crypto'
import type { Db } from '../../src/lib/db/types'
import { cifrarRsa } from './mqtt-crypto'

/** Tema (dato autenticado) con el que se sella cada lote; el destino debe usar el mismo para abrirlo. */
export const UPLINK_AAD = 'invernadero/uplink/pi'
const CURSOR = 'readings'

export interface UplinkConfig {
  url: string
  /** Si existe, se manda en la cabecera `x-api-key` (API Gateway de AWS). */
  apiKey?: string
  /** Clave pública RSA de AWS. Sin ella el lote va en claro (solo para pruebas). */
  publicKey: KeyObject | null
  batch: number
  /** Nombre de esta Pi en el lote (para distinguir varias). */
  origen: string
  timeoutMs?: number
}

export interface UplinkReading {
  id: number
  ts: string
  invernadero: string | null
  nodo: string
  temp_c: number | null
  hum_aire: number | null
  suelo_raw: number | null
  suelo_pct: number | null
  flujo_lmin: number | null
  bomba: boolean | null
  rssi: number | null
  seq: number | null
  boot: number | null
  transporte: string | null
  via: string | null
  saltos: number | null
}

export interface UplinkReport {
  ok: boolean
  sent: number
  lastId: number
  error?: string
  ms: number
}

interface Row {
  id: string | number
  ts: Date
  gh: string | null
  node: string
  temp_c: number | null
  hum_air: number | null
  soil_raw: number | null
  soil_pct: number | null
  flow_lmin: number | null
  pump_on: boolean | null
  rssi: number | null
  seq: string | number | null
  boot: string | number | null
  transport: string | null
  via: string | null
  hops: number | null
}

const n = (v: string | number | null): number | null => (v === null || v === undefined ? null : Number(v))

export function toReading(r: Row): UplinkReading {
  return {
    id: Number(r.id), ts: r.ts.toISOString(), invernadero: r.gh, nodo: r.node,
    temp_c: r.temp_c, hum_aire: r.hum_air, suelo_raw: r.soil_raw, suelo_pct: r.soil_pct, flujo_lmin: r.flow_lmin,
    bomba: r.pump_on, rssi: r.rssi, seq: n(r.seq), boot: n(r.boot), transporte: r.transport, via: r.via, saltos: r.hops,
  }
}

/** Arma el cuerpo del POST: JSON en claro, o «rsa1:…» si hay clave pública de AWS. */
export function armarCuerpo(lecturas: UplinkReading[], cfg: Pick<UplinkConfig, 'origen' | 'publicKey'>, now: Date): { body: string; contentType: string } {
  const json = JSON.stringify({ v: 1, origen: cfg.origen, enviado: now.toISOString(), lecturas })
  if (!cfg.publicKey) return { body: json, contentType: 'application/json' }
  return { body: cifrarRsa(json, UPLINK_AAD, cfg.publicKey).payload, contentType: 'text/plain' }
}

async function readCursor(db: Db): Promise<number> {
  const [r] = await db<{ last_id: string }[]>`select last_id::text from iot.uplink_state where name = ${CURSOR}`
  return r ? Number(r.last_id) : 0
}

async function saveCursor(db: Db, lastId: number, error: string | null): Promise<void> {
  await db`
    insert into iot.uplink_state (name, last_id, last_ok_at, last_error)
    values (${CURSOR}, ${lastId}, ${error === null ? new Date() : null}, ${error})
    on conflict (name) do update set
      last_id = excluded.last_id,
      last_ok_at = coalesce(excluded.last_ok_at, iot.uplink_state.last_ok_at),
      last_error = excluded.last_error`
}

/** Un ciclo: envía el siguiente lote pendiente. Nunca lanza; el resultado dice si salió bien. */
export async function uplinkOnce(
  db: Db, cfg: UplinkConfig, deps: { fetch?: typeof fetch; now?: () => Date } = {},
): Promise<UplinkReport> {
  const t0 = Date.now()
  const doFetch = deps.fetch ?? fetch
  const now = (deps.now ?? (() => new Date()))()
  let lastId = 0
  try {
    lastId = await readCursor(db)
    const rows = await db<Row[]>`
      select r.id, r.ts, g.code as gh, nd.label as node,
             r.temp_c, r.hum_air, r.soil_raw, r.soil_pct, r.flow_lmin, r.pump_on, r.rssi, r.seq, r.boot, r.transport, r.via, r.hops
        from iot.readings r
        join iot.nodes nd on nd.id = r.node_id
        left join iot.greenhouses g on g.id = r.greenhouse_id
       where r.id > ${lastId}
       order by r.id
       limit ${cfg.batch}`
    if (rows.length === 0) return { ok: true, sent: 0, lastId, ms: Date.now() - t0 }

    const lecturas = rows.map(toReading)
    const { body, contentType } = armarCuerpo(lecturas, cfg, now)
    const headers: Record<string, string> = { 'content-type': contentType }
    if (cfg.apiKey) headers['x-api-key'] = cfg.apiKey
    const res = await doFetch(cfg.url, { method: 'POST', headers, body, signal: AbortSignal.timeout(cfg.timeoutMs ?? 8000) })
    if (!res.ok) throw new Error(`la nube respondió HTTP ${res.status}`)
    const newLast = lecturas[lecturas.length - 1]!.id
    await saveCursor(db, newLast, null)
    return { ok: true, sent: lecturas.length, lastId: newLast, ms: Date.now() - t0 }
  } catch (e) {
    const error = (e as Error).message
    await saveCursor(db, lastId, error).catch(() => undefined)
    return { ok: false, sent: 0, lastId, error, ms: Date.now() - t0 }
  }
}
