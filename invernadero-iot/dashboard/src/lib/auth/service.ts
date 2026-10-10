import type { Db } from '../db/types'
import { type Actor, type Role, isRole } from '../rbac'
import { audit } from '../services/audit'
import { dummyHash, hashPassword, validatePasswordStrength, verifyPassword } from './password'
import { open, seal } from './secretbox'
import { generateToken, hashToken } from './tokens'
import { generateTotpSecret, otpauthUri, verifyTotp } from './totp'

/**
 * Autenticación y sesiones (informe, tablas 10 y 11).
 *
 *  - Contraseñas con scrypt; verificación en tiempo casi constante aunque el correo no exista.
 *  - Bloqueo temporal tras 5 fallos seguidos (15 min) — respuesta genérica, sin revelar el motivo.
 *  - Segundo factor TOTP opcional; obligatorio para los roles de MFA_REQUIRED_ROLES.
 *  - Sesiones en la base (el navegador solo guarda un token aleatorio; se almacena su SHA-256):
 *    revocables al instante y con expiración por inactividad según el rol.
 */

export const LOCK_THRESHOLD = 5
export const LOCK_MINUTES = 15
/** Vencimiento absoluto de cualquier sesión. */
export const SESSION_ABSOLUTE_S = 12 * 3600

/** Inactividad tolerada por rol. El informe fija 30 min para el administrador. */
export const SESSION_IDLE_S: Record<Role, number> = {
  admin: 30 * 60,
  technician: 60 * 60,
  owner: 2 * 3600,
  agronomist: 2 * 3600,
  operator: 8 * 3600,
  // Cuenta de pruebas: no se cierra por inactividad (solo vence a las 12 h absolutas).
  superadmin: SESSION_ABSOLUTE_S,
}

export interface AuthConfig {
  appSecret: string
  mfaRequiredRoles: ReadonlySet<string>
}

export interface SessionUser extends Actor {
  hasTotp: boolean
  mfaVerified: boolean
  /** La política exige segundo factor para este rol. */
  mfaRequired: boolean
  /** Debe registrar su segundo factor antes de usar el sistema. */
  mustEnrollMfa: boolean
  mustChangePassword: boolean
  sessionId: string
}

export interface LoginInput {
  email: string
  password: string
  totp?: string
  ip: string | null
  userAgent: string | null
  now?: Date
}

export type LoginResult =
  | { ok: true; token: string; expiresAt: Date; user: SessionUser }
  | { ok: false; reason: 'invalid' | 'mfa_required' | 'mfa_invalid' }

interface UserRow {
  id: string
  email: string
  name: string
  role: string
  password_hash: string
  totp_secret_enc: string | null
  totp_last_step: number | null
  is_active: boolean
  locked_until: Date | null
  must_change_password: boolean
}

async function registerFailure(db: Db, user: Pick<UserRow, 'id' | 'email' | 'role'>, reason: string, ip: string | null, now: Date): Promise<void> {
  const [r] = await db<{ locked_until: Date | null; failed_logins: number }[]>`
    update iot.app_users
       set failed_logins = case when failed_logins + 1 >= ${LOCK_THRESHOLD} then 0 else failed_logins + 1 end,
           locked_until  = case when failed_logins + 1 >= ${LOCK_THRESHOLD} then ${new Date(now.getTime() + LOCK_MINUTES * 60_000)} else locked_until end
     where id = ${user.id}
    returning locked_until, failed_logins`
  const justLocked = r?.locked_until && r.locked_until.getTime() > now.getTime() && r.failed_logins === 0
  await audit(db, {
    actorId: user.id, actorLabel: user.email, actorRole: user.role, action: 'auth.login_failed',
    detail: { reason, ...(justLocked ? { locked_for_min: LOCK_MINUTES } : {}) }, ip,
  })
}

const isMfaRequired = (cfg: AuthConfig, role: string) => cfg.mfaRequiredRoles.has(role)

