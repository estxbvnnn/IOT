import type { Db } from '../db/types'
import { inTransaction } from '../db/types'
import { hashToken } from '../auth/tokens'
import { soilPct } from '../domain/soil'
import { FRAME_MAX_BYTES, type Frame, type PumpEvent, frameSchema, sanitizeFrame } from '../ingest/schema'
import {
  type AlertThresholds, type EvalOutput, type RecentReading,
  evaluateGreenhouse, evaluatePumpAnomaly, evaluateWind,
} from '../alerts/engine'
import { applyAlerts, sweepOfflineNodes } from './alerts'
import { audit } from './audit'
import { deliveryWindowS } from './commands'
import { isScheduleDue, localParts } from './schedules'

/**
 * Recepción de tramas de los nodos (POST /api/ingest) — protocolo v1, ver docs/contrato-api.md.
 *
 * Seguridad (informe, tablas 10 y 11):
 *  - La identidad del nodo sale de su token, nunca del cuerpo: un nodo no puede escribir en otro.
 *  - Contador `seq` por arranque (`boot`) → una trama repetida se descarta sin reprocesar (anti-repetición).
 *  - Validación estructural (zod) y saneamiento de rangos físicos antes de guardar.
 *  - Separación mínima de 1 s entre tramas por nodo.
 *
 * Rendimiento: cada ida y vuelta a Supabase cuesta ~200 ms desde Chile, así que el trabajo se agrupa
 * en pocas «rondas» de sentencias encadenadas (pipeline) dentro de una sola transacción.
 */

export const MIN_FRAME_SPACING_MS = 1000
const MAST_INTERVAL_S = 60

export interface IngestInput {
  authorization: string | null
  rawBody: string
  ip: string | null
  now?: Date
  /** Solo pruebas: evita el barrido asíncrono de nodos caídos (no determinista). */
  skipSweep?: boolean
}

export interface IngestOrder { id: string; tipo: 'riego' | 'parar'; dur_s?: number; vence_s: number }
export interface IngestCfg {
  ver: number
  intervalo_s: number
  suelo_on?: number
  suelo_off?: number
  suelo_sat?: number
  temp_max?: number
  riego_max_s?: number
  espera_s?: number
}

export type IngestResult =
  | { status: 200; body: { ok: true; t: string; dup?: true; cfg: IngestCfg; ordenes: IngestOrder[] } }
  | { status: 400; body: { ok: false; error: 'invalid'; detalle: string[] } }
  | { status: 401; body: { ok: false; error: 'unauthorized' } }
  | { status: 413; body: { ok: false; error: 'too_large' } }
  | { status: 429; body: { ok: false; error: 'rate_limited' }; retryAfterS: number }

interface NodeRow {
  id: number
  kind: 'greenhouse' | 'mast'
  greenhouse_id: number | null
  label: string
  enabled: boolean
  cal_dry: number
  cal_wet: number
  code: string | null
  flow_lph: number | null
  /** Baja lógica del invernadero: sus nodos no reportan (defensa en profundidad además de `enabled`). */
  archived_at: Date | null
  soil_on: number | null
  soil_off: number | null
  soil_sat: number | null
  temp_max: number | null
  temp_heat: number | null
  temp_cold: number | null
  temp_frost: number | null
  hum_air_min: number | null
  hum_air_max: number | null
  pump_max_s: number | null
  pump_wait_s: number | null
  interval_s: number | null
  version: number | null
}

export function parseBearer(header: string | null): string | null {
  if (!header) return null
  const m = /^Bearer\s+([A-Za-z0-9_-]{20,128})$/.exec(header.trim())
  return m ? m[1]! : null
}

