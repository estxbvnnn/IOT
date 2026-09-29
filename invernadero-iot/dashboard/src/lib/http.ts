/** Utilidades HTTP compartidas por las rutas de la API. */

const IP_RE = /^[0-9a-fA-F:.]{2,45}$/

/**
 * IP del cliente, para la bitácora y los limitadores. Detrás de un proxy de confianza llega en
 * X-Forwarded-For; sin proxy ese encabezado lo controla el cliente, así que solo se usa para
 * trazabilidad y limitación de mejor esfuerzo, NUNCA para decidir accesos.
 */
export function clientIp(headers: Headers): string | null {
  const fwd = headers.get('x-forwarded-for')?.split(',')[0]?.trim()
  const raw = fwd || headers.get('x-real-ip')?.trim() || null
  return raw && IP_RE.test(raw) ? raw : null
}

/**
 * Lee el cuerpo como texto sin exceder `maxBytes` (evita que alguien agote la memoria enviando un cuerpo
 * enorme). Devuelve null si se excede.
 */
export async function readTextCapped(req: Request, maxBytes: number): Promise<string | null> {
  const declared = Number(req.headers.get('content-length') ?? '0')
  if (Number.isFinite(declared) && declared > maxBytes) return null
  if (!req.body) return ''
  const reader = req.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > maxBytes) {
      await reader.cancel().catch(() => {})
      return null
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks).toString('utf8')
}

export const NO_STORE = { 'Cache-Control': 'no-store' } as const

export function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return Response.json(body, { status, headers: { ...NO_STORE, ...headers } })
}
