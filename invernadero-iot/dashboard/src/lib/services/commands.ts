import type { Db } from '../db/types'
import { inTransaction } from '../db/types'
import { type Actor, assertCanOnGreenhouse, bypassesSafeguards, canOnGreenhouse, isAdminRole } from '../rbac'
import { verifyPassword } from '../auth/password'
import { audit } from './audit'

/**
 * Órdenes de riego manual (informe, tabla 11: «toda orden manual exige confirmación en dos pasos y
 * tiene corte automático por temporizador»).
 *
 *   Paso 1  requestIrrigation()  → orden `awaiting_confirmation` (vence en 60 s)
 *   Paso 2  confirmIrrigation()  → reingreso de la contraseña → orden `queued`
 *   El nodo la retira en su próxima trama (`delivered`) y responde `executed` o `rejected`.
 *
 * El nodo es la autoridad final: rechaza la orden si ya riega, si está en espera entre riegos o si el
 * suelo está saturado, y la corta sola por temporizador aunque el servidor caiga.
 */

export const CONFIRM_WINDOW_S = 60
export const MANUAL_MIN_S = 5
export const MANUAL_MAX_S = 120
export const LOCK_THRESHOLD = 5
export const LOCK_MINUTES = 15

export type CommandErrorCode = 'forbidden' | 'not_found' | 'busy' | 'invalid' | 'expired' | 'auth' | 'locked' | 'no_node'

export class CommandError extends Error {
  constructor(public readonly code: CommandErrorCode, message: string) {
    super(message)
    this.name = 'CommandError'
  }
}

export type CommandStatus = 'awaiting_confirmation' | 'queued' | 'delivered' | 'executed' | 'rejected' | 'expired' | 'cancelled'

export interface CommandDTO {
  id: string
  greenhouseId: number
  greenhouseCode: string
  type: 'irrigate' | 'stop'
  durationS: number | null
  source: 'manual' | 'schedule'
  status: CommandStatus
  requestedBy: string | null
  confirmedBy: string | null
  createdAt: string
  confirmExpiresAt: string | null
  confirmedAt: string | null
  expiresAt: string | null
  deliveredAt: string | null
  ackedAt: string | null
  resultDetail: string | null
}

interface CommandRow {
  id: string
  greenhouse_id: number
  code: string
  type: 'irrigate' | 'stop'
  duration_s: number | null
  source: 'manual' | 'schedule'
  status: CommandStatus
  requested_name: string | null
  confirmed_name: string | null
  created_at: Date
  confirm_expires_at: Date | null
  confirmed_at: Date | null
  expires_at: Date | null
  delivered_at: Date | null
  acked_at: Date | null
  result_detail: string | null
}

/** Fragmento SELECT reutilizable; cada consulta le agrega su propio WHERE. */
const commandSelect = (db: Db) => db`
  select c.id, c.greenhouse_id, g.code, c.type, c.duration_s, c.source, c.status,
         ur.name as requested_name, uc.name as confirmed_name,
         c.created_at, c.confirm_expires_at, c.confirmed_at, c.expires_at, c.delivered_at, c.acked_at, c.result_detail
    from iot.commands c
    join iot.greenhouses g on g.id = c.greenhouse_id
    left join iot.app_users ur on ur.id = c.requested_by
    left join iot.app_users uc on uc.id = c.confirmed_by`

const iso = (d: Date | null) => d?.toISOString() ?? null

export const toCommandDTO = (r: CommandRow): CommandDTO => ({
  id: r.id, greenhouseId: r.greenhouse_id, greenhouseCode: r.code, type: r.type, durationS: r.duration_s,
  source: r.source, status: r.status, requestedBy: r.requested_name, confirmedBy: r.confirmed_name,
  createdAt: r.created_at.toISOString(), confirmExpiresAt: iso(r.confirm_expires_at), confirmedAt: iso(r.confirmed_at),
  expiresAt: iso(r.expires_at), deliveredAt: iso(r.delivered_at), ackedAt: iso(r.acked_at), resultDetail: r.result_detail,
})

async function loadCommand(db: Db, id: string): Promise<CommandDTO> {
  const rows = await db<CommandRow[]>`${commandSelect(db)} where c.id = ${id}`
  const r = rows[0]
  if (!r) throw new CommandError('not_found', 'La orden no existe.')
  return toCommandDTO(r)
}

