import { describe, expect, it } from 'vitest'
import {
  AuthError, LOCK_MINUTES, LOCK_THRESHOLD, SESSION_ABSOLUTE_S, SESSION_IDLE_S, beginTotpEnrollment, changePassword,
  confirmTotpEnrollment, disableTotp, getSessionUser, login, logout, revokeSessions,
} from '@/lib/auth/service'
import { hashToken } from '@/lib/auth/tokens'
import { totpAt } from '@/lib/auth/totp'
import { AUTH_CFG, T0, inRollback, makeUser, plus } from './helpers'

const IP = '198.51.100.7'
const attempt = (tx: Parameters<typeof login>[0], email: string, password: string, now: Date, totp?: string) =>
  login(tx, AUTH_CFG, { email, password, totp, ip: IP, userAgent: 'vitest', now })

describe('inicio de sesión', () => {
  it('inicia sesión, crea una sesión revocable y registra la bitácora', async () => {
    await inRollback(async (tx) => {
      const u = await makeUser(tx, 'operator', { greenhouseIds: [2, 5] })
      const r = await attempt(tx, u.email, u.password, T0)
      expect(r.ok).toBe(true)
      if (!r.ok) return
      expect(r.user).toMatchObject({ role: 'operator', greenhouseIds: [2, 5], hasTotp: false, mustEnrollMfa: false })
      // En la base solo está el SHA-256 del token, nunca el token.
      const rows = await tx<{ n: number }[]>`select count(*)::int as n from iot.sessions where id = ${hashToken(r.token)}`
      expect(rows[0]!.n).toBe(1)
      const leak = await tx`select 1 from iot.sessions where encode(id, 'escape') like ${`%${r.token.slice(0, 10)}%`}`
      expect(leak).toHaveLength(0)
      const audit = await tx<{ action: string }[]>`select action from iot.audit_log where actor_id = ${u.id} order by id`
      expect(audit.map((a) => a.action)).toContain('auth.login')
      const session = await getSessionUser(tx, AUTH_CFG, r.token, plus(T0, 10))
      expect(session).toMatchObject({ id: u.id, email: u.email, role: 'operator', greenhouseIds: [2, 5] })
    })
  })

  it('el correo no distingue mayúsculas ni espacios', async () => {
    await inRollback(async (tx) => {
      const u = await makeUser(tx, 'owner')
      const r = await attempt(tx, `  ${u.email.toUpperCase()}  `, u.password, T0)
      expect(r.ok).toBe(true)
    })
  })

  it('contraseña errónea, usuario inexistente y cuenta inactiva dan el MISMO resultado genérico', async () => {
    await inRollback(async (tx) => {
      const u = await makeUser(tx, 'technician')
      const bad = await attempt(tx, u.email, 'no-es-la-clave-123', T0)
      const ghost = await attempt(tx, 'no-existe@invernadero.local', 'lo-que-sea-1234', T0)
      await tx`update iot.app_users set is_active = false where id = ${u.id}`
      const inactive = await attempt(tx, u.email, u.password, plus(T0, 1))
      expect(bad).toEqual({ ok: false, reason: 'invalid' })
      expect(ghost).toEqual({ ok: false, reason: 'invalid' })
      expect(inactive).toEqual({ ok: false, reason: 'invalid' })
      const labels = await tx<{ reason: string }[]>`select detail->>'reason' as reason from iot.audit_log where action = 'auth.login_failed' order by id desc limit 3`
      expect(labels.map((l) => l.reason).sort()).toEqual(['bad_password', 'inactive', 'unknown_user'])
    })
  })

  it(`se bloquea ${LOCK_MINUTES} min tras ${LOCK_THRESHOLD} fallos seguidos (incluso con la clave correcta) y luego se libera`, async () => {
    await inRollback(async (tx) => {
      const u = await makeUser(tx, 'agronomist')
      for (let i = 0; i < LOCK_THRESHOLD; i++) expect((await attempt(tx, u.email, `mala-${i}-clave-xxx`, plus(T0, i))).ok).toBe(false)
      const during = await attempt(tx, u.email, u.password, plus(T0, 60))
      expect(during).toEqual({ ok: false, reason: 'invalid' }) // clave correcta, pero bloqueada
      const [row] = await tx<{ locked_until: Date }[]>`select locked_until from iot.app_users where id = ${u.id}`
      expect(row!.locked_until.getTime()).toBeGreaterThan(plus(T0, 60).getTime())
      const after = await attempt(tx, u.email, u.password, plus(T0, LOCK_MINUTES * 60 + 60))
      expect(after.ok).toBe(true)
      const [reset] = await tx<{ failed_logins: number }[]>`select failed_logins from iot.app_users where id = ${u.id}`
      expect(reset!.failed_logins).toBe(0)
    })
  })
})

