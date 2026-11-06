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
 *   MQTT_AES_KEY       clave AES compartida con los nodos (32 hex = AES-128: openssl rand -hex 16; 64 hex = AES-256). Ver lib/mqtt-crypto.ts
 *   MQTT_CIFRADO       «permitir» (por defecto: acepta claro, b64, aes y rsa), «exigir» (solo aes o rsa) o «exigir-rsa» (solo rsa)
 *   MQTT_RSA_PRIVATE_KEY_FILE   clave PRIVADA RSA de la Pi (PEM) para el modo rsa (los nodos cifran con la pública). Por defecto
 *                      /run/secrets/mqtt-rsa-private.pem si existe. Nunca sale de la Pi ni va al repositorio.
 *
 * Los nodos MQTT publican en el broker (ver gateway-mqtt.ts); los nodos HTTP usan SERVER_URL = http://IP_DE_LA_PI:3100
 */
import { alertsSweep } from './lib/gateway-sweep'
import { Gateway } from './lib/gateway-core'
import { crearProcesador, startMqtt } from './lib/gateway-mqtt'
import fs from 'node:fs'
import { createHash, createPrivateKey, createPublicKey } from 'node:crypto'
import { type Politica, bytesRsa, claveDesdeHex } from './lib/mqtt-crypto'
import { appDb } from './lib/scriptenv'
import { handleIngest } from '../src/lib/services/ingest'

const stamp = () => new Date().toISOString().replace('T', ' ').slice(0, 19)
const log = (m: string) => console.log(`[${stamp()}] ${m}`)

const port = Number(process.env.GATEWAY_PORT ?? 3100)

const db = appDb(4)
// MODO DE PRUEBAS: ACEPTAR_NODOS_NUEVOS=1 -> la credencial puede ser cualquier identificador («GRUPO-A») y los nodos nuevos se dan de alta solos.
const abierto = ['1', 'true', 'si', 'sí'].includes((process.env.ACEPTAR_NODOS_NUEVOS ?? '').trim().toLowerCase())
if (abierto) log('MODO ABIERTO (pruebas): se aceptan nodos con cualquier identificador y se dan de alta solos. NO usar en producción.')
const gw = new Gateway({ ingest: (input) => handleIngest(db, input), log, abierto })

const server = gw.server()
server.listen(port, '0.0.0.0', () => log(`Pasarela escuchando en el puerto ${port} · base local ${process.env.DATABASE_HOST ?? '?'}`))

// Cifrado del canal MQTT (clase de cifrado IoT). Una configuración inválida detiene el arranque: mejor eso que aceptar en claro sin avisar.
const aesKey = process.env.MQTT_AES_KEY?.trim() ? claveDesdeHex(process.env.MQTT_AES_KEY) : null
const politica = (process.env.MQTT_CIFRADO?.trim() || 'permitir') as Politica
if (politica !== 'permitir' && politica !== 'exigir' && politica !== 'exigir-rsa') throw new Error('MQTT_CIFRADO debe ser «permitir», «exigir» o «exigir-rsa»')
const rsaArchivo = process.env.MQTT_RSA_PRIVATE_KEY_FILE?.trim() || '/run/secrets/mqtt-rsa-private.pem'
/** SHA-256 de la clave PÚBLICA: debe coincidir con la que imprime scripts/rsa-publica-a-c.ts al preparar el sketch. */
const huellaPublica = (k: ReturnType<typeof createPrivateKey>): string => createHash('sha256').update(createPublicKey(k).export({ type: 'spki', format: 'der' })).digest('hex')
const rsaPrivada = fs.existsSync(rsaArchivo) ? createPrivateKey(fs.readFileSync(rsaArchivo)) : null
if (rsaPrivada && bytesRsa(rsaPrivada) < 256) throw new Error('la clave RSA debe ser de 2048 bits o más')
if (politica === 'exigir' && !aesKey && !rsaPrivada) throw new Error('MQTT_CIFRADO=exigir necesita MQTT_AES_KEY o una clave privada RSA')
if (politica === 'exigir-rsa' && !rsaPrivada) throw new Error(`MQTT_CIFRADO=exigir-rsa necesita la clave privada RSA en ${rsaArchivo}`)
if (process.env.MQTT_URL) {
  log(`MQTT: cifrado ${politica}${aesKey ? ` · AES-${aesKey.length * 8}-GCM disponible` : ' · sin clave AES'}${rsaPrivada ? ` · RSA-${bytesRsa(rsaPrivada) * 8} (clave privada cargada · huella pública ${huellaPublica(rsaPrivada).slice(0, 16)})` : ' · sin clave RSA'}`)
}

// Malla ESP-NOW: los nodos suben (ellos mismos o un vecino en su nombre) la MISMA carga que irá por MQTT con POST /relay/<id>.
// Funciona sin Mosquitto; se descifra con la misma política y las mismas claves.
const procesarRelay = crearProcesador(gw, { aesKey, rsaPrivada, politica, log })
gw.relay = async (id, body, route) => {
  const r = await procesarRelay(`invernadero/${id}/tx`, body, route)
  return r ? r.text : null
}
log(`RELAY: POST /relay/<id> listo (cifrado ${politica}${rsaPrivada ? ' · RSA' : ''}${aesKey ? ' · AES' : ''})`)

const mqttLink = process.env.MQTT_URL
  ? startMqtt(gw, { url: process.env.MQTT_URL, username: process.env.MQTT_USER, password: process.env.MQTT_PASS, aesKey, rsaPrivada, politica, log })
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