async function loadAssignments(db: Db, userId: string, role: Role): Promise<number[]> {
  if (role !== 'operator') return []
  const rows = await db<{ greenhouse_id: number }[]>`select greenhouse_id from iot.user_greenhouses where user_id = ${userId} order by 1`
  return rows.map((r) => r.greenhouse_id)
}

export async function login(db: Db, cfg: AuthConfig, input: LoginInput): Promise<LoginResult> {
  const now = input.now ?? new Date()
  const email = input.email.trim().toLowerCase()

  const [user] = await db<UserRow[]>`
    select id, email, name, role, password_hash, totp_secret_enc, totp_last_step, is_active, locked_until, must_change_password
      from iot.app_users where email = ${email}`

  if (!user || !isRole(user.role)) {
    // Se gasta el mismo tiempo que con un usuario real (evita enumerar cuentas por latencia).
    await verifyPassword(input.password, await dummyHash())
    await audit(db, { actorLabel: `desconocido:${email.slice(0, 80)}`, action: 'auth.login_failed', detail: { reason: 'unknown_user' }, ip: input.ip })
    return { ok: false, reason: 'invalid' }
  }
  const role = user.role as Role

  if (user.locked_until && user.locked_until > now) {
    await verifyPassword(input.password, await dummyHash())
    await audit(db, { actorId: user.id, actorLabel: user.email, actorRole: role, action: 'auth.login_failed', detail: { reason: 'locked' }, ip: input.ip })
    return { ok: false, reason: 'invalid' }
  }

  const passwordOk = await verifyPassword(input.password, user.password_hash)
  if (!passwordOk || !user.is_active) {
    await registerFailure(db, user, passwordOk ? 'inactive' : 'bad_password', input.ip, now)
    return { ok: false, reason: 'invalid' }
  }

  // Segundo factor.
  let mfaVerified = false
  let newStep: number | null = null
  if (user.totp_secret_enc) {
    if (!input.totp) return { ok: false, reason: 'mfa_required' }
    const secret = open(user.totp_secret_enc, cfg.appSecret)
    if (!secret) {
      await registerFailure(db, user, 'mfa_secret_unreadable', input.ip, now)
      return { ok: false, reason: 'invalid' }
    }
    const v = verifyTotp(secret, input.totp, now.getTime(), user.totp_last_step)
    if (!v.ok) {
      await registerFailure(db, user, 'bad_totp', input.ip, now)
      return { ok: false, reason: 'mfa_invalid' }
    }
    mfaVerified = true
    newStep = v.step
  }

  const token = generateToken()
  const idleS = SESSION_IDLE_S[role]
  const expiresAt = new Date(now.getTime() + SESSION_ABSOLUTE_S * 1000)
  await db`
    insert into iot.sessions (id, user_id, created_at, last_seen_at, expires_at, idle_timeout_s, mfa_verified, ip, user_agent)
    values (${hashToken(token)}, ${user.id}, ${now}, ${now}, ${expiresAt}, ${idleS}, ${mfaVerified}, ${input.ip}, ${input.userAgent?.slice(0, 200) ?? null})`
  await db`
    update iot.app_users
       set failed_logins = 0, locked_until = null, last_login_at = ${now},
           totp_last_step = coalesce(${newStep}::bigint, totp_last_step)
     where id = ${user.id}`
  await audit(db, { actorId: user.id, actorLabel: user.email, actorRole: role, action: 'auth.login', detail: { mfa: mfaVerified }, ip: input.ip })
  // Mantenimiento: se limpian sesiones vencidas de vez en cuando.
  if (Math.random() < 0.05) await db`delete from iot.sessions where expires_at < ${now}`.catch(() => {})

  return {
    ok: true, token, expiresAt,
    user: await toSessionUser(db, cfg, { ...user, role }, token, mfaVerified),
  }
}

