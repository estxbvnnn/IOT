/**
 * Política de retención del informe (tabla 12, «Almacenamiento»): los datos crudos se conservan 90 días y
 * después solo se guardan promedios horarios (mínimo 12 meses de historial).
 *
 *   npm run db:retention              → agrega a promedios horarios y borra lo crudo con más de 90 días
 *   npm run db:retention -- --days 30 → otra ventana
 *
 * Lo ejecuta el rol administrador (la aplicación no puede borrar telemetría). Para automatizarlo en
 * Supabase se puede activar la extensión pg_cron y programar:
 *   select cron.schedule('retencion-lecturas', '15 3 * * *', $$select iot.compact_readings(interval '90 days')$$);
 */
import { adminDb, loadEnvFiles } from './lib/scriptenv'

async function main(): Promise<void> {
  loadEnvFiles('.env.local', '.env.admin.local')
  const i = process.argv.indexOf('--days')
  const days = Math.max(1, Math.min(3650, Number(i >= 0 ? process.argv[i + 1] : 90) || 90))
  const sql = adminDb(1)
  try {
    const [r] = await sql<{ hours_written: number; raw_deleted: number }[]>`select * from iot.compact_readings(make_interval(days => ${days}))`
    console.log(`✓ retención de ${days} días: ${r!.hours_written} promedios horarios escritos, ${r!.raw_deleted} lecturas crudas borradas`)
  } finally {
    await sql.end({ timeout: 5 })
  }
}

main().catch((e: Error) => {
  console.error(`✗ ${e.message}`)
  process.exit(1)
})
