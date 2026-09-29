/**
 * Borra los DATOS OPERACIONALES (telemetría, riegos, órdenes, alertas y el estado de los nodos) para
 * empezar de cero, por ejemplo al pasar de la demostración a hardware real.
 *
 *   npm run db:reset-data -- --yes
 *
 * NO toca: usuarios, sesiones, invernaderos, umbrales, calendarios, nodos ni sus tokens.
 * NO puede tocar la bitácora de auditoría (es inmutable a propósito): el borrado queda registrado en ella.
 * Después, `npm run db:seed` vuelve a generar el historial demo (solo para nodos sin lecturas).
 */
import { adminDb, loadEnvFiles } from './lib/scriptenv'
import { audit } from '../src/lib/services/audit'
import type { Db } from '../src/lib/db/types'

async function main(): Promise<void> {
  loadEnvFiles('.env.local', '.env.admin.local')
  if (!process.argv.includes('--yes')) {
    console.log('Esto borra telemetría, riegos, órdenes, alertas y el estado de los nodos.\nVuelve a ejecutar con --yes para confirmar:  npm run db:reset-data -- --yes')
    return
  }
  const sql = adminDb(1)
  try {
    const counts = await sql.begin(async (tx) => {
      const c = async (q: Promise<{ n: number }[]>) => (await q)[0]!.n
      const out = {
        lecturas: await c(tx<{ n: number }[]>`with d as (delete from iot.readings returning 1) select count(*)::int as n from d`),
        promedios: await c(tx<{ n: number }[]>`with d as (delete from iot.readings_hourly returning 1) select count(*)::int as n from d`),
        riegos: await c(tx<{ n: number }[]>`with d as (delete from iot.irrigation_events returning 1) select count(*)::int as n from d`),
        ordenes: await c(tx<{ n: number }[]>`with d as (delete from iot.commands returning 1) select count(*)::int as n from d`),
        alertas: await c(tx<{ n: number }[]>`with d as (delete from iot.alerts returning 1) select count(*)::int as n from d`),
      }
      await tx`
        update iot.node_state set ts = null, fw_version = null, boot_id = null, last_seq = null, uptime_s = null, temp_c = null,
               hum_air = null, soil_raw = null, soil_pct = null, light_lux = null, wind_ms = null, pump_on = null,
               pump_state = null, pump_run_s = null, cooldown_s = null, rssi = null, snr = null, faults = '{}', cfg_version = null`
      await audit(tx as unknown as Db, { actorLabel: 'sistema', action: 'system.seed', detail: { reset: true, ...out } })
      return out
    })
    console.log('✓ datos operacionales borrados:', counts)
    console.log('  Para regenerar historial demo: npm run db:seed')
  } finally {
    await sql.end({ timeout: 5 })
  }
}

main().catch((e: Error) => {
  console.error(`✗ ${e.message}`)
  process.exit(1)
})
