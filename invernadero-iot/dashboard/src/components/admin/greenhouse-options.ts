import 'server-only'
import type { Db } from '@/lib/db/types'
import { type Actor, scopeOf } from '@/lib/rbac'

import type { GreenhouseOption } from './greenhouse-options-type'

export type { GreenhouseOption }

/**
 * Invernaderos que el usuario puede ver (para filtros y formularios). El operador solo recibe los
 * sectores que tiene asignados: un operador jamás ve siquiera que existen los demás.
 *
 * Los dados de baja NO se ofrecen, salvo `includeArchived` (solo para mostrar el código de una asignación
 * antigua en la lista de usuarios).
 */
export async function listGreenhouseOptions(
  db: Db,
  actor: Pick<Actor, 'role' | 'greenhouseIds'>,
  opts: { includeArchived?: boolean } = {},
): Promise<GreenhouseOption[]> {
  const scope = scopeOf(actor)
  const includeArchived = opts.includeArchived === true
  const rows = await db<GreenhouseOption[]>`
    select id, code, name, (archived_at is not null) as archived
      from iot.greenhouses
     where (${includeArchived}::boolean or archived_at is null)
     order by id`
  return scope.all ? rows : rows.filter((r) => scope.ids.includes(r.id))
}