async function expireStale(db: Db, nodeId: number, now: Date): Promise<void> {
  await db`
    update iot.commands set status = 'expired'
     where node_id = ${nodeId}
       and ((status = 'awaiting_confirmation' and confirm_expires_at < ${now})
         or (status in ('queued', 'delivered') and expires_at < ${now}))`
}

/** Tiempo que el nodo tiene para retirar una orden confirmada: al menos dos intervalos de reporte. */
export const deliveryWindowS = (intervalS: number): number => Math.max(2 * intervalS, 120)

export interface RequestIrrigationInput {
  greenhouseId: number
  durationS: number
  ip?: string | null
}

/** Paso 1: registra la solicitud. NO actúa sobre la bomba todavía. */
export async function requestIrrigation(db: Db, actor: Actor, input: RequestIrrigationInput, now = new Date()): Promise<CommandDTO> {
  assertCanOnGreenhouse(actor, 'irrigation:command', input.greenhouseId)
  if (!Number.isInteger(input.durationS) || input.durationS < MANUAL_MIN_S || input.durationS > MANUAL_MAX_S) {
    throw new CommandError('invalid', `La duración debe estar entre ${MANUAL_MIN_S} y ${MANUAL_MAX_S} segundos.`)
  }
  return inTransaction(db, async (tx) => {
    const [n] = await tx<{ node_id: number; enabled: boolean; code: string; pump_max_s: number }[]>`
      select n.id as node_id, n.enabled, g.code, t.pump_max_s
        from iot.nodes n
        join iot.greenhouses g on g.id = n.greenhouse_id
        join iot.thresholds t on t.greenhouse_id = g.id
       where n.greenhouse_id = ${input.greenhouseId}
       for update of n`
    if (!n || !n.enabled) throw new CommandError('no_node', 'Este invernadero no tiene un nodo habilitado.')
    const superuser = bypassesSafeguards(actor.role)
    // El súper administrador no tiene tope del servidor (el nodo igual acorta a su propio máximo).
    if (!superuser && input.durationS > n.pump_max_s) {
      throw new CommandError('invalid', `El máximo de riego configurado para ${n.code} es ${n.pump_max_s} s.`)
    }
    await expireStale(tx, n.node_id, now)
    if (superuser) {
      // Sin esperar: lo que estuviera pendiente de entregar se reemplaza por esta orden.
      await tx`
        update iot.commands set status = 'cancelled', result_detail = 'Reemplazada por una orden de un súper administrador'
         where node_id = ${n.node_id} and status in ('awaiting_confirmation', 'queued')`
    }
    const [busy] = await tx<{ id: string }[]>`
      select id from iot.commands
       where node_id = ${n.node_id} and status in ('awaiting_confirmation', 'queued', 'delivered') limit 1`
    if (busy) throw new CommandError('busy', 'Ya hay una orden en curso para este invernadero. Espera a que termine o cancélala.')

    if (superuser) {
      // Sin confirmación en dos pasos: queda directamente en cola para el próximo reporte del nodo.
      const [interval] = await tx<{ interval_s: number }[]>`select interval_s from iot.thresholds where greenhouse_id = ${input.greenhouseId}`
      const expiresAt = new Date(now.getTime() + deliveryWindowS(interval?.interval_s ?? 0) * 1000)
      const [row] = await tx<{ id: string }[]>`
        insert into iot.commands (greenhouse_id, node_id, type, duration_s, source, status, requested_by, confirmed_by, created_at, confirmed_at, expires_at)
        values (${input.greenhouseId}, ${n.node_id}, 'irrigate', ${input.durationS}, 'manual', 'queued', ${actor.id}, ${actor.id}, ${now}, ${now}, ${expiresAt})
        returning id`
      await audit(tx, {
        actorId: actor.id, actorLabel: actor.email, actorRole: actor.role, action: 'command.request',
        target: `greenhouse:${input.greenhouseId}`, detail: { commandId: row!.id, code: n.code, durationS: input.durationS, sinConfirmacion: true }, ip: input.ip ?? null,
      })
      return loadCommand(tx, row!.id)
    }

    const confirmBy = new Date(now.getTime() + CONFIRM_WINDOW_S * 1000)
    const [row] = await tx<{ id: string }[]>`
      insert into iot.commands (greenhouse_id, node_id, type, duration_s, source, status, requested_by, created_at, confirm_expires_at)
      values (${input.greenhouseId}, ${n.node_id}, 'irrigate', ${input.durationS}, 'manual', 'awaiting_confirmation', ${actor.id}, ${now}, ${confirmBy})
      returning id`
    await audit(tx, {
      actorId: actor.id, actorLabel: actor.email, actorRole: actor.role, action: 'command.request',
      target: `greenhouse:${input.greenhouseId}`, detail: { commandId: row!.id, code: n.code, durationS: input.durationS }, ip: input.ip ?? null,
    })
    return loadCommand(tx, row!.id)
  })
}

