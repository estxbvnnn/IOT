import type { Db } from '../db/types'
import { type Actor, assertCan, scopeOf } from '../rbac'
import type { AlertDTO, AlertStatus, AlertType, Severity } from '../domain/types'
import { type AlertDraft, type EvalOutput, offlineAfterS } from '../alerts/engine'
import { audit, jsonParam } from './audit'

export interface AlertContext {
  /** null = alerta del predio (viento). */
  greenhouseId: number | null
  nodeId: number | null
  now: Date
}

/**
 * Aplica el resultado del motor de alertas:
 *  - levanta (o refresca) una alerta por tipo y sector — nunca duplica: hay un índice único parcial;
 *  - si la gravedad sube y estaba reconocida, la reabre para volver a llamar la atención;
 *  - despeja automáticamente las que ya no aplican.
 */
export async function applyAlerts(db: Db, ctx: AlertContext, out: EvalOutput): Promise<{ opened: AlertDraft[] }> {
  const opened: AlertDraft[] = []
  // Todas las sentencias se lanzan a la vez: postgres.js las envía en pipeline por la misma conexión
  // (cada ida y vuelta a Supabase cuesta ~200 ms, así que no se esperan una a una).
  const upserts = out.raise.map(async (d) => {
    const [r] = await db<{ inserted: boolean }[]>`
      insert into iot.alerts as a (greenhouse_id, node_id, type, severity, message, detail, opened_at, last_seen_at)
      values (${ctx.greenhouseId}, ${ctx.nodeId}, ${d.type}, ${d.severity}, ${d.message}, ${jsonParam(db, d.detail)}, ${ctx.now}, ${ctx.now})
      on conflict ((coalesce(greenhouse_id, 0)), type) where status <> 'resolved'
      do update set
        last_seen_at    = excluded.last_seen_at,
        occurrences     = a.occurrences + 1,
        message         = excluded.message,
        detail          = excluded.detail,
        node_id         = excluded.node_id,
        status          = case when a.status = 'acknowledged'
                                and (case excluded.severity when 'critical' then 3 when 'warning' then 2 else 1 end)
                                  > (case a.severity        when 'critical' then 3 when 'warning' then 2 else 1 end)
                               then 'open' else a.status end,
        acknowledged_at = case when a.status = 'acknowledged'
                                and (case excluded.severity when 'critical' then 3 when 'warning' then 2 else 1 end)
                                  > (case a.severity        when 'critical' then 3 when 'warning' then 2 else 1 end)
                               then null else a.acknowledged_at end,
        acknowledged_by = case when a.status = 'acknowledged'
                                and (case excluded.severity when 'critical' then 3 when 'warning' then 2 else 1 end)
                                  > (case a.severity        when 'critical' then 3 when 'warning' then 2 else 1 end)
                               then null else a.acknowledged_by end,
        severity        = excluded.severity
      returning (xmax = 0) as inserted`
    if (r?.inserted) opened.push(d)
  })
  const clears =
    out.clear.length > 0
      ? [db`
          update iot.alerts
             set status = 'resolved', resolved_at = ${ctx.now}, resolved_reason = 'auto'
           where coalesce(greenhouse_id, 0) = ${ctx.greenhouseId ?? 0}
             and type = any(${db.array(out.clear as string[])})
             and status <> 'resolved'`.then(() => undefined)]
      : []
  await Promise.all([...upserts, ...clears])
  return { opened }
}

interface AlertRow {
  id: number
  greenhouse_id: number | null
  code: string | null
  type: string
  severity: Severity
  status: AlertStatus
  message: string
  opened_at: Date
  last_seen_at: Date
  occurrences: number
  acknowledged_at: Date | null
  ack_name: string | null
  resolved_at: Date | null
  resolved_reason: 'auto' | 'manual' | null
}

export const toAlertDTO = (r: AlertRow): AlertDTO => ({
  id: r.id,
  greenhouseId: r.greenhouse_id,
  greenhouseCode: r.code,
  type: r.type,
  severity: r.severity,
  status: r.status,
  message: r.message,
  openedAt: r.opened_at.toISOString(),
  lastSeenAt: r.last_seen_at.toISOString(),
  occurrences: r.occurrences,
  acknowledgedAt: r.acknowledged_at?.toISOString() ?? null,
  acknowledgedBy: r.ack_name,
  resolvedAt: r.resolved_at?.toISOString() ?? null,
  resolvedReason: r.resolved_reason,
})

export interface AlertFilter {
  /** active = abiertas o reconocidas · resolved = históricas · all */
  state?: 'active' | 'resolved' | 'all'
  severity?: Severity
  greenhouseId?: number
  limit?: number
}

/**
 * Lista alertas respetando el alcance del usuario: un operador solo ve las de sus sectores
 * (las del predio, como el viento, son visibles para todos: no exponen datos de otros invernaderos).
 */
