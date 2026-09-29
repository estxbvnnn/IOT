import type { Db } from '../db/types'

/**
 * Bitácora de auditoría (informe, tabla 10: «bitácora inmutable de todas las acciones»).
 * La inmutabilidad la garantiza la base: el rol de la app solo puede INSERT/SELECT y un trigger
 * encadena hashes SHA-256 (ver supabase/migrations/0001_init.sql).
 */

export const AUDIT_ACTIONS = [
  'auth.login', 'auth.login_failed', 'auth.logout', 'auth.password_changed', 'auth.mfa_enabled', 'auth.mfa_disabled',
  'command.request', 'command.confirm', 'command.confirm_failed', 'command.cancel', 'command.stop',
  'command.delivered', 'command.ack', 'command.expired',
  'thresholds.update', 'schedule.create', 'schedule.update', 'schedule.delete', 'schedule.trigger',
  'alert.ack', 'data.export',
  'user.create', 'user.update', 'user.deactivate', 'user.activate', 'user.password_reset', 'user.mfa_reset', 'user.greenhouses',
  'device.create', 'device.rotate_token', 'device.enable', 'device.disable', 'device.auth_failed', 'device.first_seen',
  'greenhouse.create', 'greenhouse.update', 'greenhouse.archive', 'greenhouse.restore', 'site.update',
  'audit.verify', 'system.seed',
] as const
export type AuditAction = (typeof AUDIT_ACTIONS)[number]

export interface AuditEntry {
  actorId?: string | null
  actorLabel: string
  actorRole?: string | null
  action: AuditAction
  target?: string | null
  detail?: Record<string, unknown>
  ip?: string | null
}

const SECRET_KEY = /pass(word|wd)?|token|secret|authorization|cookie|totp|hash/i

/** Elimina secretos y acota el tamaño antes de guardar el detalle (la bitácora no debe filtrar claves). */
export function redact(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return null
  if (typeof value === 'string') return value.length > 300 ? `${value.slice(0, 300)}…` : value
  if (typeof value === 'number' || typeof value === 'boolean') return value
  if (depth >= 4) return '[…]'
  if (Array.isArray(value)) return value.slice(0, 20).map((v) => redact(v, depth + 1))
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>).slice(0, 30)) {
      out[k] = SECRET_KEY.test(k) ? '[oculto]' : redact(v, depth + 1)
    }
    return out
  }
  return String(value)
}

export function jsonParam(db: Db, value: unknown) {
  return db.json(value as Parameters<Db['json']>[0])
}

export async function audit(db: Db, e: AuditEntry): Promise<void> {
  await db`
    insert into iot.audit_log (actor_id, actor_label, actor_role, action, target, detail, ip)
    values (${e.actorId ?? null}, ${e.actorLabel.slice(0, 200)}, ${e.actorRole ?? null}, ${e.action},
            ${e.target ?? null}, ${jsonParam(db, redact(e.detail ?? {}))}, ${e.ip ?? null})`
}

export interface AuditRow {
  id: number
  ts: string
  actorLabel: string
  actorRole: string | null
  action: string
  target: string | null
  /** Código legible del invernadero cuando el objetivo es «greenhouse:<id>» (la bitácora solo guarda el id). */
  targetCode: string | null
  detail: Record<string, unknown>
  ip: string | null
  /** Primeros bytes del hash de la fila (para mostrar el encadenamiento). */
  hash: string
}

export interface AuditFilter {
  limit?: number
  /** Paginación por cursor: filas con id menor a este. */
  beforeId?: number
  /** Prefijo de acción, p. ej. «auth.» o «command.». */
  actionPrefix?: string
  actor?: string
}

export async function listAudit(db: Db, f: AuditFilter = {}): Promise<{ rows: AuditRow[]; nextBefore: number | null }> {
  const limit = Math.min(Math.max(f.limit ?? 50, 1), 200)
  const prefix = f.actionPrefix ? `${f.actionPrefix.replace(/[%_\\]/g, '\\$&')}%` : null
  const actor = f.actor ? `%${f.actor.replace(/[%_\\]/g, '\\$&')}%` : null
  // Primero se toma la página (con su límite) y solo a esas filas se les busca el código del invernadero.
  const rows = await db<{
    id: number; ts: Date; actor_label: string; actor_role: string | null; action: string
    target: string | null; target_code: string | null; detail: Record<string, unknown>; ip: string | null; hash: string
  }[]>`
    with page as (
      select id, ts, actor_label, actor_role, action, target, detail, ip, encode(hash, 'hex') as hash
        from iot.audit_log
       where (${f.beforeId ?? null}::bigint is null or id < ${f.beforeId ?? null})
         and (${prefix}::text is null or action like ${prefix})
         and (${actor}::text is null or actor_label ilike ${actor})
       order by id desc
       limit ${limit + 1})
    select p.*, g.code as target_code
      from page p
      left join iot.greenhouses g on p.target = 'greenhouse:' || g.id::text
     order by p.id desc`
  const page = rows.slice(0, limit)
  return {
    rows: page.map((r) => ({
      id: r.id, ts: r.ts.toISOString(), actorLabel: r.actor_label, actorRole: r.actor_role, action: r.action,
      target: r.target, targetCode: r.target_code, detail: r.detail, ip: r.ip, hash: r.hash.slice(0, 16),
    })),
    nextBefore: rows.length > limit ? (page[page.length - 1]?.id ?? null) : null,
  }
}

export async function verifyAuditChain(db: Db): Promise<{ checked: number; firstBrokenId: number | null }> {
  const [r] = await db<{ checked: number; first_broken_id: number | null }[]>`select * from iot.verify_audit_chain()`
  return { checked: r?.checked ?? 0, firstBrokenId: r?.first_broken_id ?? null }
}