export interface ConfirmInput {
  commandId: string
  password: string
  ip?: string | null
}

/** Paso 2: reingreso de la contraseña. Recién aquí la orden queda disponible para el nodo. */
export async function confirmIrrigation(db: Db, actor: Actor, input: ConfirmInput, now = new Date()): Promise<CommandDTO> {
  const rows = await db<{
    id: string; greenhouse_id: number; status: CommandStatus; requested_by: string | null
    confirm_expires_at: Date | null; interval_s: number; code: string; duration_s: number | null
  }[]>`
    select c.id, c.greenhouse_id, c.status, c.requested_by, c.confirm_expires_at, c.duration_s, t.interval_s, g.code
      from iot.commands c
      join iot.greenhouses g on g.id = c.greenhouse_id
      join iot.thresholds t on t.greenhouse_id = c.greenhouse_id
     where c.id = ${input.commandId}`
  const c = rows[0]
  if (!c) throw new CommandError('not_found', 'La orden no existe.')
  // Solo quien la solicitó puede confirmarla, y debe seguir teniendo permiso y alcance.
  if (c.requested_by !== actor.id || !canOnGreenhouse(actor, 'irrigation:command', c.greenhouse_id)) {
    throw new CommandError('forbidden', 'No puedes confirmar esta orden.')
  }
  if (c.status !== 'awaiting_confirmation') throw new CommandError('invalid', 'La orden ya no está pendiente de confirmación.')
  if (!c.confirm_expires_at || c.confirm_expires_at < now) {
    await db`update iot.commands set status = 'expired' where id = ${c.id} and status = 'awaiting_confirmation'`
    throw new CommandError('expired', 'La confirmación venció. Solicita el riego nuevamente.')
  }

  const [u] = await db<{ password_hash: string; locked_until: Date | null }[]>`
    select password_hash, locked_until from iot.app_users where id = ${actor.id} and is_active`
  if (!u) throw new CommandError('forbidden', 'Cuenta inactiva.')
  if (u.locked_until && u.locked_until > now) throw new CommandError('locked', 'Cuenta bloqueada temporalmente por intentos fallidos.')

  if (!(await verifyPassword(input.password, u.password_hash))) {
    await db`
      update iot.app_users
         set failed_logins = case when failed_logins + 1 >= ${LOCK_THRESHOLD} then 0 else failed_logins + 1 end,
             locked_until  = case when failed_logins + 1 >= ${LOCK_THRESHOLD} then ${new Date(now.getTime() + LOCK_MINUTES * 60_000)} else locked_until end
       where id = ${actor.id}`
    await audit(db, {
      actorId: actor.id, actorLabel: actor.email, actorRole: actor.role, action: 'command.confirm_failed',
      target: `greenhouse:${c.greenhouse_id}`, detail: { commandId: c.id }, ip: input.ip ?? null,
    })
    throw new CommandError('auth', 'Contraseña incorrecta.')
  }

  const expiresAt = new Date(now.getTime() + deliveryWindowS(c.interval_s) * 1000)
  const updated = await db<{ id: string }[]>`
    update iot.commands
       set status = 'queued', confirmed_by = ${actor.id}, confirmed_at = ${now}, expires_at = ${expiresAt}
     where id = ${c.id} and status = 'awaiting_confirmation'
    returning id`
  if (updated.length === 0) throw new CommandError('invalid', 'La orden ya no está pendiente de confirmación.')
  await db`update iot.app_users set failed_logins = 0 where id = ${actor.id}`
  await audit(db, {
    actorId: actor.id, actorLabel: actor.email, actorRole: actor.role, action: 'command.confirm',
    target: `greenhouse:${c.greenhouse_id}`, detail: { commandId: c.id, code: c.code, durationS: c.duration_s }, ip: input.ip ?? null,
  })
  return loadCommand(db, c.id)
}

