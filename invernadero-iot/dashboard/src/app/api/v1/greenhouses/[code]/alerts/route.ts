import { getDb } from '@/lib/db'
import { err, handle } from '@/lib/api/v1'
import { jsonResponse } from '@/lib/http'
import { can } from '@/lib/rbac'
import { listAlerts } from '@/lib/services/alerts'
import { resolveGreenhouse } from '@/lib/services/queries'

/** GET /api/v1/greenhouses/{code}/alerts?state=active|resolved|all — alertas del invernadero (por defecto, las activas). */
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export function GET(req: Request, ctx: { params: Promise<{ code: string }> }): Promise<Response> {
  return handle(req, async ({ actor }) => {
    const db = getDb()
    const id = await resolveGreenhouse(db, actor, (await ctx.params).code)
    if (id === null || !can(actor.role, 'alerts:view')) return err(404, 'not_found')
    const s = new URL(req.url).searchParams.get('state')
    const state = s === 'resolved' || s === 'all' ? s : 'active'
    return jsonResponse({ ok: true, state, alerts: await listAlerts(db, actor, { greenhouseId: id, state, limit: 100 }) })
  })
}
