import 'server-only'
import { cookies, headers } from 'next/headers'
import { getEnv } from '../env'
import { SESSION_COOKIE } from './constants'

/**
 * Cookie de sesión: HttpOnly (JavaScript no puede leerla), SameSite=Lax (no viaja en peticiones
 * cruzadas que cambian datos) y Secure cuando la conexión es HTTPS. Contiene solo un token aleatorio;
 * la sesión y sus permisos viven en la base de datos, así que se pueden revocar al instante.
 */
export async function isSecureRequest(): Promise<boolean> {
  const proto = (await headers()).get('x-forwarded-proto')
  if (proto) return proto.split(',')[0]!.trim() === 'https'
  return getEnv().forceHttps
}

export async function setSessionCookie(token: string, expires: Date): Promise<void> {
  ;(await cookies()).set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: await isSecureRequest(),
    sameSite: 'lax',
    path: '/',
    expires,
  })
}

export async function clearSessionCookie(): Promise<void> {
  ;(await cookies()).delete(SESSION_COOKIE)
}

export async function readSessionToken(): Promise<string | undefined> {
  return (await cookies()).get(SESSION_COOKIE)?.value
}
