import type { Db } from '../db/types'
import { type Actor, isRole } from '../rbac'
import { generateToken, hashToken } from './tokens'

/**
 * Claves de la API REST (/api/v1). Cada clave pertenece a un usuario y actúa con SU rol y alcance: valen exactamente
 * los mismos permisos que en la interfaz. Solo se guarda el SHA-256 (iot.api_keys); la clave en claro se muestra una vez.
 * El súper administrador (cuenta de pruebas que se salta salvaguardas) no puede tener claves.
 */

export const API_KEY_PREFIX = 'iotk_'

/** «Bearer iotk_…» → la clave, o null si el formato no es el de una clave de API. */
export function parseApiKey(header: string | null): string | null {
  if (!header) return null
  const m = /^Bearer\s+(iotk_[A-Za-z0-9_-]{30,100})$/.exec(header.trim())
  return m ? m[1]! : null
}

export interface ApiActor extends Actor {
  keyId: string
}

export type ApiKeyLookup = { ok: true; actor: ApiActor } | { ok: false; reason: 'invalid' | 'forbidden' }

export async function actorFromApiKey(db: Db, key: string, now = new Date()): Promise<ApiKeyLookup> {
  const [row] = await db<{ key_id: string; id: string; email: string; name: string; role: string; is_active: boolean }[]>`
    select k.id as key_id, u.id, u.email, u.name, u.role, u.is_active
      from iot.api_keys k join iot.app_users u on u.id = k.user_id
     where k.token_hash = ${hashToken(key)} and k.revoked_at is null`
  if (!row || !row.is_active) return { ok: false, reason: 'invalid' }
  if (!isRole(row.role) || row.role === 'superadmin') return { ok: false, reason: 'forbidden' }

  let greenhouseIds: number[] = []
  if (row.role === 'operator') {
    const rows = await db<{ greenhouse_id: number }[]>`select greenhouse_id from iot.user_greenhouses where user_id = ${row.id} order by 1`
    greenhouseIds = rows.map((r) => r.greenhouse_id)
  }
  // Marca de último uso, como máximo una vez por minuto (no escribir en cada consulta).
  await db`
    update iot.api_keys set last_used_at = ${now}
     where id = ${row.key_id} and (last_used_at is null or last_used_at < ${new Date(now.getTime() - 60_000)})`.catch(() => undefined)
  return { ok: true, actor: { id: row.id, email: row.email, name: row.name, role: row.role, greenhouseIds, keyId: row.key_id } }
}

/** Crea una clave para un usuario (por correo). Devuelve la clave en claro: es la única vez que existe. */
export async function createApiKey(db: Db, email: string, name: string): Promise<{ key: string; keyId: string; userEmail: string; role: string }> {
  const [u] = await db<{ id: string; email: string; role: string; is_active: boolean }[]>`
    select id, email, role, is_active from iot.app_users where email = ${email.trim().toLowerCase()}`
  if (!u) throw new Error(`No existe el usuario ${email}.`)
  if (!u.is_active) throw new Error(`El usuario ${u.email} está desactivado.`)
  if (u.role === 'superadmin') throw new Error('El súper administrador de pruebas no puede tener claves de API: use un usuario administrador, agrónomo, operador, técnico o dueño.')
  const key = `${API_KEY_PREFIX}${generateToken(32)}`
  const [k] = await db<{ id: string }[]>`
    insert into iot.api_keys (name, user_id, token_hash) values (${name}, ${u.id}, ${hashToken(key)}) returning id`
  return { key, keyId: k!.id, userEmail: u.email, role: u.role }
}

/** Revoca una clave por su id. true si existía y estaba vigente. */
export async function revokeApiKey(db: Db, keyId: string): Promise<boolean> {
  const r = await db`update iot.api_keys set revoked_at = now() where id = ${keyId} and revoked_at is null returning id`
  return r.length > 0
}
