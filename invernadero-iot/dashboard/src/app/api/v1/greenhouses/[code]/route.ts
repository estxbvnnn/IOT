import { getDb } from '@/lib/db'
import { err, handle, rangeOf } from '@/lib/api/v1'
import { jsonResponse } from '@/lib/http'
import { getGreenhouseDetail, resolveGreenhouse } from '@/lib/services/queries'

/** GET /api/v1/greenhouses/{code}?range=1h|6h|24h|7d|30d — estado actual, umbrales, alertas y series de un invernadero. */
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export function GET(req: Request, ctx: { params: Promise<{ code: string }> }): Promise<Response> {
  return handle(req, async ({ actor }) => {
    const db = getDb()
    const id = await resolveGreenhouse(db, actor, (await ctx.params).code)
    if (id === null) return err(404, 'not_found')
    const { summary, series, alerts, range } = await getGreenhouseDetail(db, actor, id, rangeOf(req))
    return jsonResponse({ ok: true, range, summary, alerts, series })
  })
}
