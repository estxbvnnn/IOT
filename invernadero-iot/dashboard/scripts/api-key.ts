/**
 * Claves de la API REST (/api/v1). Cada clave pertenece a un usuario y actúa con su rol y alcance.
 *
 *   npm run api:key -- crear <correo-del-usuario> <nombre-de-la-clave>
 *   npm run api:key -- listar
 *   npm run api:key -- revocar <id-de-la-clave>
 *
 * La clave en claro se muestra UNA sola vez (en la base solo queda su SHA-256).
 * Con Docker en la Raspberry Pi:  docker compose exec dashboard node --import tsx scripts/api-key.ts crear admin@predio.local "Mi app"
 */
import { createApiKey, revokeApiKey } from '../src/lib/auth/api-key'
import { appDb } from './lib/scriptenv'

async function main(): Promise<void> {
  const [cmd, a, b] = process.argv.slice(2)
  const db = appDb(1)
  try {
    if (cmd === 'crear' && a && b) {
      const r = await createApiKey(db, a, b)
      console.log(`Clave creada para ${r.userEmail} (rol ${r.role}), id ${r.keyId}\n`)
      console.log(`  ${r.key}\n`)
      console.log('Guárdela ahora: no se vuelve a mostrar. Uso:  curl -H "Authorization: Bearer <clave>" http://IP_DE_LA_PI:3000/api/v1/greenhouses')
    } else if (cmd === 'listar') {
      const rows = await db<{ id: string; name: string; email: string; role: string; created_at: Date; last_used_at: Date | null; revoked_at: Date | null }[]>`
        select k.id, k.name, u.email, u.role, k.created_at, k.last_used_at, k.revoked_at
          from iot.api_keys k join iot.app_users u on u.id = k.user_id order by k.created_at`
      if (rows.length === 0) console.log('No hay claves de API.')
      for (const r of rows) {
        console.log(`${r.id}  ${r.revoked_at ? 'REVOCADA' : 'vigente '}  ${r.name}  (${r.email}, ${r.role})  último uso: ${r.last_used_at?.toISOString() ?? 'nunca'}`)
      }
    } else if (cmd === 'revocar' && a) {
      console.log((await revokeApiKey(db, a)) ? `Clave ${a} revocada.` : `No hay una clave vigente con id ${a}.`)
    } else {
      console.log('Uso: api:key -- crear <correo> <nombre> | listar | revocar <id>')
      process.exitCode = 1
    }
  } finally {
    await db.end({ timeout: 5 })
  }
}

main().catch((e: Error) => {
  console.error(`✗ ${e.message}`)
  process.exit(1)
})
