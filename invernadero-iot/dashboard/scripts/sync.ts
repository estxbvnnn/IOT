/**
 * SINCRONIZACIÓN Raspberry Pi → Supabase. Cada SYNC_INTERVAL_S (300 s = 5 min) copia a Supabase lo nuevo de la base local.
 * Un solo sentido: la Pi es la dueña de los datos y funciona igual sin internet; si no hay conexión, reintenta en el siguiente ciclo.
 *
 *   npm run sync
 *
 * Variables:
 *   DATABASE_*           la base LOCAL (rol «iot_app»), igual que el dashboard y la pasarela
 *   SUPABASE_DB_HOST / SUPABASE_DB_PORT / SUPABASE_DB_NAME / SUPABASE_DB_USER / SUPABASE_DB_PASSWORD / SUPABASE_DB_SSL_MODE
 *                        el rol «iot_app» de Supabase (el pooler de Supabase habla IPv4)
 *   SYNC_INTERVAL_S      segundos entre copias (por defecto 300, mínimo 10)
 *   SYNC_ONCE=1          hace un solo ciclo y termina (útil para probar)
 *   SYNC_DRY_RUN=1       SIMULACRO: hace un ciclo, cuenta lo que enviaría y termina SIN escribir nada en Supabase
 *
 * Detalle del método en scripts/lib/sync-core.ts. Primero hay que ejecutar UNA vez `npm run sync:bootstrap`.
 */
import { syncOnce, summarize } from './lib/sync-core'
import { appDb, loadEnvFiles, supabaseDb } from './lib/scriptenv'

const stamp = () => new Date().toISOString().replace('T', ' ').slice(0, 19)
const log = (m: string) => console.log(`[${stamp()}] ${m}`)

const everyS = Math.max(10, Number(process.env.SYNC_INTERVAL_S ?? 300))
const DRY = process.env.SYNC_DRY_RUN === '1'

async function main(): Promise<void> {
  loadEnvFiles('.env.supabase', '.env.local')
  if (!process.env.SUPABASE_DB_HOST || !process.env.SUPABASE_DB_USER || !process.env.SUPABASE_DB_PASSWORD) {
    // Sin credenciales no hay nada que copiar: se queda quieto (y no en un bucle de reinicios) hasta que se completen en .env.
    log('Copia a Supabase DESACTIVADA: faltan SUPABASE_DB_HOST / SUPABASE_DB_USER / SUPABASE_DB_PASSWORD en .env. La Pi funciona igual en local.')
    setInterval(() => undefined, 3_600_000)
    process.on('SIGTERM', () => process.exit(0))
    process.on('SIGINT', () => process.exit(0))
    return
  }
  const local = appDb(2)
  const remote = supabaseDb()
  let running = false
  let lastOk = true

  /** Sin arranque inicial no se sube nada: una base local distinta de la de Supabase chocaría con sus ids. */
  async function bootstrapped(): Promise<boolean> {
    if (process.env.SYNC_ALLOW_FRESH === '1' || DRY) return true
    const rows = await local<{ name: string }[]>`select name from iot.sync_state where name = '_run'`
    return rows.length > 0
  }

  async function cycle(): Promise<void> {
    if (running) return
    running = true
    try {
      if (!(await bootstrapped())) {
        log('Falta el arranque inicial: ejecute «docker compose run --rm bootstrap» (copia lo de Supabase a la Pi). No se sube nada.')
        return
      }
      const r = await syncOnce(local, remote, { log, dryRun: DRY })
      if (r.ok) {
        // Solo se escribe cuando hay algo que contar, o al volver la conexión; no cada 5 min.
        const s = summarize(r)
        if (DRY) log(`SIMULACRO (no se escribió nada): se enviaría → ${s}`)
        else if (s !== 'sin cambios' || !lastOk) log(`Sincronizado con Supabase en ${r.ms} ms: ${s}`)
        lastOk = true
      } else {
        log(`SIN conexión con Supabase (${r.error}); se reintenta en ${everyS} s. La Pi sigue funcionando normalmente.`)
        lastOk = false
      }
    } catch (e) {
      log(`Error inesperado en la sincronización: ${(e as Error).message}`)
      lastOk = false
    } finally {
      running = false
    }
  }

  log(`Sincronización con Supabase cada ${everyS} s (${process.env.SUPABASE_DB_HOST})`)
  if (process.env.SYNC_ONCE === '1' || DRY) {
    await cycle()
    await Promise.all([local.end({ timeout: 3 }), remote.end({ timeout: 3 })])
    process.exit(lastOk ? 0 : 1)
  }
  setTimeout(() => void cycle(), 10_000)               // primer ciclo poco después de arrancar
  const timer = setInterval(() => void cycle(), everyS * 1000)

  let closing = false
  const shutdown = async (): Promise<void> => {
    if (closing) return
    closing = true
    clearInterval(timer)
    log('Cerrando…')
    await Promise.race([cycle(), new Promise((r) => setTimeout(r, 15_000))])   // último envío si hay conexión
    await Promise.all([local.end({ timeout: 3 }), remote.end({ timeout: 3 })]).catch(() => undefined)
    process.exit(0)
  }
  process.on('SIGINT', () => void shutdown())
  process.on('SIGTERM', () => void shutdown())
}

main().catch((e: Error) => {
  console.error(`✗ ${e.message}`)
  process.exit(1)
})
