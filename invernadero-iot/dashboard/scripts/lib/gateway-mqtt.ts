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
import type { KeyObject } from 'node:crypto'
import type { FrameReply, Gateway } from './gateway-core'
import type { RouteInfo } from '../../src/lib/services/ingest'
import { type Modo, type Politica, bytesRsa, codificar, decodificar } from './mqtt-crypto'

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
  /** Clave AES (128 o 256 bits) compartida con los nodos (ver mqtt-crypto.ts). Sin ella solo se aceptan los formatos «claro» y «b64». */
  aesKey?: Buffer | null
  /** Clave PRIVADA RSA de la Pi (modo rsa: el nodo cifra con la pública). Sin ella no se acepta «rsa1:». */
  rsaPrivada?: KeyObject | null
  /** «permitir» (por defecto): acepta todo y responde en el formato recibido. «exigir»: solo aes o rsa. «exigir-rsa»: solo rsa. */
  politica?: Politica
  log: (msg: string) => void
}

export interface PayloadOptions {
  aesKey?: Buffer | null
  rsaPrivada?: KeyObject | null
  politica?: Politica
  log: (msg: string) => void
}

/**
 * Procesa UNA carga «tal como habría viajado por MQTT» (la misma para MQTT y para HTTP /relay): la descifra según la
 * política, extrae «TOKEN\n{trama}», la entrega a la pasarela y devuelve el tema de respuesta y el texto ya codificado
 * igual que la petición. null = se descartó (formato o cifrado no válidos); `rechazo` lleva el aviso que se le puede dar al nodo.
 */
export function crearProcesador(gw: Gateway, o: PayloadOptions) {
  const clave = o.aesKey ?? null
  const politica: Politica = o.politica ?? 'permitir'
  const rsa = o.rsaPrivada ?? null
  // Último formato visto por tema: se registra solo cuando cambia (una trama cada 5 s llenaría el registro).
  const modoVisto = new Map<string, Modo>()

  return async function procesar(
    topic: string, payload: Buffer | string, route: RouteInfo,
  ): Promise<{ replyTopic: string; text: string } | { replyTopic: string; text: string; descartado: true } | null> {
    const dec = decodificar(payload, topic, clave, politica, rsa)
    if (!dec.ok) {
      // Nunca se registra el contenido (puede traer el token): solo el motivo.
      o.log(`MQTT: mensaje descartado en ${topic} (${dec.motivo})`)
      if (dec.motivo === 'cifrado_requerido') {
        const m = TX_RE.exec(topic)
        if (m) return { replyTopic: `invernadero/${m[1]}/rx`, text: formatRx({ status: 400, body: { ok: false, error: 'cifrado_requerido' } }), descartado: true }
      }
      return null
    }
    if (modoVisto.get(topic) !== dec.modo) {
      modoVisto.set(topic, dec.modo)
      const formato: Record<Modo, string> = {
        claro: 'texto claro (SIN cifrar)',
        b64: 'Base64 (solo codificada, NO cifrada)',
        aes: `AES-${(clave?.length ?? 0) * 8}-GCM (descifrada)`,
        rsa: `RSA-${rsa ? bytesRsa(rsa) * 8 : '?'} + AES-GCM de un solo uso (descifrada con la clave PRIVADA de la Pi)`,
      }
      o.log(`${route.transport.toUpperCase()}: ${topic} ahora llega en formato ${formato[dec.modo]}`)
    }
    const tx = parseTx(topic, dec.texto)
    if (!tx) {
      o.log(`${route.transport.toUpperCase()}: mensaje ignorado en ${topic} (formato no válido)`)
      return null
    }
    let reply: FrameReply
    try {
      // El id de chip (nodo-xxxxxx) sale del tema autenticado (va en los datos adicionales del cifrado), no de la trama.
      reply = await gw.ingestFrame(tx.authorization, tx.raw, null, { ...route, device: TX_RE.exec(topic)?.[1] ?? route.device ?? null })
    } catch (e) {
      o.log(`${route.transport.toUpperCase()}: error inesperado (${(e as Error).message})`)
      reply = { status: 500, body: { ok: false, error: 'server' } }
    }
    if (route.via) o.log(`MALLA: trama de ${topic.split('/')[1]} subida por ${route.via} (${route.hops ?? '?'} salto(s)) -> HTTP ${reply.status}`)
    return { replyTopic: tx.replyTopic, text: codificar(formatRx(reply), tx.replyTopic, dec.modo, clave, dec.sesion ?? null) }
  }
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

  const procesar = crearProcesador(gw, o)
  client.on('message', (topic, payload) => {
    void procesar(topic, payload, { transport: 'mqtt' }).then((r) => {
      if (r) client.publish(r.replyTopic, r.text, { qos: 0 })
    })
  })

  return {
    connected: () => client.connected,
    close: () => new Promise<void>((resolve) => client.end(false, {}, () => resolve())),
  }
}
