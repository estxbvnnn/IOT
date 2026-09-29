import { jsonResponse } from '@/lib/http'

/** Prueba de conectividad para los nodos y el monitoreo. No toca la base ni revela información del sistema. */
export const dynamic = 'force-dynamic'

export function GET(): Response {
  return jsonResponse({ ok: true })
}
