/**
 * Núcleo de la pasarela (gateway) de la Raspberry Pi: recibe las tramas de los nodos (NodeMCU, Pico…) por HTTP en la
 * red local, las guarda en una cola en disco y las reenvía a Supabase cada cierto tiempo, conservando la hora real
 * de cada una. No sabe nada de la base de datos: recibe `ingest` (en producción es `handleIngest` del dashboard, con
 * toda su validación, alertas y órdenes; en las pruebas, un simulacro).
 *
 *   Nodo ──POST /api/ingest──►  Pasarela  ──► cola en disco (spool/*.json)  ──(cada 60 s)──►  Supabase
 *        ◄── {ok, cfg, ordenes} (de la última respuesta de Supabase, guardada en memoria y disco)
 *
 * Reglas:
 *  - La PRIMERA trama de un nodo (aún sin respuesta guardada) se procesa al momento contra Supabase: así el nodo recibe
 *    de inmediato su configuración real (o un 401 si el token es inválido). Las siguientes se encolan y se responden
 *    con la última configuración y las últimas órdenes conocidas.
 *  - Sin conexión a Supabase la cola crece (hasta `maxSpool`) y se vacía en orden cuando vuelve.
 *  - Las órdenes guardadas se descuentan por el tiempo que llevan en espera (`vence_s`) y se descartan al vencer.
 */
import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { hashToken } from '../../src/lib/auth/tokens'
import { FRAME_MAX_BYTES, frameSchema } from '../../src/lib/ingest/schema'
import { type IngestCfg, type IngestInput, type IngestOrder, type IngestResult, parseBearer } from '../../src/lib/services/ingest'

export type IngestFn = (input: IngestInput) => Promise<IngestResult>

interface CacheEntry {
  cfg: IngestCfg
  ordenes: IngestOrder[]
  /** Momento (ms) en que Supabase entregó esta respuesta. */
  at: number
}

interface SpoolItem {
  ts: number
  ip: string | null
  authorization: string
  rawBody: string
}

export interface GatewayOptions {
  ingest: IngestFn
  spoolDir: string
  cachePath: string
  /** Tras cada reenvío (p. ej. el barrido de «nodo sin conexión»). Un fallo aquí no detiene nada. */
  sweep?: () => Promise<void>
  maxSpool?: number
  now?: () => number
  log?: (msg: string) => void
}

export interface ForwardResult {
  processed: number
  dropped: number
  left: number
  /** true si se interrumpió por un error de conexión (la cola se conserva). */
  failed: boolean
}

const json = (res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) => {
  const text = JSON.stringify(body)
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text), 'Cache-Control': 'no-store', ...headers })
  res.end(text)
}

export class Gateway {
  private readonly o: Required<Omit<GatewayOptions, 'sweep'>> & Pick<GatewayOptions, 'sweep'>
  private cache = new Map<string, CacheEntry>()
  private counter = 0
  private forwarding = false
  lastForwardAt: number | null = null
  lastForwardOk: boolean | null = null

  constructor(opts: GatewayOptions) {
    this.o = { maxSpool: 20_000, now: () => Date.now(), log: () => undefined, ...opts }
    fs.mkdirSync(this.o.spoolDir, { recursive: true })
    this.loadCache()
  }

  // ---------------------------------------------------------------- cola en disco
  private spoolFiles(): string[] {
    return fs.readdirSync(this.o.spoolDir).filter((f) => f.endsWith('.json')).sort()
  }

  private enqueue(item: SpoolItem): void {
    const files = this.spoolFiles()
    for (let i = 0; i <= files.length - this.o.maxSpool; i++) fs.unlinkSync(path.join(this.o.spoolDir, files[i]!)) // se descartan las más viejas
    const name = `${String(item.ts).padStart(15, '0')}-${String(this.counter++ % 1_000_000).padStart(6, '0')}-${randomBytes(3).toString('hex')}.json`   // el sufijo evita choques tras un reinicio
    const tmp = path.join(this.o.spoolDir, `${name}.tmp`)
    fs.writeFileSync(tmp, JSON.stringify(item))
    fs.renameSync(tmp, path.join(this.o.spoolDir, name))   // escritura atómica: un corte de luz no deja archivos a medias
  }

  spoolSize(): number {
    return this.spoolFiles().length
  }

  // ---------------------------------------------------------------- respuestas guardadas
  private loadCache(): void {
    try {
      const raw = JSON.parse(fs.readFileSync(this.o.cachePath, 'utf8')) as Record<string, CacheEntry>
      for (const [k, v] of Object.entries(raw)) if (v && typeof v.at === 'number' && v.cfg) this.cache.set(k, v)
    } catch {
      /* sin respuestas guardadas todavía */
    }
  }

  private saveCache(): void {
    try {
      const tmp = `${this.o.cachePath}.tmp`
      fs.writeFileSync(tmp, JSON.stringify(Object.fromEntries(this.cache)))
      fs.renameSync(tmp, this.o.cachePath)
    } catch (e) {
      this.o.log(`CACHE: no se pudo guardar (${(e as Error).message})`)
    }
  }