async function toSessionUser(db: Db, cfg: AuthConfig, u: { id: string; email: string; name: string; role: Role; totp_secret_enc: string | null; must_change_password: boolean }, token: string, mfaVerified: boolean): Promise<SessionUser> {
  const hasTotp = u.totp_secret_enc !== null
  const mfaRequired = isMfaRequired(cfg, u.role)
  return {
    id: u.id, email: u.email, name: u.name, role: u.role,
    greenhouseIds: await loadAssignments(db, u.id, u.role),
    hasTotp, mfaVerified, mfaRequired, mustEnrollMfa: mfaRequired && !hasTotp,
    mustChangePassword: u.must_change_password, sessionId: hashToken(token).toString('hex').slice(0, 12),
  }
}

/**
 * Valida el token de la cookie y devuelve el usuario. Aplica vencimiento absoluto e inactividad,
 * y renueva `last_seen_at` (con un mínimo de 30 s entre escrituras).
 */
export async function getSessionUser(db: Db, cfg: AuthConfig, token: string, now = new Date()): Promise<SessionUser | null> {
  if (!/^[A-Za-z0-9_-]{20,128}$/.test(token)) return null
  const id = hashToken(token)
  const [s] = await db<{
    user_id: string; last_seen_at: Date; expires_at: Date; idle_timeout_s: number; mfa_verified: boolean
    email: string; name: string; role: string; is_active: boolean; must_change_password: boolean; totp_secret_enc: string | null
  }[]>`
    select s.user_id, s.last_seen_at, s.expires_at, s.idle_timeout_s, s.mfa_verified,
           u.email, u.name, u.role, u.is_active, u.must_change_password, u.totp_secret_enc
      from iot.sessions s join iot.app_users u on u.id = s.user_id
     where s.id = ${id}`
  if (!s || !isRole(s.role)) return null

  const idleMs = now.getTime() - s.last_seen_at.getTime()
  if (!s.is_active || s.expires_at <= now || idleMs > s.idle_timeout_s * 1000) {
    await db`delete from iot.sessions where id = ${id}`.catch(() => {})
    return null
  }
  if (idleMs > 30_000) await db`update iot.sessions set last_seen_at = ${now} where id = ${id}`.catch(() => {})

  return toSessionUser(db, cfg, { id: s.user_id, email: s.email, name: s.name, role: s.role as Role, totp_secret_enc: s.totp_secret_enc, must_change_password: s.must_change_password }, token, s.mfa_verified)
}

export async function logout(db: Db, token: string, who?: Pick<Actor, 'id' | 'email' | 'role'>, ip: string | null = null): Promise<void> {
  await db`delete from iot.sessions where id = ${hashToken(token)}`
  if (who) await audit(db, { actorId: who.id, actorLabel: who.email, actorRole: who.role, action: 'auth.logout', ip })
}

/** Cierra todas las sesiones de un usuario, salvo (opcionalmente) la actual. */
export async function revokeSessions(db: Db, userId: string, exceptToken?: string): Promise<void> {
  if (exceptToken) await db`delete from iot.sessions where user_id = ${userId} and id <> ${hashToken(exceptToken)}`
  else await db`delete from iot.sessions where user_id = ${userId}`
}

export class AuthError extends Error {
  constructor(message: string, public readonly field?: string) {
    super(message)
    this.name = 'AuthError'
  }
}

/** Cambio de contraseña: exige la actual, aplica la política y cierra las demás sesiones. */
export async function changePassword(db: Db, actor: Actor, input: { current: string; next: string; keepToken?: string; ip?: string | null }): Promise<void> {
  const [u] = await db<{ password_hash: string; email: string; name: string }[]>`
    select password_hash, email, name from iot.app_users where id = ${actor.id} and is_active`
  if (!u) throw new AuthError('Cuenta no encontrada.')
  if (!(await verifyPassword(input.current, u.password_hash))) throw new AuthError('La contraseña actual no es correcta.', 'current')
  const weak = validatePasswordStrength(input.next, { email: u.email, name: u.name })
  if (weak) throw new AuthError(weak, 'next')
  if (await verifyPassword(input.next, u.password_hash)) throw new AuthError('La nueva contraseña debe ser distinta de la actual.', 'next')
  await db`
    update iot.app_users set password_hash = ${await hashPassword(input.next)}, must_change_password = false, updated_at = now()
     where id = ${actor.id}`
  await revokeSessions(db, actor.id, input.keepToken)
  await audit(db, { actorId: actor.id, actorLabel: actor.email, actorRole: actor.role, action: 'auth.password_changed', ip: input.ip ?? null })
}

