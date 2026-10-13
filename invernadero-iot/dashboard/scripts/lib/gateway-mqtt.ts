/**
 * Transporte MQTT de la pasarela: el nodo publica su trama en Mosquitto (en la misma Raspberry Pi) y la pasarela se la
 * entrega al núcleo (`Gateway.ingestFrame`), que la guarda al instante en la base PostgreSQL de la Pi. La respuesta
 * (configuración + órdenes) vuelve al nodo por otro tema.
 *
 *   Nodo ──publica──►  invernadero/<id>/tx   "TOKEN\n{trama JSON}"
 *        ◄─suscrito──  invernadero/<id>/rx   "<HTTP> <Retry-After>\n{respuesta JSON}"
 *
 * <id> identifica al nodo (en el ESP8266: "nodo-<chip id>") y solo sirve para saber dónde responder; la identidad
 * real del nodo es el TOKEN, igual que en HTTP. Se mantiene el mismo contrato (códigos 200/400/401/413/429/503).
 */
import mqtt from 'mqtt'
import { FRAME_MAX_BYTES } from '../../src/lib/ingest/schema'
import type { FrameReply, Gateway } from './gateway-core'

export const TOPIC_TX = 'invernadero/+/tx'
const TX_RE = /^invernadero\/([A-Za-z0-9_-]{1,40})\/tx$/

export interface ParsedTx {
  /** Tema donde se responde al nodo. */
  replyTopic: string
  /** "Bearer <token>" (la misma forma que la cabecera HTTP). */
  authorization: string
  /** Cuerpo JSON de la trama, o null si excede FRAME_MAX_BYTES. */
  raw: string | null
}

/** Separa «TOKEN\n{trama}». null si el tema o el formato no son los del protocolo. */
export function parseTx(topic: string, payload: Buffer | string): ParsedTx | null {
  const m = TX_RE.exec(topic)
  if (!m) return null
  const text = typeof payload === 'string' ? payload : payload.toString('utf8')
  const nl = text.indexOf('\n')
  if (nl <= 0) return null
  const token = text.slice(0, nl).trim()
  if (!token) return null
  const body = text.slice(nl + 1)
  return {
    replyTopic: `invernadero/${m[1]}/rx`,
    authorization: `Bearer ${token}`,
    raw: Buffer.byteLength(body, 'utf8') > FRAME_MAX_BYTES ? null : body,
  }
}

/** «<HTTP> <Retry-After>\n{JSON}» */
export function formatRx(reply: FrameReply): string {
  return `${reply.status} ${reply.retryAfterS ?? 0}\n${JSON.stringify(reply.body)}`
}

export interface MqttOptions {
  url: string
  username?: string
  password?: string
  log: (msg: string) => void
}

/** Conecta con Mosquitto, atiende las tramas de los nodos y devuelve una función para cerrar. */
export function startMqtt(gw: Gateway, o: MqttOptions): { close: () => Promise<void>; connected: () => boolean } {
  const client = mqtt.connect(o.url, {
    username: o.username,
    password: o.password,
    clientId: `gateway-${Math.random().toString(16).slice(2, 8)}`,
    reconnectPeriod: 3000,
    connectTimeout: 10_000,
    clean: true,
  })

  client.on('connect', () => {
    o.log(`MQTT: conectado a ${o.url}`)
    client.subscribe(TOPIC_TX, { qos: 1 }, (err) => {
      if (err) o.log(`MQTT: no se pudo suscribir a ${TOPIC_TX} (${err.message})`)
      else o.log(`MQTT: escuchando ${TOPIC_TX}`)
    })
  })
  client.on('reconnect', () => o.log('MQTT: reconectando…'))
  client.on('offline', () => o.log('MQTT: sin conexión con Mosquitto'))
  client.on('error', (e) => o.log(`MQTT: error (${e.message})`))

  client.on('message', (topic, payload) => {
    const tx = parseTx(topic, payload)
    if (!tx) {
      o.log(`MQTT: mensaje ignorado en ${topic} (formato no válido)`)
      return
    }
    gw.ingestFrame(tx.authorization, tx.raw, null)
      .catch((e): FrameReply => {
        o.log(`MQTT: error inesperado (${(e as Error).message})`)
        return { status: 500, body: { ok: false, error: 'server' } }
      })
      .then((reply) => client.publish(tx.replyTopic, formatRx(reply), { qos: 0 }))
  })

  return {
    connected: () => client.connected,
    close: () => new Promise<void>((resolve) => client.end(false, {}, () => resolve())),
  }
}