  private remember(key: string, res: IngestResult): void {
    if (res.status !== 200) return
    this.cache.set(key, { cfg: res.body.cfg, ordenes: res.body.ordenes, at: this.o.now() })
    this.saveCache()
  }

  private cachedBody(entry: CacheEntry) {
    const now = this.o.now()
    const elapsed = Math.floor((now - entry.at) / 1000)
    const ordenes = entry.ordenes
      .map((o) => ({ ...o, vence_s: o.vence_s - elapsed }))
      .filter((o) => o.vence_s > 0)
    return { ok: true as const, t: new Date(now).toISOString(), cfg: entry.cfg, ordenes }
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
    const token = parseBearer(authorization)
    if (!token) return json(res, 401, { ok: false, error: 'unauthorized' })
    const raw = await this.readBody(req)
    if (raw === null) return json(res, 413, { ok: false, error: 'too_large' })
    let parsedJson: unknown
    try {
      parsedJson = JSON.parse(raw)
    } catch {
      return json(res, 400, { ok: false, error: 'invalid', detalle: ['JSON inválido'] })
    }
    const parsed = frameSchema.safeParse(parsedJson)
    if (!parsed.success) {
      const detalle = parsed.error.issues.slice(0, 6).map((i) => `${i.path.join('.') || 'cuerpo'}: ${i.message}`)
      return json(res, 400, { ok: false, error: 'invalid', detalle })
    }
    const ip = (req.socket.remoteAddress ?? '').replace(/^::ffff:/, '') || null
    const key = hashToken(token).toString('hex')
    const entry = this.cache.get(key)

    if (!entry) {
      // Primera trama de este nodo: se procesa ya (token válido, configuración real). Si Supabase no responde, 503 y el nodo reintenta.
      let result: IngestResult
      try {
        result = await this.o.ingest({ authorization: authorization!, rawBody: raw, ip, now: new Date(this.o.now()) })
      } catch (e) {
        this.o.log(`PRIMERA TRAMA: sin conexión con Supabase (${(e as Error).message})`)
        return json(res, 503, { ok: false, error: 'server' })
      }
      this.remember(key, result)
      return json(res, result.status, result.body, result.status === 429 ? { 'Retry-After': String(result.retryAfterS) } : {})
    }

    this.enqueue({ ts: this.o.now(), ip, authorization: authorization!, rawBody: raw })
    return json(res, 200, this.cachedBody(entry))
  }

  server(): http.Server {
    return http.createServer((req, res) => {
      const url = (req.url ?? '').split('?')[0]
      const run = async () => {
        if (req.method === 'POST' && url === '/api/ingest') return this.onIngest(req, res)
        if (req.method === 'GET' && url === '/api/health') {
          return json(res, 200, {
            ok: true, cola: this.spoolSize(), nodos: this.cache.size,
            ultimoReenvio: this.lastForwardAt ? new Date(this.lastForwardAt).toISOString() : null, ultimoReenvioOk: this.lastForwardOk,
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

  // ---------------------------------------------------------------- reenvío a Supabase
  async forward(): Promise<ForwardResult> {
    if (this.forwarding) return { processed: 0, dropped: 0, left: this.spoolSize(), failed: false }
    this.forwarding = true
    let processed = 0
    let dropped = 0
    let failed = false
    try {
      for (const f of this.spoolFiles()) {
        const file = path.join(this.o.spoolDir, f)
        let item: SpoolItem
        try {
          item = JSON.parse(fs.readFileSync(file, 'utf8')) as SpoolItem
        } catch {
          fs.rmSync(file, { force: true })                                    // archivo dañado: no debe bloquear la cola
          dropped++
          continue
        }
        let res: IngestResult
        try {
          res = await this.o.ingest({ authorization: item.authorization, rawBody: item.rawBody, ip: item.ip, now: new Date(item.ts), skipSweep: true })
        } catch (e) {
          this.o.log(`REENVIO: sin conexión con Supabase (${(e as Error).message}); la cola se conserva`)
          failed = true
          break
        }
        if (res.status === 200) {
          this.remember(hashToken(parseBearer(item.authorization) ?? '').toString('hex'), res)
          processed++
        } else {
          this.o.log(`REENVIO: trama descartada (HTTP ${res.status})`)
          dropped++                                                          // 400/401/413/429: reintentarla no la arregla
        }
        fs.rmSync(file, { force: true })
      }
      if (!failed && this.o.sweep) await this.o.sweep().catch((e) => this.o.log(`REENVIO: barrido fallido (${(e as Error).message})`))
    } finally {
      this.forwarding = false
      this.lastForwardAt = this.o.now()
      this.lastForwardOk = !failed
    }
    return { processed, dropped, left: this.spoolSize(), failed }
  }
}
