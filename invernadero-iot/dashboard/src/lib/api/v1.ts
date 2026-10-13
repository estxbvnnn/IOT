import 'server-only'
import { z } from 'zod'
import { actorFromApiKey, parseApiKey } from '../auth/api-key'
import { getCurrentUser } from '../dal'
import { getDb } from '../db'
import { clientIp, jsonResponse } from '../http'
import { createLimiter } from '../rate-limit'
import { isRangeKey, type RangeKey } from '../domain/types'
import { type Actor, ForbiddenError } from '../rbac'
import { CommandError, type CommandErrorCode } from '../services/commands'

/**
 * Utilidades comunes de la API REST /api/v1 (documentada en docs/api-v1.md).
 *
 * Autenticación (una de dos):
 *   - `Authorization: Bearer iotk_…`  clave de API de un usuario (se crea con `npm run api:key`); actúa con el rol y alcance de ese usuario.
 *   - la cookie de sesión del dashboard (para que la propia interfaz pueda consumir la API).
 * Las peticiones que cambian algo (POST) deben llevar `Content-Type: application/json`: así un sitio ajeno no puede
 * dispararlas con un formulario aprovechando la cookie de sesión.
 */

// Tope general por origen y otro estricto para credenciales inválidas (adivinación de claves).
const perIp = createLimiter({ windowMs: 60_000, max: 600 })
const failuresPerIp = createLimiter({ windowMs: 60_000, max: 20 })

export const err = (status: number, error: string, extra: Record<string, unknown> = {}, headers: Record<string, string> = {}): Response =>
  jsonResponse({ ok: false, error, ...extra }, status, headers)

export type ApiContext = { actor: Actor; via: 'key' | 'session'; ip: string | null }

/** Identifica quién llama. Devuelve el contexto o la respuesta de error que corresponda (401/429). */
export async function authenticate(req: Request): Promise<ApiContext | Response> {
  const ip = clientIp(req.headers)
  const key = ip ?? 'sin-ip'
  const general = perIp.hit(key)
  if (!general.ok) return err(429, 'rate_limited', {}, { 'Retry-After': String(general.retryAfterS) })

  const auth = req.headers.get('authorization')
  if (auth) {
    const k = parseApiKey(auth)
    const found = k ? await actorFromApiKey(getDb(), k) : ({ ok: false, reason: 'invalid' } as const)
    if (!found.ok) {
      const f = failuresPerIp.hit(key)
      if (!f.ok) return err(429, 'rate_limited', {}, { 'Retry-After': String(f.retryAfterS) })
      return found.reason === 'forbidden' ? err(403, 'forbidden') : err(401, 'unauthorized')
    }
    return { actor: found.actor, via: 'key', ip }
  }

  const user = await getCurrentUser()
  if (!user || user.mustEnrollMfa || user.mustChangePassword) return err(401, 'unauthorized')
  return { actor: user, via: 'session', ip }
}

const COMMAND_STATUS: Record<CommandErrorCode, number> = {
  forbidden: 403, not_found: 404, busy: 409, invalid: 400, expired: 410, auth: 401, locked: 429, no_node: 409,
}

/** Ejecuta un manejador autenticado y traduce los errores conocidos a respuestas JSON. */
export async function handle(
  req: Request,
  fn: (ctx: ApiContext) => Promise<Response>,
  opts: { write?: boolean } = {},
): Promise<Response> {
  try {
    if (opts.write && !(req.headers.get('content-type') ?? '').toLowerCase().startsWith('application/json')) {
      return err(415, 'content_type_json_required')
    }
    const ctx = await authenticate(req)
    if (ctx instanceof Response) return ctx
    return await fn(ctx)
  } catch (e) {
    if (e instanceof ForbiddenError) return err(403, 'forbidden')
    if (e instanceof CommandError) return err(COMMAND_STATUS[e.code], e.code, { mensaje: e.message })
    console.error('[api/v1] error:', e)
    return err(500, 'internal')
  }
}

/** Rango pedido en `?range=` (por defecto 24 h). */
export function rangeOf(req: Request): RangeKey {
  const r = new URL(req.url).searchParams.get('range')
  return isRangeKey(r) ? r : '24h'
}

/** Lee y valida el cuerpo JSON con zod. Devuelve los datos o la respuesta 400/413. */
export async function readJson<T extends z.ZodType>(req: Request, schema: T): Promise<z.infer<T> | Response> {
  const text = await req.text()
  if (text.length > 4096) return err(413, 'too_large')
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    return err(400, 'invalid', { detalle: ['JSON inválido'] })
  }
  const parsed = schema.safeParse(data)
  if (!parsed.success) {
    return err(400, 'invalid', { detalle: parsed.error.issues.slice(0, 6).map((i) => `${i.path.join('.') || 'cuerpo'}: ${i.message}`) })
  }
  return parsed.data
}
