/**
 * Arranque inicial de la Raspberry Pi: trae de Supabase a la base LOCAL todo lo que ya existe (usuarios, invernaderos, nodos con
 * su token, historial). Se ejecuta UNA vez, después de aplicar las migraciones locales y antes de activar el servicio «sync».
 *
 *   npm run sync:bootstrap            (falla si la base local ya tiene datos)
 *   npm run sync:bootstrap -- --force (reemplaza lo local por lo de Supabase)
 *
 * Variables: SUPABASE_DB_* (rol iot_app de Supabase; solo lectura aquí) y, para la base local, DATABASE_HOST / DATABASE_PORT /
 * DATABASE_NAME / DATABASE_SSL_MODE más DATABASE_ADMIN_USER / DATABASE_ADMIN_PASSWORD (administrador local: necesita desactivar
 * triggers para conservar los hashes de la bitácora).
 */
import { adminDb, loadEnvFiles, supabaseDb } from './lib/scriptenv'
import { bootstrapFromRemote } from './lib/bootstrap-core'

async function main(): Promise<void> {
  loadEnvFiles('.env.supabase', '.env.local', '.env.admin.local')
  const local = adminDb(1)
  const remote = supabaseDb(1)
  try {
    const r = await bootstrapFromRemote(remote, local, { force: process.argv.includes('--force'), log: console.log })
    console.log(`✓ Listo: ${Object.values(r.copied).reduce((a, b) => a + b, 0)} filas copiadas. Ya puede activar el servicio «sync».`)
  } finally {
    await Promise.all([local.end({ timeout: 5 }), remote.end({ timeout: 5 })])
  }
}

main().catch((e: Error) => {
  console.error(`✗ ${e.message}`)
  process.exit(1)
})