describe('sesiones: vencimiento por inactividad según el rol', () => {
  it('el administrador vence a los 30 min de inactividad; el operador (8 h) sigue vigente', async () => {
    await inRollback(async (tx) => {
      expect(SESSION_IDLE_S.admin).toBe(30 * 60)
      const admin = await makeUser(tx, 'admin')
      const op = await makeUser(tx, 'operator', { greenhouseIds: [1] })
      const a = await attempt(tx, admin.email, admin.password, T0)
      const o = await attempt(tx, op.email, op.password, T0)
      if (!a.ok || !o.ok) throw new Error('login')
      expect(await getSessionUser(tx, AUTH_CFG, a.token, plus(T0, 29 * 60))).not.toBeNull() // renueva la actividad
      expect(await getSessionUser(tx, AUTH_CFG, a.token, plus(T0, 29 * 60 + 31 * 60))).toBeNull() // 31 min sin actividad
      expect(await getSessionUser(tx, AUTH_CFG, o.token, plus(T0, 31 * 60))).not.toBeNull()
      // La sesión vencida se elimina de la base.
      const gone = await tx`select 1 from iot.sessions where id = ${hashToken(a.token)}`
      expect(gone).toHaveLength(0)
    })
  })

  it('cualquier sesión vence en forma absoluta a las 12 h, aunque haya actividad', async () => {
    await inRollback(async (tx) => {
      const op = await makeUser(tx, 'operator', { greenhouseIds: [1] })
      const o = await attempt(tx, op.email, op.password, T0)
      if (!o.ok) throw new Error('login')
      for (let h = 1; h < 12; h++) expect(await getSessionUser(tx, AUTH_CFG, o.token, plus(T0, h * 3600))).not.toBeNull()
      expect(await getSessionUser(tx, AUTH_CFG, o.token, plus(T0, SESSION_ABSOLUTE_S + 60))).toBeNull()
    })
  })

  it('rechaza tokens inventados o con formato inválido, y cuentas desactivadas', async () => {
    await inRollback(async (tx) => {
      expect(await getSessionUser(tx, AUTH_CFG, 'x'.repeat(43), T0)).toBeNull()
      expect(await getSessionUser(tx, AUTH_CFG, "'; drop table iot.sessions;--", T0)).toBeNull()
      const u = await makeUser(tx, 'owner')
      const r = await attempt(tx, u.email, u.password, T0)
      if (!r.ok) throw new Error('login')
      await tx`update iot.app_users set is_active = false where id = ${u.id}`
      expect(await getSessionUser(tx, AUTH_CFG, r.token, plus(T0, 5))).toBeNull()
    })
  })

  it('cerrar sesión la elimina y deja constancia', async () => {
    await inRollback(async (tx) => {
      const u = await makeUser(tx, 'owner')
      const r = await attempt(tx, u.email, u.password, T0)
      if (!r.ok) throw new Error('login')
      await logout(tx, r.token, u.actor, IP)
      expect(await getSessionUser(tx, AUTH_CFG, r.token, plus(T0, 5))).toBeNull()
      const a = await tx<{ action: string }[]>`select action from iot.audit_log where actor_id = ${u.id} order by id desc limit 1`
      expect(a[0]!.action).toBe('auth.logout')
    })
  })
})

