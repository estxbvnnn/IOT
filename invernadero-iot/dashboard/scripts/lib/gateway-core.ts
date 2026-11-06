/**
 * Núcleo de la pasarela (gateway) de la Raspberry Pi: recibe las tramas de los nodos (NodeMCU…) por MQTT
 * (Mosquitto, ver gateway-mqtt.ts) o por HTTP en la red local y las procesa AL INSTANTE contra la base PostgreSQL
 * de la propia Pi. No sabe nada de la base: recibe `ingest` (en producción es `handleIngest` del dashboard, con toda
 * su validación, alertas, órdenes de riego y configuración; en las pruebas, un simulacro).
 *
 *   Nodo ──MQTT/HTTP──►  Pasarela  ──handleIngest──►  PostgreSQL local  ──(cada 5 min, servicio «sync»)──►  Supabase
 *        ◄── {ok, cfg, ordenes}  (la respuesta real de la base local, en la misma trama)
 *
 * Como la base está en la misma máquina, ya no hace falta una cola en disco ni guardar respuestas: la base ES la cola
 * durable. Funciona igual con o sin internet; la copia a Supabase la hace el servicio «sync».
 */
import http from 'node:http'
import { FRAME_MAX_BYTES } from '../../src/lib/ingest/schema'
import { parseFrame } from '../../src/lib/ingest/normalize'
import { type IngestInput, type IngestResult, type RouteInfo, parseBearer } from '../../src/lib/services/ingest'

export type IngestFn = (input: IngestInput) => Promise<IngestResult>

/** Atiende una carga por HTTP en /relay/<id> (la que un nodo de la malla sube en nombre de otro). Devuelve el texto de respuesta, o null si se descartó. */
export type RelayFn = (id: string, body: string, route: RouteInfo) => Promise<string | null>

export interface GatewayOptions {
  ingest: IngestFn
  /** MODO DE PRUEBAS: acepta cualquier identificador («GRUPO-A») como credencial y da de alta los nodos nuevos (ver open-nodes.ts). */
  abierto?: boolean
  now?: () => number
  log?: (msg: string) => void
}

const json = (res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) => {
  const text = JSON.stringify(body)
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text), 'Cache-Control': 'no-store', ...headers })
  res.end(text)
}

/** Respuesta a una trama, independiente del transporte (HTTP o MQTT). */
export interface FrameReply {
  status: number
  body: unknown
  retryAfterS?: number
}

export class Gateway {
  private readonly o: Required<GatewayOptions>
  /** Tramas aceptadas (200) desde que arrancó, y momento de la última. */
  accepted = 0
  lastFrameAt: number | null = null
  /** Resultado de la última escritura en la base: false = la base local no respondió. */
  lastDbOk: boolean | null = null

  constructor(opts: GatewayOptions) {
    this.o = { now: () => Date.now(), log: () => undefined, abierto: false, ...opts }
  }

  /**
   * Procesa UNA trama venga de donde venga (HTTP o MQTT): valida, la guarda en la base local y devuelve la respuesta
   * que debe recibir el nodo. `raw === null` = cuerpo demasiado grande. Si la base no responde: 503 y el nodo reintenta.
   */
  /** Lo registra gateway.ts cuando hay cifrado configurado; sin él, /relay responde 404. */
  relay: RelayFn | null = null

  async ingestFrame(authorization: string | null, raw: string | null, ip: string | null, route?: RouteInfo): Promise<FrameReply> {
    const token = parseBearer(authorization, this.o.abierto)
    if (!token) return { status: 401, body: { ok: false, error: 'unauthorized' } }
    if (raw === null) return { status: 413, body: { ok: false, error: 'too_large' } }
    let parsedJson: unknown
    try {
      parsedJson = JSON.parse(raw)
    } catch {
      return { status: 400, body: { ok: false, error: 'invalid', detalle: ['JSON inválido'] } }
    }
    const parsed = parseFrame(parsedJson)
    if (!parsed.ok) return { status: 400, body: { ok: false, error: 'invalid', detalle: parsed.detalle } }

    let result: IngestResult
    try {
      // skipSweep: el barrido de «nodo sin conexión» corre aparte, con su propio reloj (ver gateway.ts).
      result = await this.o.ingest({ authorization: authorization!, rawBody: raw, ip, now: new Date(this.o.now()), skipSweep: true, route, abierto: this.o.abierto })
    } catch (e) {
      this.lastDbOk = false
      this.o.log(`BASE: no responde (${(e as Error).message})`)
      return { status: 503, body: { ok: false, error: 'server' } }
    }
    this.lastDbOk = true
    if (result.status === 200) {
      this.accepted++
      this.lastFrameAt = this.o.now()
    }
    return { status: result.status, body: result.body, retryAfterS: result.status === 429 ? result.retryAfterS : undefined }
  }

