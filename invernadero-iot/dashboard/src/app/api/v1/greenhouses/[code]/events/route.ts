import { getDb } from '@/lib/db'
import { err, handle, rangeOf } from '@/lib/api/v1'
import { jsonResponse } from '@/lib/http'
import { getGreenhouseSeries, resolveGreenhouse } from '@/lib/services/queries'

/** GET /api/v1/greenhouses/{code}/events?range=7d — riegos del periodo (inicio, fin, duración, motivo, agua). */
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export function GET(req: Request, ctx: { params: Promise<{ code: string }> }): Promise<Response> {
  return handle(req, async ({ actor }) => {
    const db = getDb()
    const id = await resolveGreenhouse(db, actor, (await ctx.params).code)
    if (id === null) return err(404, 'not_found')
    const range = rangeOf(req)
    return jsonResponse({ ok: true, range, events: (await getGreenhouseSeries(db, actor, id, range)).events })
  })
}
