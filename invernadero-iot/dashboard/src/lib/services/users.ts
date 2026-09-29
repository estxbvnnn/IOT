import { z } from 'zod'
import type { Db } from '../db/types'
import { inTransaction } from '../db/types'
import { type Actor, type Role, ROLES, assertCan } from '../rbac'
import { hashPassword } from '../auth/password'
import { revokeSessions } from '../auth/service'
import { generatePassword } from '../auth/tokens'
import { audit } from './audit'
import { ValidationError } from './thresholds'

/** Gestión de cuentas (solo administrador; informe, tabla 11: «creación de usuarios»). */

export interface UserDTO {
  id: string
  email: string
  name: string
  role: Role
  isActive: boolean
  hasTotp: boolean
  lastLoginAt: string | null
  lockedUntil: string | null
  mustChangePassword: boolean
  greenhouseIds: number[]
  createdAt: string
}

export const createUserSchema = z.object({
  name: z.string().trim().min(2, 'Ingresa el nombre.').max(120),
  email: z.string().trim().toLowerCase().max(254).pipe(z.email('Correo inválido.')),
  role: z.enum(ROLES),
  greenhouseIds: z.array(z.number().int().min(1).max(99)).max(99).default([]),
})
export type CreateUserInput = z.infer<typeof createUserSchema>

export async function listUsers(db: Db, actor: Actor): Promise<UserDTO[]> {
  assertCan(actor, 'users:manage')
  const rows = await db<{
    id: string; email: string; name: string; role: Role; is_active: boolean; has_totp: boolean
    last_login_at: Date | null; locked_until: Date | null; must_change_password: boolean; created_at: Date; greenhouse_ids: number[] | null
  }[]>`
    select u.id, u.email, u.name, u.role, u.is_active, (u.totp_secret_enc is not null) as has_totp,
           u.last_login_at, u.locked_until, u.must_change_password, u.created_at,
           (select array_agg(ug.greenhouse_id order by ug.greenhouse_id) from iot.user_greenhouses ug where ug.user_id = u.id) as greenhouse_ids
      from iot.app_users u order by u.role, u.name`
  return rows.map((r) => ({
    id: r.id, email: r.email, name: r.name, role: r.role, isActive: r.is_active, hasTotp: r.has_totp,
    lastLoginAt: r.last_login_at?.toISOString() ?? null, lockedUntil: r.locked_until && r.locked_until > new Date() ? r.locked_until.toISOString() : null,
    mustChangePassword: r.must_change_password, greenhouseIds: r.greenhouse_ids ?? [], createdAt: r.created_at.toISOString(),
  }))
}

async function setAssignments(db: Db, userId: string, role: Role, ids: readonly number[]): Promise<void> {
  await db`delete from iot.user_greenhouses where user_id = ${userId}`
  // Solo los operadores tienen alcance limitado; para el resto no se guardan asignaciones.
  if (role !== 'operator' || ids.length === 0) return
  await db`
    insert into iot.user_greenhouses (user_id, greenhouse_id)
    select ${userId}, g.id from iot.greenhouses g where g.id = any(${db.array([...ids], 21)}::smallint[])`
}

/** Crea una cuenta con una contraseña inicial aleatoria que se muestra UNA sola vez y debe cambiarse. */
export async function createUser(db: Db, actor: Actor, raw: z.input<typeof createUserSchema>, ip: string | null = null): Promise<{ user: UserDTO; initialPassword: string }> {
  assertCan(actor, 'users:manage')
  const parsed = createUserSchema.safeParse(raw)
  if (!parsed.success) {
    const fe: Record<string, string> = {}
    for (const i of parsed.error.issues) fe[String(i.path[0] ?? 'form')] ??= i.message
    throw new ValidationError(fe)
  }
  const input = parsed.data
  const initialPassword = generatePassword(16)
  const hash = await hashPassword(initialPassword)
  const id = await inTransaction(db, async (tx) => {
    const dup = await tx`select 1 from iot.app_users where email = ${input.email}`
    if (dup.length > 0) throw new ValidationError({ email: 'Ya existe una cuenta con ese correo.' })
    const [row] = await tx<{ id: string }[]>`
      insert into iot.app_users (email, name, role, password_hash, must_change_password)
      values (${input.email}, ${input.name}, ${input.role}, ${hash}, true)
      returning id`
    await setAssignments(tx, row!.id, input.role, input.greenhouseIds)
    await audit(tx, {
      actorId: actor.id, actorLabel: actor.email, actorRole: actor.role, action: 'user.create',
      target: `user:${row!.id}`, detail: { email: input.email, role: input.role, greenhouseIds: input.greenhouseIds }, ip,
    })
    return row!.id
  })
  const user = (await listUsers(db, actor)).find((u) => u.id === id)!
  return { user, initialPassword }
}

