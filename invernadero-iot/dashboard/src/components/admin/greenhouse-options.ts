import 'server-only'
import type { Db } from '@/lib/db/types'
import { type Actor, scopeOf } from '@/lib/rbac'

import type { GreenhouseOption } from './greenhouse-options-type'

export type { GreenhouseOption }

/**
 * Invernaderos que el usuario puede ver (para filtros y formularios). El operador solo recibe los
 * sectores que tiene asignados: un operador jamás ve siquiera que existen los demás.
 */
export async function listGreenhouseOptions(db: Db, actor: Pick<Actor, 'role' | 'greenhouseIds'>): Promise<GreenhouseOption[]> {
  const scope = scopeOf(actor)
  const rows = await db<GreenhouseOption[]>`select id, code, name from iot.greenhouses order by id`
  return scope.all ? rows : rows.filter((r) => scope.ids.includes(r.id))
}
