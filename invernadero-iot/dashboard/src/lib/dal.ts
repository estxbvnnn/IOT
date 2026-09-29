import 'server-only'
import { cache } from 'react'
import { headers } from 'next/headers'
import { notFound, redirect } from 'next/navigation'
import { getSessionUser, type AuthConfig, type SessionUser } from './auth/service'
import { readSessionToken } from './auth/session'
import { getDb } from './db'
import { getEnv } from './env'
import { clientIp } from './http'
import { type Permission, can } from './rbac'

/**
 * Capa de acceso a datos (DAL): el ÚNICO camino para saber quién está usando el sistema.
 *
 * Regla: cada página, acción y ruta llama a `requireUser()` o `requirePermission()` por su cuenta.
 * No basta con verificar en el layout: en el App Router los layouts no se vuelven a ejecutar al
 * navegar entre páginas, y las acciones del servidor se pueden invocar directamente.
 */

export function authConfig(): AuthConfig {
  const env = getEnv()
  return { appSecret: env.appSecret, mfaRequiredRoles: env.mfaRequiredRoles }
}

/** Usuario de la sesión actual (memorizado por petición: varias llamadas = una sola consulta). */
export const getCurrentUser = cache(async (): Promise<SessionUser | null> => {
  const token = await readSessionToken()
  if (!token) return null
  return getSessionUser(getDb(), authConfig(), token)
})

export interface RequireOptions {
  /** Permite entrar aunque falte registrar el 2FA o cambiar la contraseña (solo la página de cuenta). */
  allowRestricted?: boolean
}

export async function requireUser(opts: RequireOptions = {}): Promise<SessionUser> {
  const user = await getCurrentUser()
  if (!user) redirect('/login')
  if (!opts.allowRestricted) {
    if (user.mustEnrollMfa) redirect('/account?motivo=mfa')
    if (user.mustChangePassword) redirect('/account?motivo=clave')
  }
  return user
}

/** Como requireUser, y además exige el permiso. Sin permiso responde 404 (no revela que la página existe). */
export async function requirePermission(permission: Permission, opts: RequireOptions = {}): Promise<SessionUser> {
  const user = await requireUser(opts)
  if (!can(user.role, permission)) notFound()
  return user
}

export interface RequestMeta {
  ip: string | null
  userAgent: string | null
}

export async function getRequestMeta(): Promise<RequestMeta> {
  const h = await headers()
  return { ip: clientIp(h), userAgent: h.get('user-agent')?.slice(0, 200) ?? null }
}
