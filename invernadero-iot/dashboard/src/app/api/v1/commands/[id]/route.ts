import { z } from 'zod'
import { getDb } from '@/lib/db'
import { err, handle } from '@/lib/api/v1'
import { jsonResponse } from '@/lib/http'
import { getCommand } from '@/lib/services/commands'

/** GET /api/v1/commands/{id} — estado de una orden (awaiting_confirmation → queued → delivered → executed). */
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export function GET(req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  return handle(req, async ({ actor }) => {
    const { id } = await ctx.params
    if (!z.uuid().safeParse(id).success) return err(404, 'not_found')
    return jsonResponse({ ok: true, command: await getCommand(getDb(), actor, id) })
  })
}