/** Registro de fallos de autenticación: un máximo por minuto y por origen, para no inundar la bitácora. */
const authFailLog = new Map<string, number>()
async function noteAuthFailure(db: Db, ip: string | null, reason: string, now: Date): Promise<void> {
  const key = ip ?? 'desconocida'
  const last = authFailLog.get(key) ?? 0
  if (now.getTime() - last < 60_000) return
  authFailLog.set(key, now.getTime())
  if (authFailLog.size > 2000) authFailLog.clear()
  try {
    await audit(db, { actorLabel: 'dispositivo:desconocido', action: 'device.auth_failed', detail: { reason }, ip })
  } catch {
    /* la bitácora nunca debe impedir responder 401 */
  }
}

const num = (v: number | null | undefined): number | null => (v === undefined ? null : v)

export function buildCfg(n: Pick<NodeRow, 'kind' | 'soil_on' | 'soil_off' | 'soil_sat' | 'temp_max' | 'pump_max_s' | 'pump_wait_s' | 'interval_s' | 'version'>): IngestCfg {
  if (n.kind === 'mast' || n.soil_on === null) return { ver: 1, intervalo_s: MAST_INTERVAL_S }
  return {
    ver: n.version ?? 1,
    intervalo_s: n.interval_s!,
    suelo_on: n.soil_on,
    suelo_off: n.soil_off!,
    suelo_sat: n.soil_sat!,
    temp_max: n.temp_max!,
    riego_max_s: n.pump_max_s!,
    espera_s: n.pump_wait_s!,
  }
}

interface ActiveCommand {
  id: string
  type: 'irrigate' | 'stop'
  duration_s: number | null
  source: 'manual' | 'schedule'
  status: 'awaiting_confirmation' | 'queued' | 'delivered'
  expires_at: Date | null
}

export async function handleIngest(db: Db, input: IngestInput): Promise<IngestResult> {
  const now = input.now ?? new Date()

  // 1) Autenticación por token del nodo.
  const token = parseBearer(input.authorization)
  if (!token) return { status: 401, body: { ok: false, error: 'unauthorized' } }
  if (Buffer.byteLength(input.rawBody, 'utf8') > FRAME_MAX_BYTES) return { status: 413, body: { ok: false, error: 'too_large' } }

  const [node] = await db<NodeRow[]>`
    select n.id, n.kind, n.greenhouse_id, n.label, n.enabled, n.cal_dry, n.cal_wet, g.code, g.flow_lph, g.archived_at,
           t.soil_on, t.soil_off, t.soil_sat, t.temp_max, t.temp_heat, t.temp_cold, t.temp_frost,
           t.hum_air_min, t.hum_air_max, t.pump_max_s, t.pump_wait_s, t.interval_s, t.version
      from iot.nodes n
      left join iot.greenhouses g on g.id = n.greenhouse_id
      left join iot.thresholds t on t.greenhouse_id = n.greenhouse_id
     where n.token_hash = ${hashToken(token)}`
  if (!node || !node.enabled || node.archived_at) {
    await noteAuthFailure(db, input.ip, !node ? 'unknown_token' : node.archived_at ? 'archived' : 'disabled', now)
    return { status: 401, body: { ok: false, error: 'unauthorized' } }
  }

  // 2) Estructura de la trama.
  let json: unknown
  try {
    json = JSON.parse(input.rawBody)
  } catch {
    return { status: 400, body: { ok: false, error: 'invalid', detalle: ['JSON inválido'] } }
  }
  const parsed = frameSchema.safeParse(json)
  if (!parsed.success) {
    const detalle = parsed.error.issues.slice(0, 6).map((i) => `${i.path.join('.') || 'cuerpo'}: ${i.message}`)
    return { status: 400, body: { ok: false, error: 'invalid', detalle } }
  }
  const frame = parsed.data

  // 3) Todo lo demás, atómico.
  const result = await inTransaction(db, (tx) => processFrame(tx, node, frame, now, input.ip))

  // Barrido de nodos caídos (con límite de frecuencia); nunca debe romper la recepción.
  if (result.status === 200 && !result.body.dup && !input.skipSweep) {
    sweepOfflineNodes(db, now).catch(() => {})
  }
  return result
}

