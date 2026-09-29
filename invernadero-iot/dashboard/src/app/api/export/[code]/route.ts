import { getDb } from '@/lib/db'
import { getCurrentUser, getRequestMeta } from '@/lib/dal'
import { NO_STORE, jsonResponse } from '@/lib/http'
import { RANGE_SPECS, isRangeKey } from '@/lib/domain/types'
import { ForbiddenError } from '@/lib/rbac'
import { audit } from '@/lib/services/audit'
import { exportReadingsCsv, resolveGreenhouse } from '@/lib/services/queries'

/**
 * Exportación del historial de un invernadero en CSV (permiso export:csv, con alcance por sector).
 * GET /api/export/I3?range=24h|7d|30d
 */
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(req: Request, ctx: { params: Promise<{ code: string }> }): Promise<Response> {
  const user = await getCurrentUser()
  if (!user) return jsonResponse({ ok: false, error: 'unauthorized' }, 401)
  const { code } = await ctx.params
  const rangeParam = new URL(req.url).searchParams.get('range') ?? '24h'
  const range = isRangeKey(rangeParam) ? rangeParam : '24h'

  const db = getDb()
  const id = await resolveGreenhouse(db, user, code)
  if (id === null) return jsonResponse({ ok: false, error: 'not_found' }, 404)
  try {
    const to = new Date()
    const csv = await exportReadingsCsv(db, user, id, new Date(to.getTime() - RANGE_SPECS[range].ms), to)
    const meta = await getRequestMeta()
    await audit(db, {
      actorId: user.id, actorLabel: user.email, actorRole: user.role, action: 'data.export',
      target: `greenhouse:${id}`, detail: { code, range, bytes: csv.length }, ip: meta.ip,
    })
    return new Response(csv, {
      headers: {
        ...NO_STORE,
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="${code}-${range}.csv"`,
      },
    })
  } catch (e) {
    if (e instanceof ForbiddenError) return jsonResponse({ ok: false, error: 'forbidden' }, 403)
    console.error('[api/export] error:', e)
    return jsonResponse({ ok: false, error: 'internal' }, 500)
  }
}