  // ---------------------------------------------------------------- HTTP
  private async readBody(req: http.IncomingMessage): Promise<string | null> {
    const chunks: Buffer[] = []
    let total = 0
    for await (const c of req) {
      total += (c as Buffer).length
      if (total > FRAME_MAX_BYTES) return null
      chunks.push(c as Buffer)
    }
    return Buffer.concat(chunks).toString('utf8')
  }

  private async onIngest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const authorization = req.headers.authorization ?? null
    if (!parseBearer(authorization, this.o.abierto)) return json(res, 401, { ok: false, error: 'unauthorized' })   // sin token no se lee el cuerpo
    const ip = (req.socket.remoteAddress ?? '').replace(/^::ffff:/, '') || null   // antes de leer: con un cuerpo enorme el socket se destruye
    const raw = await this.readBody(req)
    const r = await this.ingestFrame(authorization, raw, ip, { transport: 'http' })
    return json(res, r.status, r.body, r.retryAfterS !== undefined ? { 'Retry-After': String(r.retryAfterS) } : {})
  }

  /**
   * POST /relay/<id>: el mismo texto que viajaría por MQTT en invernadero/<id>/tx (claro, Base64, AES o «rsa1:…»).
   * Lo usan los nodos de la malla ESP-NOW (el propio nodo o un vecino que sube la trama de otro). La respuesta es el
   * texto que iría a invernadero/<id>/rx, codificado igual que la petición. Cabeceras opcionales: X-Via (nodo que subió
   * la trama en nombre del origen) y X-Saltos (saltos por radio hasta él).
   */
  private async onRelay(req: http.IncomingMessage, res: http.ServerResponse, id: string): Promise<void> {
    if (!this.relay) return json(res, 404, { ok: false, error: 'not_found' })
    const body = await this.readBody(req)
    if (body === null) return json(res, 413, { ok: false, error: 'too_large' })
    const via = String(req.headers['x-via'] ?? '').trim()
    const saltos = Number.parseInt(String(req.headers['x-saltos'] ?? ''), 10)
    const route: RouteInfo = {
      transport: via ? 'espnow' : 'http',
      via: /^[A-Za-z0-9_-]{1,40}$/.test(via) ? via : null,
      hops: Number.isInteger(saltos) && saltos >= 0 && saltos <= 15 ? saltos : null,
    }
    const reply = await this.relay(id, body, route)
    if (reply === null) return json(res, 400, { ok: false, error: 'descartado' })
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Content-Length': Buffer.byteLength(reply), 'Cache-Control': 'no-store' })
    res.end(reply)
  }

  server(): http.Server {
    return http.createServer((req, res) => {
      const url = (req.url ?? '').split('?')[0]
      const run = async () => {
        if (req.method === 'POST' && url === '/api/ingest') return this.onIngest(req, res)
        const rel = req.method === 'POST' ? /^\/relay\/([A-Za-z0-9_-]{1,40})$/.exec(url ?? '') : null
        if (rel) return this.onRelay(req, res, rel[1]!)
        if (req.method === 'GET' && url === '/api/health') {
          return json(res, this.lastDbOk === false ? 503 : 200, {
            ok: this.lastDbOk !== false, baseLocal: this.lastDbOk, tramas: this.accepted,
            ultimaTrama: this.lastFrameAt ? new Date(this.lastFrameAt).toISOString() : null,
          })
        }
        return json(res, 404, { ok: false, error: 'not_found' })
      }
      run().catch((e) => {
        this.o.log(`HTTP: error inesperado (${(e as Error).message})`)
        if (!res.headersSent) json(res, 500, { ok: false, error: 'server' })
      })
    })
  }
}