export async function listAlerts(db: Db, actor: Pick<Actor, 'role' | 'greenhouseIds'>, f: AlertFilter = {}): Promise<AlertDTO[]> {
  const scope = scopeOf(actor)
  const ids = scope.all ? null : [...scope.ids]
  const state = f.state ?? 'active'
  const rows = await db<AlertRow[]>`
    select a.id, a.greenhouse_id, g.code, a.type, a.severity, a.status, a.message, a.opened_at, a.last_seen_at,
           a.occurrences, a.acknowledged_at, u.name as ack_name, a.resolved_at, a.resolved_reason
      from iot.alerts a
      left join iot.greenhouses g on g.id = a.greenhouse_id
      left join iot.app_users u on u.id = a.acknowledged_by
     where (${state} = 'all' or (${state} = 'active' and a.status <> 'resolved') or (${state} = 'resolved' and a.status = 'resolved'))
       and (${f.severity ?? null}::text is null or a.severity = ${f.severity ?? null})
       and (${f.greenhouseId ?? null}::int is null or a.greenhouse_id = ${f.greenhouseId ?? null})
       and (${ids === null}::boolean or a.greenhouse_id is null or a.greenhouse_id = any(${db.array(ids ?? [])}::int[]))
     order by (a.status = 'resolved'),
              case a.severity when 'critical' then 0 when 'warning' then 1 else 2 end,
              a.last_seen_at desc
     limit ${Math.min(f.limit ?? 100, 500)}`
  return rows.map(toAlertDTO)
}

/** Alertas sin reconocer (abiertas) visibles para el usuario: alimenta la insignia del menú. */
export async function countOpenAlerts(db: Db, actor: Pick<Actor, 'role' | 'greenhouseIds'>): Promise<{ open: number; critical: number }> {
  const scope = scopeOf(actor)
  const ids = scope.all ? null : [...scope.ids]
  const [r] = await db<{ open: number; critical: number }[]>`
    select count(*)::int as open, (count(*) filter (where severity = 'critical'))::int as critical
      from iot.alerts
     where status = 'open'
       and (${ids === null}::boolean or greenhouse_id is null or greenhouse_id = any(${db.array(ids ?? [], 21)}::smallint[]))`
  return { open: r?.open ?? 0, critical: r?.critical ?? 0 }
}

/** Reconoce una alerta activa. Devuelve false si no existe, ya está resuelta o no está en el alcance del usuario. */
export async function acknowledgeAlert(db: Db, actor: Actor, alertId: number, now = new Date(), ip: string | null = null): Promise<boolean> {
  assertCan(actor, 'alerts:ack')
  const scope = scopeOf(actor)
  const ids = scope.all ? null : [...scope.ids]
  const rows = await db<{ id: number; greenhouse_id: number | null; type: string; severity: string }[]>`
    update iot.alerts
       set status = 'acknowledged', acknowledged_at = ${now}, acknowledged_by = ${actor.id}
     where id = ${alertId} and status = 'open'
       and (${ids === null}::boolean or (greenhouse_id is not null and greenhouse_id = any(${db.array(ids ?? [])}::int[])))
    returning id, greenhouse_id, type, severity`
  const row = rows[0]
  if (!row) return false
  await audit(db, {
    actorId: actor.id, actorLabel: actor.email, actorRole: actor.role, action: 'alert.ack',
    target: row.greenhouse_id ? `greenhouse:${row.greenhouse_id}` : 'site',
    detail: { alertId, type: row.type, severity: row.severity }, ip,
  })
  return true
}

let lastSweepAt = 0

/**
 * Detecta nodos que dejaron de reportar y levanta la alerta `node_offline`.
 * Se llama al cargar el panel y al recibir tramas (con un mínimo de 20 s entre barridos por proceso).
 * Cuando el nodo vuelve, la alerta se despeja sola al llegar su siguiente trama (ver ingest).
 */
export async function sweepOfflineNodes(db: Db, now = new Date(), force = false): Promise<number> {
  if (!force && now.getTime() - lastSweepAt < 20_000) return 0
  lastSweepAt = now.getTime()
  const nodes = await db<{
    node_id: number; kind: string; greenhouse_id: number | null; code: string | null; label: string; ts: Date; interval_s: number | null
  }[]>`
    select n.id as node_id, n.kind, n.greenhouse_id, g.code, n.label, s.ts, t.interval_s
      from iot.nodes n
      join iot.node_state s on s.node_id = n.id
      left join iot.greenhouses g on g.id = n.greenhouse_id
      left join iot.thresholds t on t.greenhouse_id = n.greenhouse_id
     where n.enabled and s.ts is not null`
  let raised = 0
  for (const n of nodes) {
    const interval = n.interval_s ?? 60
    const ageS = (now.getTime() - n.ts.getTime()) / 1000
    if (ageS <= offlineAfterS(interval)) continue
    const mins = Math.max(1, Math.round(ageS / 60))
    const label = n.code ?? n.label
    const draft: AlertDraft = {
      type: 'node_offline' as AlertType,
      severity: n.kind === 'mast' ? 'warning' : 'critical',
      message: `${label}: el nodo lleva ${mins < 120 ? `${mins} min` : `${Math.round(mins / 60)} h`} sin reportar. El riego automático sigue operando con la última configuración guardada en el nodo.`,
      detail: { lastSeen: n.ts.toISOString(), ageS: Math.round(ageS) },
    }
    await applyAlerts(db, { greenhouseId: n.greenhouse_id, nodeId: n.node_id, now }, { raise: [draft], clear: [] })
    raised++
  }
  return raised
}

/** Solo para pruebas: reinicia el limitador del barrido. */
export function _resetSweepThrottle(): void {
  lastSweepAt = 0
}