// --- Segundo factor (TOTP) --------------------------------------------------------------------

export const ENROLL_TTL_MS = 10 * 60_000
const ISSUER = 'Invernadero IoT'

export interface TotpEnrollment {
  secret: string
  uri: string
  /** Secreto cifrado (con vencimiento) que el formulario devuelve al confirmar; no requiere estado en el servidor. */
  enrollToken: string
}

/** Paso 1: genera una semilla nueva. Todavía no se guarda: solo se activa al confirmar con un código válido. */
export function beginTotpEnrollment(cfg: AuthConfig, actor: Pick<Actor, 'id' | 'email'>, now = new Date()): TotpEnrollment {
  const secret = generateTotpSecret()
  const payload = JSON.stringify({ s: secret, u: actor.id, exp: now.getTime() + ENROLL_TTL_MS })
  return { secret, uri: otpauthUri({ secret, account: actor.email, issuer: ISSUER }), enrollToken: seal(payload, cfg.appSecret, 'totp-enroll') }
}

/** Paso 2: confirma con un código de la app autenticadora y guarda la semilla cifrada. */
export async function confirmTotpEnrollment(db: Db, cfg: AuthConfig, actor: Actor, input: { enrollToken: string; code: string; sessionToken?: string; ip?: string | null }, now = new Date()): Promise<void> {
  const plain = open(input.enrollToken, cfg.appSecret, 'totp-enroll')
  let payload: { s: string; u: string; exp: number } | null = null
  try { payload = plain ? (JSON.parse(plain) as { s: string; u: string; exp: number }) : null } catch { payload = null }
  if (!payload || payload.u !== actor.id || payload.exp < now.getTime()) {
    throw new AuthError('El registro expiró. Genera un código nuevo.')
  }
  const v = verifyTotp(payload.s, input.code, now.getTime(), null)
  if (!v.ok) throw new AuthError('El código no es correcto. Revisa la hora de tu teléfono e inténtalo de nuevo.', 'code')
  await db`
    update iot.app_users set totp_secret_enc = ${seal(payload.s, cfg.appSecret, 'totp')}, totp_last_step = ${v.step}, updated_at = now()
     where id = ${actor.id}`
  if (input.sessionToken) await db`update iot.sessions set mfa_verified = true where id = ${hashToken(input.sessionToken)}`
  await audit(db, { actorId: actor.id, actorLabel: actor.email, actorRole: actor.role, action: 'auth.mfa_enabled', ip: input.ip ?? null })
}

export async function disableTotp(db: Db, cfg: AuthConfig, actor: Actor, input: { password: string; ip?: string | null }): Promise<void> {
  if (isMfaRequired(cfg, actor.role)) throw new AuthError('La política de seguridad exige segundo factor para tu rol.')
  const [u] = await db<{ password_hash: string }[]>`select password_hash from iot.app_users where id = ${actor.id}`
  if (!u || !(await verifyPassword(input.password, u.password_hash))) throw new AuthError('Contraseña incorrecta.', 'password')
  await db`update iot.app_users set totp_secret_enc = null, totp_last_step = null, updated_at = now() where id = ${actor.id}`
  await audit(db, { actorId: actor.id, actorLabel: actor.email, actorRole: actor.role, action: 'auth.mfa_disabled', ip: input.ip ?? null })
}
