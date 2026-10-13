import { getDb } from '@/lib/db'
import { err, handle, rangeOf } from '@/lib/api/v1'
import { jsonResponse } from '@/lib/http'
import { getGreenhouseSeries, resolveGreenhouse } from '@/lib/services/queries'

/** GET /api/v1/greenhouses/{code}/readings?range=24h — series de temperatura, humedad, suelo y luz (promedios por intervalo; pares [ms, valor]). */
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export function GET(req: Request, ctx: { params: Promise<{ code: string }> }): Promise<Response> {
  return handle(req, async ({ actor }) => {
    const db = getDb()
    const id = await resolveGreenhouse(db, actor, (await ctx.params).code)
    if (id === null) return err(404, 'not_found')
    const range = rangeOf(req)
    const { events: _events, ...series } = await getGreenhouseSeries(db, actor, id, range)
    return jsonResponse({ ok: true, range, ...series })
  })
}