describe('cambio de contraseña', () => {
  it('exige la actual, aplica la política y cierra las demás sesiones (conserva la actual)', async () => {
    await inRollback(async (tx) => {
      const u = await makeUser(tx, 'agronomist')
      const s1 = await attempt(tx, u.email, u.password, T0)
      const s2 = await attempt(tx, u.email, u.password, plus(T0, 5))
      if (!s1.ok || !s2.ok) throw new Error('login')
      await expect(changePassword(tx, u.actor, { current: 'equivocada-12345', next: 'Nueva-Clave-Segura-77', keepToken: s1.token })).rejects.toMatchObject({ field: 'current' })
      await expect(changePassword(tx, u.actor, { current: u.password, next: 'corta1', keepToken: s1.token })).rejects.toBeInstanceOf(AuthError)
      await expect(changePassword(tx, u.actor, { current: u.password, next: u.password, keepToken: s1.token })).rejects.toMatchObject({ field: 'next' })
      await changePassword(tx, u.actor, { current: u.password, next: 'Nueva-Clave-Segura-77', keepToken: s1.token })
      expect(await getSessionUser(tx, AUTH_CFG, s1.token, plus(T0, 20))).not.toBeNull()
      expect(await getSessionUser(tx, AUTH_CFG, s2.token, plus(T0, 20))).toBeNull()
      expect((await attempt(tx, u.email, u.password, plus(T0, 30))).ok).toBe(false)
      expect((await attempt(tx, u.email, 'Nueva-Clave-Segura-77', plus(T0, 31))).ok).toBe(true)
    })
  })
})

