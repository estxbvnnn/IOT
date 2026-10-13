import { z } from 'zod'
import { getDb } from '@/lib/db'
import { err, handle, readJson } from '@/lib/api/v1'
import { jsonResponse } from '@/lib/http'
import { requestIrrigation } from '@/lib/services/commands'
import { resolveGreenhouse } from '@/lib/services/queries'

/**
 * POST /api/v1/greenhouses/{code}/irrigation   {"durationS": 30}
 * Paso 1 del riego manual: registra la solicitud (NO activa la bomba). Devuelve la orden en «awaiting_confirmation»;
 * hay que confirmarla con POST …/irrigation/confirm dentro de la ventana de confirmación.
 */
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const body = z.object({ durationS: z.number().int() })

export function POST(req: Request, ctx: { params: Promise<{ code: string }> }): Promise<Response> {
  return handle(req, async ({ actor, ip }) => {
    const db = getDb()
    const id = await resolveGreenhouse(db, actor, (await ctx.params).code)
    if (id === null) return err(404, 'not_found')
    const input = await readJson(req, body)
    if (input instanceof Response) return input
    return jsonResponse({ ok: true, command: await requestIrrigation(db, actor, { greenhouseId: id, durationS: input.durationS, ip }) }, 201)
  }, { write: true })
}