async function processFrame(tx: Db, node: NodeRow, frame: Frame, now: Date, ip: string | null): Promise<IngestResult> {
  const nodeId = node.id
  const ghId = node.greenhouse_id
  const isGreenhouse = node.kind === 'greenhouse' && ghId !== null && node.soil_on !== null
  const cfg = buildCfg(node)

  // --- Ronda 1: bloquear la fila de estado del nodo (serializa tramas simultáneas del mismo nodo).
  const [, stRows] = await Promise.all([
    tx`insert into iot.node_state (node_id) values (${nodeId}) on conflict do nothing`,
    tx<{ ts: Date | null; boot_id: number | null; last_seq: number | null }[]>`
      select ts, boot_id, last_seq from iot.node_state where node_id = ${nodeId} for update`,
  ])
  const st = stRows[0]
  const since = new Date(now.getTime() - 3 * 3600_000)

  // Separación mínima entre tramas (el nodo conserva sus eventos y reintenta). Solo aplica a diferencias
  // entre 0 y 1 s: si el reloj del servidor retrocedió (diferencia negativa) NO se bloquea al nodo.
  const isDup = st?.boot_id === frame.boot && st.last_seq !== null && frame.seq <= st.last_seq
  const sinceLastMs = st?.ts ? now.getTime() - st.ts.getTime() : Infinity
  if (!isDup && sinceLastMs >= 0 && sinceLastMs < MIN_FRAME_SPACING_MS) {
    return { status: 429, body: { ok: false, error: 'rate_limited' }, retryAfterS: 1 }
  }

  // --- Trama repetida: no se reprocesa, pero se entregan las órdenes vigentes (respuesta perdida).
  if (isDup) {
    const active = await selectActiveCommands(tx, nodeId)
    return okResponse(now, cfg, deliverable(active, now), true)
  }

  const s = sanitizeFrame(frame)
  const soilPercent = s.soilRaw === null ? null : soilPct(s.soilRaw, node.cal_dry, node.cal_wet)
  const events = [...(frame.ev ?? [])].sort((a, b) => b.ago - a.ago) // más antiguo primero
  const autoOn = events.find((e) => e.t === 'pump_on' && e.why === 'auto')

  // --- Ronda 2: lecturas y estado previo (sentencias independientes → pipeline).
  const acks = frame.acks ?? []
  const [, openRows, recentRows, expiredRows, ackRows, activeRows, scheduleRows, prevAuto, siteRows] = await Promise.all([
    tx`
      insert into iot.readings (node_id, greenhouse_id, ts, temp_c, hum_air, soil_raw, soil_pct, light_lux, wind_ms, pump_on, rssi, snr, seq, faults)
      values (${nodeId}, ${ghId}, ${now}, ${s.tempC}, ${s.humAir}, ${s.soilRaw}, ${soilPercent}, ${s.lightLux}, ${s.windMs},
              ${frame.bomba === 1}, ${num(frame.rssi)}, ${frame.snr ?? null}, ${frame.seq}, ${tx.array(s.faults)}::text[])`,
    tx<{ trigger: string }[]>`select trigger from iot.irrigation_events where node_id = ${nodeId} and ended_at is null`,
    isGreenhouse
      ? tx<{ ts: Date; soil_raw: number | null; hum_air: number | null }[]>`
          select ts, soil_raw, hum_air from iot.readings
           where node_id = ${nodeId} and ts > ${since} order by ts desc limit 200`
      : Promise.resolve([] as { ts: Date; soil_raw: number | null; hum_air: number | null }[]),
    tx<{ id: string; greenhouse_id: number }[]>`
      update iot.commands set status = 'expired'
       where node_id = ${nodeId} and status in ('queued', 'delivered') and expires_at < ${now}
      returning id, greenhouse_id`,
    Promise.all(acks.map((a) => tx<{ id: string; greenhouse_id: number; status: string }[]>`
      update iot.commands
         set status = ${a.estado === 'ejecutada' ? 'executed' : 'rejected'}, acked_at = ${now}, result_detail = ${(a.detalle ?? '').slice(0, 200) || null}
       where id = ${a.id} and node_id = ${nodeId} and status in ('queued', 'delivered')
      returning id, greenhouse_id, status`)),
    selectActiveCommands(tx, nodeId),
    isGreenhouse
      ? tx<{ id: string; days: number[]; time_local: string; duration_s: number; last_run_date: string | null; created_by: string | null }[]>`
          select id, days, time_local::text as time_local, duration_s, last_run_date::text as last_run_date, created_by
            from iot.schedules where greenhouse_id = ${ghId} and enabled`
      : Promise.resolve([]),
    isGreenhouse && autoOn
      ? tx<{ started_at: Date; ended_at: Date }[]>`
          select started_at, ended_at from iot.irrigation_events
           where greenhouse_id = ${ghId} and trigger = 'auto' and ended_at is not null
           order by started_at desc limit 2`
      : Promise.resolve([] as { started_at: Date; ended_at: Date }[]),
    node.kind === 'mast'
      ? tx<{ wind_warn_ms: number; wind_crit_ms: number }[]>`select wind_warn_ms, wind_crit_ms from iot.site_settings where id = 1`
      : Promise.resolve([] as { wind_warn_ms: number; wind_crit_ms: number }[]),
  ])

  // --- Decisiones en memoria -------------------------------------------------------------------
  const writes: Promise<unknown>[] = []

  // Eventos de la bomba (idempotentes: el índice único garantiza un solo riego abierto por nodo).
  let currentTrigger: string | null = openRows[0]?.trigger ?? null
  if (ghId !== null) {
    for (const ev of events) {
      const ts = new Date(now.getTime() - ev.ago * 1000)
      if (ev.t === 'pump_on') {
        currentTrigger = ev.why
        writes.push(openIrrigation(tx, nodeId, ghId, ts, ev, s.soilRaw))
      } else {
        currentTrigger = null
        writes.push(closeIrrigation(tx, nodeId, node.flow_lph ?? 100, ts, ev.why, ev.dur ?? null, s.soilRaw))
      }
    }
    // Auto-reparación: si se perdió un evento, el estado reportado manda.
    if (frame.bomba === 1) {
      const started = new Date(now.getTime() - (frame.riego_s ?? 0) * 1000)
      writes.push(openIrrigation(tx, nodeId, ghId, started, { t: 'pump_on', why: 'auto', ago: 0 }, s.soilRaw))
    } else {
      writes.push(closeIrrigation(tx, nodeId, node.flow_lph ?? 100, now, 'desconocido', null, s.soilRaw))
    }
  }

  // Alertas.
  let alerts: EvalOutput = { raise: [], clear: [] }
  if (isGreenhouse) {
    const th: AlertThresholds = {
      soilOn: node.soil_on!, soilSat: node.soil_sat!, tempMax: node.temp_max!, tempHeat: node.temp_heat!,
      soilOff: node.soil_off!, tempCold: node.temp_cold!, tempFrost: node.temp_frost!, humAirMin: node.hum_air_min!, humAirMax: node.hum_air_max!,
      intervalS: node.interval_s!,
    }
    const recent: RecentReading[] = recentRows.map((r) => ({ ts: r.ts.getTime(), soilRaw: r.soil_raw, humAir: r.hum_air }))
    alerts = evaluateGreenhouse({
      code: node.code!, thresholds: th, now: now.getTime(), tempC: s.tempC, humAir: s.humAir, soilRaw: s.soilRaw,
      faults: s.faults, recent,
    })
    if (autoOn && prevAuto.length >= 2) {
      // Separación entre riegos automáticos consecutivos: el nuevo vs. el último, y el último vs. el anterior.
      const newStart = now.getTime() - autoOn.ago * 1000
      const gapsS = [
        (newStart - prevAuto[0]!.ended_at.getTime()) / 1000,
        (prevAuto[0]!.started_at.getTime() - prevAuto[1]!.ended_at.getTime()) / 1000,
      ]
      const anomaly = evaluatePumpAnomaly({ code: node.code!, gapsS, waitS: node.pump_wait_s! })
      alerts.raise.push(...anomaly.raise)
    }
  } else if (node.kind === 'mast') {
    const site = siteRows[0]
    alerts = evaluateWind({ windMs: s.windMs, warn: site?.wind_warn_ms ?? 15, crit: site?.wind_crit_ms ?? 25 })
  }
  alerts.clear.push('node_offline') // llegó una trama: el nodo está en línea
  writes.push(applyAlerts(tx, { greenhouseId: ghId, nodeId, now }, alerts))

  // Órdenes: entrega, y calendario que toca ejecutar.
  const toDeliver = deliverable(activeRows, now)
  const freshlyDelivered = toDeliver.filter((c) => c.status === 'queued')
  if (freshlyDelivered.length > 0) {
    writes.push(tx`
      update iot.commands set status = 'delivered', delivered_at = ${now}
       where id = any(${tx.array(freshlyDelivered.map((c) => c.id))}::uuid[]) and status = 'queued'`)
  }
  let scheduleFired: { id: string; greenhouseId: number } | null = null
  if (isGreenhouse && activeRows.length === 0) {
    const local = localParts(now)
    const due = scheduleRows.find((sc) => isScheduleDue({ enabled: true, days: sc.days.map(Number), timeLocal: sc.time_local, lastRunDate: sc.last_run_date }, now))
    if (due) {
      const dur = Math.min(due.duration_s, node.pump_max_s!)
      const expires = new Date(now.getTime() + deliveryWindowS(node.interval_s!) * 1000)
      writes.push(tx`
        insert into iot.commands (greenhouse_id, node_id, type, duration_s, source, status, requested_by, confirmed_by, created_at, confirmed_at, expires_at)
        values (${ghId}, ${nodeId}, 'irrigate', ${dur}, 'schedule', 'queued', ${due.created_by}, ${due.created_by}, ${now}, ${now}, ${expires})`)
      writes.push(tx`update iot.schedules set last_run_date = ${local.date}::date where id = ${due.id}`)
      scheduleFired = { id: due.id, greenhouseId: ghId! }
    }
  }

  // Estado actual del nodo.
  writes.push(tx`
    update iot.node_state set
      ts = ${now}, fw_version = ${frame.fw}, boot_id = ${frame.boot}, last_seq = ${frame.seq}, uptime_s = ${frame.up},
      temp_c = ${s.tempC}, hum_air = ${s.humAir}, soil_raw = ${s.soilRaw}, soil_pct = ${soilPercent},
      light_lux = ${s.lightLux}, wind_ms = ${s.windMs}, pump_on = ${frame.bomba === 1},
      pump_state = ${frame.est ?? null}, pump_run_s = ${frame.riego_s ?? null}, cooldown_s = ${frame.esp ?? null},
      rssi = ${num(frame.rssi)}, snr = ${frame.snr ?? null}, faults = ${tx.array(s.faults)}::text[], cfg_version = ${cfg.ver}
     where node_id = ${nodeId}`)

  // Bitácora AL FINAL de la ronda: el bloqueo de la cadena de hashes se toma siempre en último lugar,
  // en el mismo orden que el resto del sistema, para que no haya bloqueos cruzados (deadlocks).
  const label = `nodo:${node.code ?? node.label}`
  const auditWrites: Promise<unknown>[] = []
  if (st?.ts === null || st?.ts === undefined) {
    auditWrites.push(audit(tx, { actorLabel: label, action: 'device.first_seen', target: `node:${nodeId}`, detail: { fw: frame.fw }, ip }))
  }
  for (const c of expiredRows) {
    auditWrites.push(audit(tx, { actorLabel: 'sistema', action: 'command.expired', target: `greenhouse:${c.greenhouse_id}`, detail: { commandId: c.id } }))
  }
  for (const list of ackRows) {
    for (const c of list) {
      const ack = acks.find((a) => a.id === c.id)
      auditWrites.push(audit(tx, {
        actorLabel: label, action: 'command.ack', target: `greenhouse:${c.greenhouse_id}`,
        detail: { commandId: c.id, result: c.status, detalle: ack?.detalle ?? null },
      }))
    }
  }
  for (const c of freshlyDelivered) {
    auditWrites.push(audit(tx, { actorLabel: label, action: 'command.delivered', target: `greenhouse:${ghId}`, detail: { commandId: c.id } }))
  }
  if (scheduleFired) {
    auditWrites.push(audit(tx, {
      actorLabel: 'sistema', action: 'schedule.trigger', target: `greenhouse:${scheduleFired.greenhouseId}`,
      detail: { scheduleId: scheduleFired.id },
    }))
  }

  await Promise.all(writes)
  await Promise.all(auditWrites)
  return okResponse(now, cfg, toDeliver, false)
}