/**
 * Detener la bomba: es un paso único a propósito. Pedir confirmación para «apagar» solo retrasaría una
 * acción que reduce el riesgo; queda igualmente registrada en la bitácora.
 */
export async function requestStop(db: Db, actor: Actor, input: { greenhouseId: number; ip?: string | null }, now = new Date()): Promise<CommandDTO> {
  assertCanOnGreenhouse(actor, 'irrigation:command', input.greenhouseId)
  return inTransaction(db, async (tx) => {
    const [n] = await tx<{ node_id: number; enabled: boolean; code: string; interval_s: number }[]>`
      select n.id as node_id, n.enabled, g.code, t.interval_s
        from iot.nodes n
        join iot.greenhouses g on g.id = n.greenhouse_id
        join iot.thresholds t on t.greenhouse_id = g.id
       where n.greenhouse_id = ${input.greenhouseId}
       for update of n`
    if (!n || !n.enabled) throw new CommandError('no_node', 'Este invernadero no tiene un nodo habilitado.')
    await expireStale(tx, n.node_id, now)
    // Una orden de detener reemplaza cualquier orden de riego que aún no llegó al nodo.
    await tx`
      update iot.commands set status = 'cancelled', result_detail = 'Reemplazada por una orden de detener'
       where node_id = ${n.node_id} and type = 'irrigate' and status in ('awaiting_confirmation', 'queued')`
    const expiresAt = new Date(now.getTime() + deliveryWindowS(n.interval_s) * 1000)
    const [row] = await tx<{ id: string }[]>`
      insert into iot.commands (greenhouse_id, node_id, type, source, status, requested_by, confirmed_by, created_at, confirmed_at, expires_at)
      values (${input.greenhouseId}, ${n.node_id}, 'stop', 'manual', 'queued', ${actor.id}, ${actor.id}, ${now}, ${now}, ${expiresAt})
      returning id`
    await audit(tx, {
      actorId: actor.id, actorLabel: actor.email, actorRole: actor.role, action: 'command.stop',
      target: `greenhouse:${input.greenhouseId}`, detail: { commandId: row!.id, code: n.code }, ip: input.ip ?? null,
    })
    return loadCommand(tx, row!.id)
  })
}

/** Cancela una orden que todavía no llegó al nodo. Puede el solicitante o un administrador. */
export async function cancelCommand(db: Db, actor: Actor, commandId: string, ip: string | null = null): Promise<CommandDTO> {
  const [c] = await db<{ requested_by: string | null; greenhouse_id: number }[]>`
    select requested_by, greenhouse_id from iot.commands where id = ${commandId}`
  if (!c) throw new CommandError('not_found', 'La orden no existe.')
  const owns = c.requested_by === actor.id || isAdminRole(actor.role)
  if (!owns || !canOnGreenhouse(actor, 'irrigation:command', c.greenhouse_id)) {
    throw new CommandError('forbidden', 'No puedes cancelar esta orden.')
  }
  const updated = await db<{ id: string }[]>`
    update iot.commands set status = 'cancelled', result_detail = 'Cancelada por el usuario'
     where id = ${commandId} and status in ('awaiting_confirmation', 'queued')
    returning id`
  if (updated.length === 0) throw new CommandError('invalid', 'La orden ya fue entregada al nodo o terminó; no se puede cancelar.')
  await audit(db, {
    actorId: actor.id, actorLabel: actor.email, actorRole: actor.role, action: 'command.cancel',
    target: `greenhouse:${c.greenhouse_id}`, detail: { commandId }, ip,
  })
  return loadCommand(db, commandId)
}

/** Estado de una orden, para el seguimiento desde la interfaz. Respeta el alcance del usuario. */
export async function getCommand(db: Db, actor: Actor, commandId: string): Promise<CommandDTO> {
  const dto = await loadCommand(db, commandId)
  if (!canOnGreenhouse(actor, 'greenhouse:view', dto.greenhouseId)) {
    throw new CommandError('forbidden', 'No tienes acceso a esta orden.')
  }
  return dto
}

export async function listCommands(db: Db, actor: Actor, greenhouseId: number, limit = 10): Promise<CommandDTO[]> {
  assertCanOnGreenhouse(actor, 'greenhouse:view', greenhouseId)
  const rows = await db<CommandRow[]>`
    ${commandSelect(db)}
     where c.greenhouse_id = ${greenhouseId}
     order by c.created_at desc
     limit ${Math.min(limit, 50)}`
  return rows.map(toCommandDTO)
}
