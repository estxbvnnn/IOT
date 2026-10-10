/**
 * PASARELA para la Raspberry Pi: recibe las tramas de los nodos por la red local, las guarda y las envía a Supabase
 * cada minuto (reutiliza TODA la lógica del dashboard: validación, alertas, órdenes de riego y configuración).
 *
 *   npm run gateway
 *
 * Variables (en .env.local o en el entorno):
 *   DATABASE_HOST / DATABASE_PORT / DATABASE_NAME / DATABASE_USER / DATABASE_PASSWORD / DATABASE_SSL_MODE
 *       las mismas credenciales del rol «iot_app» que usa el dashboard
 *   GATEWAY_PORT       puerto local para los nodos             (por defecto 3100)
 *   GATEWAY_FORWARD_S  segundos entre envíos a Supabase         (por defecto 60)
 *   GATEWAY_SPOOL      carpeta de la cola y de la caché         (por defecto ./.gateway)
 *
 * En los nodos, SERVER_URL debe apuntar a esta pasarela:  http://IP_DE_LA_PI:3100
 */
import path from 'node:path'
import { alertsSweep } from './lib/gateway-sweep'
import { Gateway } from './lib/gateway-core'
import { DASHBOARD_DIR, appDb } from './lib/scriptenv'
import { handleIngest } from '../src/lib/services/ingest'

const stamp = () => new Date().toISOString().replace('T', ' ').slice(0, 19)
const log = (m: string) => console.log(`[${stamp()}] ${m}`)

const port = Number(process.env.GATEWAY_PORT ?? 3100)
const everyS = Math.max(5, Number(process.env.GATEWAY_FORWARD_S ?? 60))
const dir = path.resolve(DASHBOARD_DIR, process.env.GATEWAY_SPOOL ?? '.gateway')

const db = appDb(2)
const gw = new Gateway({
  ingest: (input) => handleIngest(db, input),
  sweep: () => alertsSweep(db),
  spoolDir: path.join(dir, 'cola'),
  cachePath: path.join(dir, 'respuestas.json'),
  log,
})

const server = gw.server()
server.listen(port, '0.0.0.0', () => {
  log(`Pasarela escuchando en el puerto ${port} · reenvío a Supabase cada ${everyS} s · cola en ${path.join(dir, 'cola')}`)
  if (gw.spoolSize() > 0) log(`Hay ${gw.spoolSize()} tramas pendientes de un arranque anterior`)
})

async function cycle(): Promise<void> {
  const r = await gw.forward()
  if (r.processed > 0 || r.dropped > 0 || r.failed) {
    log(`Reenvío: ${r.processed} enviadas, ${r.dropped} descartadas, ${r.left} en cola${r.failed ? ' (SIN conexión con Supabase)' : ''}`)
  }
}
const timer = setInterval(() => void cycle(), everyS * 1000)

let closing = false
async function shutdown(): Promise<void> {
  if (closing) return
  closing = true
  clearInterval(timer)
  log('Cerrando: último envío…')
  server.close()
  await Promise.race([cycle(), new Promise((r) => setTimeout(r, 10_000))]).catch(() => undefined)
  await db.end({ timeout: 3 }).catch(() => undefined)
  process.exit(0)
}
process.on('SIGINT', () => void shutdown())
process.on('SIGTERM', () => void shutdown())
