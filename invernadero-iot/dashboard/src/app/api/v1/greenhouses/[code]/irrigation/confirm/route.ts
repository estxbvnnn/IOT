import { z } from 'zod'
import { getDb } from '@/lib/db'
import { err, handle, readJson } from '@/lib/api/v1'
import { jsonResponse } from '@/lib/http'
import { confirmIrrigation } from '@/lib/services/commands'
import { resolveGreenhouse } from '@/lib/services/queries'

/**
 * POST /api/v1/greenhouses/{code}/irrigation/confirm   {"commandId": "<uuid>", "password": "<clave del usuario>"}
 * Paso 2: reingreso de la contraseña del usuario dueño de la clave. Recién aquí la orden queda disponible para el nodo.
 */
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const body = z.object({ commandId: z.uuid(), password: z.string().min(1).max(200) })

export function POST(req: Request, ctx: { params: Promise<{ code: string }> }): Promise<Response> {
  return handle(req, async ({ actor, ip }) => {
    const db = getDb()
    const id = await resolveGreenhouse(db, actor, (await ctx.params).code)
    if (id === null) return err(404, 'not_found')
    const input = await readJson(req, body)
    if (input instanceof Response) return input
    const command = await confirmIrrigation(db, actor, { commandId: input.commandId, password: input.password, ip })
    return jsonResponse({ ok: true, command })
  }, { write: true })
}