function selectActiveCommands(tx: Db, nodeId: number) {
  return tx<ActiveCommand[]>`
    select id, type, duration_s, source, status, expires_at from iot.commands
     where node_id = ${nodeId} and status in ('awaiting_confirmation', 'queued', 'delivered')
     order by (type = 'stop') desc, created_at`
}

/** Órdenes que el nodo debe recibir: confirmadas y vigentes (las ya entregadas se reenvían hasta el acuse). */
function deliverable(active: readonly ActiveCommand[], now: Date): ActiveCommand[] {
  return active.filter((c) => (c.status === 'queued' || c.status === 'delivered') && c.expires_at !== null && c.expires_at > now)
}

function okResponse(now: Date, cfg: IngestCfg, orders: readonly ActiveCommand[], dup: boolean): IngestResult {
  return {
    status: 200,
    body: {
      ok: true,
      t: now.toISOString(),
      ...(dup ? { dup: true as const } : {}),
      cfg,
      ordenes: orders.map((c) => ({
        id: c.id,
        tipo: c.type === 'stop' ? ('parar' as const) : ('riego' as const),
        ...(c.type === 'irrigate' ? { dur_s: c.duration_s! } : {}),
        vence_s: Math.max(1, Math.ceil((c.expires_at!.getTime() - now.getTime()) / 1000)),
      })),
    },
  }
}