describe('segundo factor (TOTP)', () => {
  it('registro en dos fases, inicio de sesión con código y protección contra reutilización', async () => {
    await inRollback(async (tx) => {
      const u = await makeUser(tx, 'admin')
      const first = await attempt(tx, u.email, u.password, T0)
      if (!first.ok) throw new Error('login')

      const enroll = beginTotpEnrollment(AUTH_CFG, u.actor, T0)
      expect(enroll.uri).toContain('otpauth://totp/')
      // Aún no está activo: la semilla no se guardó.
      const [before] = await tx<{ enc: string | null }[]>`select totp_secret_enc as enc from iot.app_users where id = ${u.id}`
      expect(before!.enc).toBeNull()
      // Código incorrecto → no se activa.
      await expect(confirmTotpEnrollment(tx, AUTH_CFG, u.actor, { enrollToken: enroll.enrollToken, code: '000000' }, T0)).rejects.toMatchObject({ field: 'code' })
      // Un token de registro ajeno (de otro usuario) no sirve.
      const other = await makeUser(tx, 'owner')
      await expect(confirmTotpEnrollment(tx, AUTH_CFG, other.actor, { enrollToken: enroll.enrollToken, code: totpAt(enroll.secret, T0.getTime()) }, T0)).rejects.toBeInstanceOf(AuthError)
      // Vencido (10 min).
      await expect(confirmTotpEnrollment(tx, AUTH_CFG, u.actor, { enrollToken: enroll.enrollToken, code: totpAt(enroll.secret, plus(T0, 700).getTime()) }, plus(T0, 700))).rejects.toBeInstanceOf(AuthError)
      // Correcto.
      await confirmTotpEnrollment(tx, AUTH_CFG, u.actor, { enrollToken: enroll.enrollToken, code: totpAt(enroll.secret, T0.getTime()), sessionToken: first.token }, T0)
      const [after] = await tx<{ enc: string | null }[]>`select totp_secret_enc as enc from iot.app_users where id = ${u.id}`
      expect(after!.enc).not.toBeNull()
      expect(after!.enc).not.toContain(enroll.secret) // cifrada en reposo

      // Sin código → se pide el segundo factor y NO se crea sesión.
      const sessionsBefore = await tx<{ n: number }[]>`select count(*)::int as n from iot.sessions where user_id = ${u.id}`
      expect(await attempt(tx, u.email, u.password, plus(T0, 60))).toEqual({ ok: false, reason: 'mfa_required' })
      expect((await tx<{ n: number }[]>`select count(*)::int as n from iot.sessions where user_id = ${u.id}`)[0]!.n).toBe(sessionsBefore[0]!.n)
      // Código equivocado.
      expect(await attempt(tx, u.email, u.password, plus(T0, 90), '123456')).toEqual({ ok: false, reason: 'mfa_invalid' })
      // Código correcto de un paso posterior al del registro.
      const t2 = plus(T0, 120)
      const good = await attempt(tx, u.email, u.password, t2, totpAt(enroll.secret, t2.getTime()))
      expect(good.ok).toBe(true)
      if (good.ok) expect(good.user.hasTotp).toBe(true)
      // El mismo código no se puede usar dos veces (anti-repetición).
      const replay = await attempt(tx, u.email, u.password, plus(t2, 5), totpAt(enroll.secret, t2.getTime()))
      expect(replay).toEqual({ ok: false, reason: 'mfa_invalid' })
    })
  })

  it('la política puede exigir 2FA a ciertos roles: el usuario debe registrarlo y no puede desactivarlo', async () => {
    await inRollback(async (tx) => {
      const cfg = { ...AUTH_CFG, mfaRequiredRoles: new Set(['admin']) }
      const admin = await makeUser(tx, 'admin')
      const op = await makeUser(tx, 'operator', { greenhouseIds: [1] })
      const a = await login(tx, cfg, { email: admin.email, password: admin.password, ip: IP, userAgent: null, now: T0 })
      const o = await login(tx, cfg, { email: op.email, password: op.password, ip: IP, userAgent: null, now: T0 })
      if (!a.ok || !o.ok) throw new Error('login')
      expect(a.user).toMatchObject({ mfaRequired: true, hasTotp: false, mustEnrollMfa: true })
      expect(o.user).toMatchObject({ mfaRequired: false, mustEnrollMfa: false })
      const enroll = beginTotpEnrollment(cfg, admin.actor, T0)
      await confirmTotpEnrollment(tx, cfg, admin.actor, { enrollToken: enroll.enrollToken, code: totpAt(enroll.secret, T0.getTime()) }, T0)
      await expect(disableTotp(tx, cfg, admin.actor, { password: admin.password })).rejects.toBeInstanceOf(AuthError)
    })
  })

  it('un usuario sin exigencia puede desactivar su 2FA confirmando la contraseña', async () => {
    await inRollback(async (tx) => {
      const u = await makeUser(tx, 'owner')
      const enroll = beginTotpEnrollment(AUTH_CFG, u.actor, T0)
      await confirmTotpEnrollment(tx, AUTH_CFG, u.actor, { enrollToken: enroll.enrollToken, code: totpAt(enroll.secret, T0.getTime()) }, T0)
      await expect(disableTotp(tx, AUTH_CFG, u.actor, { password: 'incorrecta-123456' })).rejects.toMatchObject({ field: 'password' })
      await disableTotp(tx, AUTH_CFG, u.actor, { password: u.password })
      const r = await attempt(tx, u.email, u.password, plus(T0, 100))
      expect(r.ok).toBe(true)
    })
  })

  it('revocar sesiones cierra todas', async () => {
    await inRollback(async (tx) => {
      const u = await makeUser(tx, 'owner')
      const a = await attempt(tx, u.email, u.password, T0)
      const b = await attempt(tx, u.email, u.password, plus(T0, 1))
      if (!a.ok || !b.ok) throw new Error('login')
      await revokeSessions(tx, u.id)
      expect(await getSessionUser(tx, AUTH_CFG, a.token, plus(T0, 5))).toBeNull()
      expect(await getSessionUser(tx, AUTH_CFG, b.token, plus(T0, 5))).toBeNull()
    })
  })
})
