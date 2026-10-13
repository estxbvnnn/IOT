import { getDb } from '@/lib/db'
import { err, handle } from '@/lib/api/v1'
import { jsonResponse } from '@/lib/http'
import { requestStop } from '@/lib/services/commands'
import { resolveGreenhouse } from '@/lib/services/queries'

/** POST /api/v1/greenhouses/{code}/stop — detiene la bomba (un solo paso, a propósito: apagar reduce el riesgo). */
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export function POST(req: Request, ctx: { params: Promise<{ code: string }> }): Promise<Response> {
  return handle(req, async ({ actor, ip }) => {
    const db = getDb()
    const id = await resolveGreenhouse(db, actor, (await ctx.params).code)
    if (id === null) return err(404, 'not_found')
    return jsonResponse({ ok: true, command: await requestStop(db, actor, { greenhouseId: id, ip }) }, 201)
  }, { write: true })
}
