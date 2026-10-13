/**
 * PASARELA para la Raspberry Pi: recibe las tramas de los nodos por MQTT (Mosquitto) o HTTP y las procesa al instante
 * contra la base PostgreSQL de la Pi (reutiliza TODA la lógica del dashboard: validación, alertas, órdenes de riego y
 * configuración). Funciona sin internet. La copia a Supabase la hace el servicio «sync» (scripts/sync.ts).
 *
 *   npm run gateway
 *
 * Variables (en .env.local o en el entorno):
 *   DATABASE_HOST / DATABASE_PORT / DATABASE_NAME / DATABASE_USER / DATABASE_PASSWORD / DATABASE_SSL_MODE
 *       las credenciales del rol «iot_app» de la base local (las mismas que usa el dashboard)
 *   GATEWAY_PORT       puerto local para los nodos que usen HTTP  (por defecto 3100)
 *   MQTT_URL           broker Mosquitto (p. ej. mqtt://mosquitto:1883); sin él, solo HTTP
 *   MQTT_USER / MQTT_PASS   credenciales del broker
 *
 * Los nodos MQTT publican en el broker (ver gateway-mqtt.ts); los nodos HTTP usan SERVER_URL = http://IP_DE_LA_PI:3100
 */
import { alertsSweep } from './lib/gateway-sweep'
import { Gateway } from './lib/gateway-core'
import { startMqtt } from './lib/gateway-mqtt'
import { appDb } from './lib/scriptenv'
import { handleIngest } from '../src/lib/services/ingest'

const stamp = () => new Date().toISOString().replace('T', ' ').slice(0, 19)
const log = (m: string) => console.log(`[${stamp()}] ${m}`)

const port = Number(process.env.GATEWAY_PORT ?? 3100)

const db = appDb(4)
const gw = new Gateway({ ingest: (input) => handleIngest(db, input), log })

const server = gw.server()
server.listen(port, '0.0.0.0', () => log(`Pasarela escuchando en el puerto ${port} · base local ${process.env.DATABASE_HOST ?? '?'}`))

const mqttLink = process.env.MQTT_URL
  ? startMqtt(gw, { url: process.env.MQTT_URL, username: process.env.MQTT_USER, password: process.env.MQTT_PASS, log })
  : null

// «Nodo sin conexión»: debe detectarse aunque no llegue ninguna trama (con su propio límite interno de 1 vez cada 20 s).
const sweepTimer = setInterval(() => void alertsSweep(db).catch((e: Error) => log(`BARRIDO: ${e.message}`)), 20_000)

let closing = false
async function shutdown(): Promise<void> {
  if (closing) return
  closing = true
  clearInterval(sweepTimer)
  log('Cerrando…')
  server.close()
  await mqttLink?.close()
  await db.end({ timeout: 3 }).catch(() => undefined)
  process.exit(0)
}
process.on('SIGINT', () => void shutdown())
process.on('SIGTERM', () => void shutdown())
