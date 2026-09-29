'use server'

import { redirect } from 'next/navigation'
import { z } from 'zod'
import { safeNextPath } from '@/lib/auth/constants'
import { login, logout } from '@/lib/auth/service'
import { clearSessionCookie, readSessionToken, setSessionCookie } from '@/lib/auth/session'
import { getDb } from '@/lib/db'
import { authConfig, getCurrentUser, getRequestMeta } from '@/lib/dal'
import { createLimiter } from '@/lib/rate-limit'

/**
 * Inicio y cierre de sesión. Defensas contra fuerza bruta, en capas:
 *  1. limitador por IP y por correo (mejor esfuerzo, por instancia);
 *  2. bloqueo de la cuenta tras 5 fallos seguidos (global: vive en la base);
 *  3. mensaje genérico: nunca se dice si el correo existe.
 */
const ipLimiter = createLimiter({ windowMs: 10 * 60_000, max: 40 })
const emailLimiter = createLimiter({ windowMs: 10 * 60_000, max: 12 })

export interface LoginState {
  error?: string
  /** El usuario tiene segundo factor: falta el código de 6 dígitos. */
  needsCode?: boolean
}

const loginSchema = z.object({
  email: z.string().trim().min(3).max(254),
  password: z.string().min(1).max(256),
  totp: z.string().trim().max(12).optional(),
  next: z.string().max(300).optional(),
})

export async function loginAction(_prev: LoginState | null, formData: FormData): Promise<LoginState> {
  const parsed = loginSchema.safeParse({
    email: formData.get('email'),
    password: formData.get('password'),
    totp: formData.get('totp') || undefined,
    next: formData.get('next') || undefined,
  })
  if (!parsed.success) return { error: 'Ingresa tu correo y tu contraseña.' }
  const { email, password, totp, next } = parsed.data

  const meta = await getRequestMeta()
  const byIp = ipLimiter.hit(meta.ip ?? 'sin-ip')
  const byEmail = emailLimiter.hit(email.toLowerCase())
  if (!byIp.ok || !byEmail.ok) {
    const wait = Math.max(byIp.retryAfterS, byEmail.retryAfterS)
    return { error: `Demasiados intentos. Espera ${Math.ceil(wait / 60)} min antes de volver a intentar.` }
  }

  const result = await login(getDb(), authConfig(), { email, password, totp, ip: meta.ip, userAgent: meta.userAgent })
  if (!result.ok) {
    if (result.reason === 'mfa_required') return { needsCode: true }
    if (result.reason === 'mfa_invalid') return { needsCode: true, error: 'El código no es válido o ya fue usado. Espera al siguiente e inténtalo de nuevo.' }
    return { error: 'Correo o contraseña incorrectos, o la cuenta está bloqueada temporalmente.' }
  }

  emailLimiter.reset(email.toLowerCase())
  await setSessionCookie(result.token, result.expiresAt)
  redirect(safeNextPath(next))
}

export async function logoutAction(): Promise<void> {
  const token = await readSessionToken()
  const user = await getCurrentUser()
  const meta = await getRequestMeta()
  if (token) await logout(getDb(), token, user ?? undefined, meta.ip)
  await clearSessionCookie()
  redirect('/login')
}
