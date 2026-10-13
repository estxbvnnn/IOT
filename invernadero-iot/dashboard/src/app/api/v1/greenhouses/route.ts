import { getDb } from '@/lib/db'
import { handle } from '@/lib/api/v1'
import { jsonResponse } from '@/lib/http'
import { getSiteOverview } from '@/lib/services/queries'

/** GET /api/v1/greenhouses — resumen del predio: KPIs, viento, alertas recientes y el estado de cada invernadero (docs/api-v1.md). */
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export function GET(req: Request): Promise<Response> {
  return handle(req, async ({ actor }) => jsonResponse({ ok: true, ...(await getSiteOverview(getDb(), actor)) }))
}
