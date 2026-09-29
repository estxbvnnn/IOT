import { getDb } from '@/lib/db'
import { clientIp, jsonResponse, readTextCapped } from '@/lib/http'
import { FRAME_MAX_BYTES } from '@/lib/ingest/schema'
import { createLimiter } from '@/lib/rate-limit'
import { handleIngest } from '@/lib/services/ingest'

/**
 * Recepción de telemetría de los nodos — protocolo v1 (docs/contrato-api.md).
 * Autenticación: Authorization: Bearer <token del nodo>. Sin cookies ni sesión de usuario.
 */
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// Tope generoso por origen (varios nodos pueden compartir una misma IP tras un NAT)…
const perIp = createLimiter({ windowMs: 60_000, max: 1200 })
// …y uno estricto para credenciales inválidas, contra adivinación de tokens.
const failuresPerIp = createLimiter({ windowMs: 60_000, max: 30 })

export async function POST(req: Request): Promise<Response> {
  const ip = clientIp(req.headers)
  const key = ip ?? 'sin-ip'

  const general = perIp.hit(key)
  if (!general.ok) return jsonResponse({ ok: false, error: 'rate_limited' }, 429, { 'Retry-After': String(general.retryAfterS) })

  const raw = await readTextCapped(req, FRAME_MAX_BYTES)
  if (raw === null) return jsonResponse({ ok: false, error: 'too_large' }, 413)

  const result = await handleIngest(getDb(), { authorization: req.headers.get('authorization'), rawBody: raw, ip })

  if (result.status === 401) {
    const f = failuresPerIp.hit(key)
    if (!f.ok) return jsonResponse({ ok: false, error: 'rate_limited' }, 429, { 'Retry-After': String(f.retryAfterS) })
  }
  const headers: Record<string, string> = result.status === 429 ? { 'Retry-After': String(result.retryAfterS) } : {}
  return jsonResponse(result.body, result.status, headers)
}
