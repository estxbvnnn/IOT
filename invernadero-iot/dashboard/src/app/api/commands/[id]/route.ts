import { z } from 'zod'
import { getDb } from '@/lib/db'
import { getCurrentUser } from '@/lib/dal'
import { jsonResponse } from '@/lib/http'
import { CommandError, getCommand } from '@/lib/services/commands'

/**
 * Estado de una orden de riego, para que la interfaz siga su avance (confirmada → entregada → ejecutada).
 * Requiere sesión; solo devuelve órdenes de sectores a los que el usuario tiene alcance.
 */
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const user = await getCurrentUser()
  if (!user) return jsonResponse({ ok: false, error: 'unauthorized' }, 401)
  const { id } = await ctx.params
  if (!z.uuid().safeParse(id).success) return jsonResponse({ ok: false, error: 'not_found' }, 404)
  try {
    return jsonResponse({ ok: true, command: await getCommand(getDb(), user, id) })
  } catch (e) {
    if (e instanceof CommandError) return jsonResponse({ ok: false, error: e.code }, e.code === 'not_found' ? 404 : 403)
    console.error('[api/commands] error:', e)
    return jsonResponse({ ok: false, error: 'internal' }, 500)
  }
}