async function adminCount(db: Db): Promise<number> {
  const [r] = await db<{ n: number }[]>`select count(*)::int as n from iot.app_users where role = 'admin' and is_active`
  return r?.n ?? 0
}

export async function setUserActive(db: Db, actor: Actor, userId: string, active: boolean, ip: string | null = null): Promise<void> {
  assertCan(actor, 'users:manage')
  if (!active && userId === actor.id) throw new ValidationError({}, 'No puedes desactivar tu propia cuenta.')
  const [u] = await db<{ role: Role; is_active: boolean; email: string }[]>`select role, is_active, email from iot.app_users where id = ${userId}`
  if (!u) throw new ValidationError({}, 'Usuario no encontrado.')
  if (!active && u.role === 'admin' && u.is_active && (await adminCount(db)) <= 1) {
    throw new ValidationError({}, 'Debe quedar al menos un administrador activo.')
  }
  await db`update iot.app_users set is_active = ${active}, updated_at = now(), failed_logins = 0, locked_until = null where id = ${userId}`
  if (!active) await revokeSessions(db, userId)
  await audit(db, {
    actorId: actor.id, actorLabel: actor.email, actorRole: actor.role, action: active ? 'user.activate' : 'user.deactivate',
    target: `user:${userId}`, detail: { email: u.email }, ip,
  })
}

/** Restablece la contraseña: genera una nueva aleatoria (se muestra una vez), cierra sus sesiones y fuerza el cambio. */
export async function resetUserPassword(db: Db, actor: Actor, userId: string, ip: string | null = null): Promise<string> {
  assertCan(actor, 'users:manage')
  const [u] = await db<{ email: string }[]>`select email from iot.app_users where id = ${userId}`
  if (!u) throw new ValidationError({}, 'Usuario no encontrado.')
  const password = generatePassword(16)
  await db`
    update iot.app_users set password_hash = ${await hashPassword(password)}, must_change_password = true,
           failed_logins = 0, locked_until = null, updated_at = now()
     where id = ${userId}`
  await revokeSessions(db, userId)
  await audit(db, {
    actorId: actor.id, actorLabel: actor.email, actorRole: actor.role, action: 'user.password_reset',
    target: `user:${userId}`, detail: { email: u.email }, ip,
  })
  return password
}

export async function resetUserMfa(db: Db, actor: Actor, userId: string, ip: string | null = null): Promise<void> {
  assertCan(actor, 'users:manage')
  const [u] = await db<{ email: string }[]>`select email from iot.app_users where id = ${userId}`
  if (!u) throw new ValidationError({}, 'Usuario no encontrado.')
  await db`update iot.app_users set totp_secret_enc = null, totp_last_step = null, updated_at = now() where id = ${userId}`
  await revokeSessions(db, userId)
  await audit(db, {
    actorId: actor.id, actorLabel: actor.email, actorRole: actor.role, action: 'user.mfa_reset',
    target: `user:${userId}`, detail: { email: u.email }, ip,
  })
}

export async function updateUserAccess(db: Db, actor: Actor, userId: string, input: { role: Role; greenhouseIds: number[] }, ip: string | null = null): Promise<void> {
  assertCan(actor, 'users:manage')
  if (!(ROLES as readonly string[]).includes(input.role)) throw new ValidationError({ role: 'Rol inválido.' })
  await inTransaction(db, async (tx) => {
    const [u] = await tx<{ role: Role; email: string }[]>`select role, email from iot.app_users where id = ${userId} for update`
    if (!u) throw new ValidationError({}, 'Usuario no encontrado.')
    if (u.role === 'admin' && input.role !== 'admin' && (await adminCount(tx)) <= 1) {
      throw new ValidationError({ role: 'Debe quedar al menos un administrador activo.' })
    }
    if (userId === actor.id && input.role !== actor.role) throw new ValidationError({ role: 'No puedes cambiar tu propio rol.' })
    await tx`update iot.app_users set role = ${input.role}, updated_at = now() where id = ${userId}`
    await setAssignments(tx, userId, input.role, input.greenhouseIds)
    if (u.role !== input.role) await revokeSessions(tx, userId) // el rol cambió: que vuelva a iniciar sesión
    await audit(tx, {
      actorId: actor.id, actorLabel: actor.email, actorRole: actor.role, action: 'user.update',
      target: `user:${userId}`, detail: { email: u.email, from: u.role, to: input.role, greenhouseIds: input.greenhouseIds }, ip,
    })
  })
}
