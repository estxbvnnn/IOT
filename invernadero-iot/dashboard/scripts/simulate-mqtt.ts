/**
 * Simula UNA NodeMCU enviando datos falsos por MQTT a la Pi (mismo protocolo que nododefinitivo.ino), en los tres formatos
 * de la práctica de cifrado. Sirve para probar la pasarela sin la placa y para los ataques de la clase (alterar / repetir).
 *
 *   npx tsx scripts/simulate-mqtt.ts --host 10.231.225.220 --user nodo --pass <MQTT_PASS> --token <TOKEN de I1> --modo aes --clave <32 hex = AES-128>
 *
 *   --modo claro|b64|aes|rsa  formato del payload (por defecto claro)        --clave   AES_KEY (o MQTT_AES_KEY del entorno)
 *   --publica <pem>        clave PÚBLICA de la Pi (con --modo rsa: se cifra con ella; solo la Pi, con su privada, puede abrirlo)
 *   --n 5                  cuántas tramas (por defecto 5)                   --cada 2   segundos entre tramas
 *   --id nodo-sim001       identificador en el tema invernadero/<id>/tx      --temp 24  temperatura base falsa
 *   --alterar              cambia UN bit del mensaje cifrado: la pasarela debe descartarlo (AES-GCM lo detecta)
 *   --repetir              envía dos veces exactamente la misma trama: la segunda debe responder «dup»
 *
 * Imprime lo que viaja por la red (lo que vería Wireshark) y la respuesta ya decodificada. No imprime el token completo.
 */
import mqtt from 'mqtt'
import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import { type Modo, abrirRespuesta, claveDesdeHex, cifrarAes, cifrarRsa, codificar } from './lib/mqtt-crypto'

function arg(name: string, fallback = ''): string {
  const i = process.argv.indexOf(name)
  return i >= 0 ? (process.argv[i + 1] ?? fallback) : fallback
}
const flag = (name: string) => process.argv.includes(name)

const host = arg('--host', '127.0.0.1')
const user = arg('--user', 'nodo')
const pass = arg('--pass', process.env.MQTT_PASS ?? '')
const token = arg('--token')
const modo = arg('--modo', 'claro') as Modo
const n = Number(arg('--n', '5'))
const cada = Number(arg('--cada', '2')) * 1000
const id = arg('--id', 'nodo-sim001')
const tempBase = Number(arg('--temp', '24'))
const claveHex = arg('--clave', process.env.MQTT_AES_KEY ?? '')
const publicaArchivo = arg('--publica')

if (!token || !['claro', 'b64', 'aes', 'rsa'].includes(modo) || (modo === 'aes' && !claveHex) || (modo === 'rsa' && !publicaArchivo)) {
  console.error('Uso: npx tsx scripts/simulate-mqtt.ts --host <IP Pi> --user nodo --pass <clave MQTT> --token <token> --modo claro|b64|aes|rsa [--clave <hex>] [--publica <pem>] [--n 5] [--alterar] [--repetir]')
  process.exit(2)
}
const clave = claveHex ? claveDesdeHex(claveHex) : null
const tx = `invernadero/${id}/tx`
const rx = `invernadero/${id}/rx`
const publica = publicaArchivo ? fs.readFileSync(publicaArchivo, 'utf8') : null
/** Clave de sesión de la última petición rsa: con ella se lee la respuesta (solo este nodo la conoce). */
let sesion: Buffer | null = null
const boot = randomBytes(4).readUInt32BE(0)
let seq = 0

const client = mqtt.connect(`mqtt://${host}:1883`, { username: user, password: pass, clientId: id, reconnectPeriod: 0, connectTimeout: 8000 })
let esperaRespuesta: (() => void) | null = null

client.on('error', (e) => { console.error(`MQTT: ${e.message}`); process.exit(1) })
client.on('connect', () => {
  console.log(`MQTT conectado a ${host}:1883 como ${id} · modo ${modo}${flag('--alterar') ? ' · ALTERADO' : ''}${flag('--repetir') ? ' · REPETIDO' : ''}`)
  client.subscribe(rx, { qos: 1 }, () => void correr())
})
client.on('message', (topic, payload) => {
  const crudo = payload.toString('utf8')
  const d = abrirRespuesta(crudo, topic, clave, sesion)
  console.log(`  ← viaja:   ${crudo.slice(0, 100).replace(/\n/g, '⏎')}${crudo.length > 100 ? '…' : ''}`)
  console.log(`  ← decodificada (${d.ok ? d.modo : 'ERROR ' + d.motivo}): ${d.ok ? d.texto.replace(/\n/g, ' ').slice(0, 150) : '—'}`)
  esperaRespuesta?.()
})

function trama(): { texto: string; resumen: string } {
  seq += 1
  const temp = +(tempBase + (Math.random() - 0.5) * 3).toFixed(1)
  const hum = +(60 + (Math.random() - 0.5) * 8).toFixed(1)
  const suelo = 600 + Math.round((Math.random() - 0.5) * 80)
  const json = JSON.stringify({
    v: 1, fw: 'sim-ts', boot, seq, up: seq * Math.round(cada / 1000), temp, hum_aire: hum, suelo_raw: suelo, luz: null,
    bomba: 0, riego_s: 0, est: 'idle', esp: 0, rssi: -50, fallas: [],
  })
  return { texto: `${token}\n${json}`, resumen: `temp=${temp} hum=${hum} suelo=${suelo}` }
}

function armar(texto: string): string {
  if (modo === 'claro') return texto
  if (modo === 'rsa') {
    const r = cifrarRsa(texto, tx, publica!)
    sesion = r.sesion
    if (flag('--alterar')) {
      const raw = Buffer.from(r.payload.slice(5), 'base64')
      raw[10] = raw[10]! ^ 0x01 // un bit dentro de la clave envuelta con RSA
      return 'rsa1:' + raw.toString('base64')
    }
    return r.payload
  }
  if (modo === 'b64') return codificar(texto, tx, 'b64', null)
  let msg = cifrarAes(texto, tx, clave!)
  if (flag('--alterar')) {
    const raw = Buffer.from(msg.slice(5), 'base64')
    raw[14] = raw[14]! ^ 0x01 // un solo bit dentro del texto cifrado
    msg = 'aes1:' + raw.toString('base64')
  }
  return msg
}

const mostrar = (m: string) => m.replace(token, token.slice(0, 6) + '…').replace(/\n/g, '⏎')

async function esperar(ms: number): Promise<void> {
  await new Promise<void>((res) => { esperaRespuesta = res; setTimeout(res, ms) })
  esperaRespuesta = null
}

async function correr(): Promise<void> {
  for (let i = 0; i < n; i++) {
    const t = trama()
    const msg = armar(t.texto)
    const veces = flag('--repetir') ? 2 : 1
    for (let k = 0; k < veces; k++) {
      console.log(`\n[#${seq}${k ? ' repetida' : ''}] datos falsos: ${t.resumen}`)
      console.log(`  → viaja:   ${(modo === 'claro' ? mostrar(msg) : msg).slice(0, 100)}${msg.length > 100 ? '…' : ''}  (${msg.length} bytes)`)
      client.publish(tx, msg, { qos: 1 })
      await esperar(3000)
    }
    if (i < n - 1) await new Promise((r) => setTimeout(r, cada))
  }
  client.end(false, {}, () => process.exit(0))
}