type OnEvent = Extract<PumpEvent, { t: 'pump_on' }>

function openIrrigation(tx: Db, nodeId: number, ghId: number, ts: Date, ev: OnEvent, soilRaw: number | null) {
  const cmd = ev.cmd ?? null
  return tx`
    insert into iot.irrigation_events (node_id, greenhouse_id, started_at, trigger, command_id, soil_raw_start)
    values (
      ${nodeId}, ${ghId}, ${ts},
      case when ${cmd}::uuid is not null and exists (select 1 from iot.commands c where c.id = ${cmd}::uuid and c.node_id = ${nodeId} and c.source = 'schedule')
           then 'schedule' else ${ev.why} end,
      (select c.id from iot.commands c where c.id = ${cmd}::uuid and c.node_id = ${nodeId}),
      ${soilRaw})
    on conflict (node_id) where ended_at is null do nothing`
}

function closeIrrigation(tx: Db, nodeId: number, flowLph: number, ts: Date, why: string, dur: number | null, soilRaw: number | null) {
  return tx`
    update iot.irrigation_events e set
      ended_at     = greatest(${ts}::timestamptz, e.started_at),
      duration_s   = coalesce(${dur}::int, greatest(0, round(extract(epoch from (${ts}::timestamptz - e.started_at)))::int)),
      end_reason   = ${why},
      soil_raw_end = ${soilRaw},
      water_l      = round((coalesce(${dur}::int, greatest(0, round(extract(epoch from (${ts}::timestamptz - e.started_at)))::int))::numeric / 3600 * ${flowLph}::numeric), 3)
     where e.node_id = ${nodeId} and e.ended_at is null`
}
