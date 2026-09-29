/**
 * Simulador de los diez nodos de invernadero + el nodo del mástil (anemómetro).
 *
 * Cada nodo simulado se comporta como el firmware del ESP32: muestrea sensores (modelo físico), decide
 * el riego con el MISMO controlador autónomo (histéresis, espera entre riegos, corte por tiempo, bloqueo
 * por temperatura…), y reporta por HTTP al dashboard con su token: POST /api/ingest (docs/contrato-api.md).
 * También ejecuta las órdenes de riego que llegan en la respuesta y las acusa, y acata la `cfg` que
 * entrega el servidor. Así se ve el sistema completo funcionando sin hardware.
 *
 *   npm run simulate                        → cadencia de 10 s, física en tiempo real ×30
 *   npm run simulate -- --speed 120         → el suelo se seca (y riega) más rápido
 *   npm run simulate -- --scenario demo     → guion con riegos, calor, falla de sensor, nodo caído y viento fuerte
 *                                             (otros: irrigate · heat · fault · offline · wind · dry)
 *   npm run simulate -- --fast              → fija «reporte del nodo» en 15 s mientras corre (alertas de
 *                                             nodo caído en ~90 s) y lo restaura al salir
 *   npm run simulate -- --only I1,I3 --url http://192.168.1.20:3000
 */
import fs from 'node:fs'
import path from 'node:path'
import { DASHBOARD_DIR, appDb, loadEnvFiles } from './lib/scriptenv'
import { DEFAULT_CONFIG, NodeController, SAMPLE_WHILE_PUMPING_S, type Order, type OrderAck } from '../src/lib/sim/controller'
import { GreenhouseWorld, gaussian, mulberry32 } from '../src/lib/sim/world'
import { audit } from '../src/lib/services/audit'

// ---------------------------------------------------------------- argumentos
function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(name)
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1]!.startsWith('--') ? process.argv[i + 1]! : fallback
}
const flag = (name: string) => process.argv.includes(name)

const BASE_URL = arg('--url', 'http://localhost:3000').replace(/\/$/, '')
const INTERVAL_OVERRIDE = Number(arg('--interval', '10')) // 0 = obedecer al servidor
const SPEED = Math.max(1, Number(arg('--speed', '30')))
const SCENARIO = arg('--scenario', 'none')
const ONLY = new Set(arg('--only', '').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean))
const FAST = flag('--fast')
const QUIET = flag('--quiet')

const FIRMWARE = 'sim-1.0.0'
const MIN_SPACING_MS = 1300 // el servidor exige ≥ 1 s entre tramas de un mismo nodo

const hhmmss = () => new Date().toLocaleTimeString('es-CL', { hour12: false })
const say = (msg: string) => console.log(`[${hhmmss()}] ${msg}`)

// ---------------------------------------------------------------- nodo simulado
interface Cfg { intervalo_s: number; ver: number }

class SimNode {
  readonly ctrl = new NodeController({ ...DEFAULT_CONFIG })
  readonly world: GreenhouseWorld | null
  private boot = Math.floor(Math.random() * 0xffffffff)
  private seq = 0
  private readonly startedMs = Date.now()
  private lastStepMs = Date.now()
  private nextSampleMs = Date.now() + Math.random() * 3000 // escalona el arranque
  private lastFrameMs = 0
  private nextFrameMs = Date.now() + Math.random() * 3000
  private inflight = false
  private acks: (OrderAck & { sent?: boolean })[] = []
  private lastSample: { soilRaw: number | null; tempC: number | null; humAir: number | null; lux: number | null } = { soilRaw: null, tempC: null, humAir: null, lux: null }
  private serverIntervalS = 300
  private retryAt = 0
  private rng: () => number
  // Ganchos de los escenarios de demostración
  offline = false
  dhtFault = false
  soilStuck: number | null = null
  windGust = 0
  frames = 0
  errors = 0
  lastLatencyMs = 0

  constructor(readonly code: string, private readonly token: string, seed: number, readonly isMast = false) {
    this.world = isMast ? null : new GreenhouseWorld({ seed })
    this.rng = mulberry32(seed ^ 0xa5a5)
  }

  private get intervalS(): number {
    return INTERVAL_OVERRIDE > 0 ? INTERVAL_OVERRIDE : this.serverIntervalS
  }

  /** Reloj del «mundo» físico: corre SPEED veces más rápido que el real desde el arranque del simulador. */
  private virtualNow(now: number): number {
    return this.startedMs + (now - this.startedMs) * SPEED
  }

  /** Una vuelta del bucle principal del nodo (se llama cada ~250 ms). */
  async loop(): Promise<void> {
    const now = Date.now()
    const dtReal = (now - this.lastStepMs) / 1000
    if (this.world && dtReal > 0) this.world.step(dtReal, dtReal * SPEED, this.virtualNow(now), this.ctrl.pumpOn)
    this.lastStepMs = now

    // Corte por tiempo: se evalúa en CADA vuelta, como en el firmware.
    if (!this.isMast) this.ctrl.tick(now)

    // Muestreo de sensores.
    if (now >= this.nextSampleMs) {
      this.lastSample = this.sample(now)
      if (!this.isMast) this.ctrl.tick(now, { soilRaw: this.lastSample.soilRaw, tempC: this.lastSample.tempC })
      this.nextSampleMs = now + (this.ctrl.pumpOn ? SAMPLE_WHILE_PUMPING_S : this.intervalS) * 1000
    }

    // ¿Hay que informar? Trama regular por cadencia, o inmediata por evento/acuse pendiente.
    const urgent = this.ctrl.pendingEvents().length > 0 || this.acks.some((a) => !a.sent)
    const due = now >= this.nextFrameMs
    if ((due || urgent) && !this.inflight && now >= this.retryAt && now - this.lastFrameMs >= MIN_SPACING_MS && !this.offline) {
      void this.send(now)
    }
  }

  private sample(now: number): { soilRaw: number | null; tempC: number | null; humAir: number | null; lux: number | null } {
    if (this.isMast) return { soilRaw: null, tempC: null, humAir: null, lux: null }
    const w = this.world!
    const vNow = this.virtualNow(now)
    const dht = w.dht(vNow)
    return {
      soilRaw: this.soilStuck ?? w.soilRaw(),
      tempC: this.dhtFault ? null : dht.tempC,
      humAir: this.dhtFault ? null : dht.humAir,
      lux: w.lux(vNow),
    }
  }

  private wind(now: number): number {
    const t = (now - this.startedMs) / 1000
    const base = 3.6 + 1.8 * Math.sin(t / 47) + 0.9 * Math.sin(t / 11)
    return Math.max(0, Math.round((base + this.windGust + gaussian(this.rng) * 0.4) * 10) / 10)
  }

  private buildFrame(now: number) {
    const events = this.ctrl.pendingEvents().slice(0, 8)
    const acks = this.acks.slice(0, 8)
    const s = this.lastSample
    const fallas: string[] = []
    if (this.dhtFault) fallas.push('dht')
    this.seq += 1
    return {
      body: {
        v: 1, fw: FIRMWARE, boot: this.boot, seq: this.seq, up: Math.floor((now - this.startedMs) / 1000),
        temp: s.tempC, hum_aire: s.humAir, suelo_raw: this.isMast ? null : s.soilRaw,
        luz: s.lux, viento: this.isMast ? this.wind(now) : null,
        bomba: this.ctrl.pumpOn ? 1 : 0, riego_s: this.ctrl.runningS(now), est: this.ctrl.state(now), esp: this.ctrl.cooldownRemainingS(now),
        rssi: Math.round(-62 + gaussian(this.rng) * 2), snr: null, fallas,
        ev: events.map((e) => ({
          t: e.t, why: e.why, ago: Math.max(0, Math.round((now - e.atMs) / 1000)),
          ...(e.durS !== undefined ? { dur: e.durS } : {}), ...(e.cmd ? { cmd: e.cmd } : {}),
        })),
        acks: acks.map((a) => ({ id: a.id, estado: a.estado, detalle: a.detalle })),
      },
      sentEvents: events.length,
      sentAcks: acks,
    }
  }

  private async send(now: number): Promise<void> {
    this.inflight = true
    this.lastFrameMs = now
    const { body, sentEvents, sentAcks } = this.buildFrame(now)
    const t0 = performance.now()
    try {
      const res = await fetch(`${BASE_URL}/api/ingest`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.token}` },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(30_000),
      })
      this.lastLatencyMs = performance.now() - t0
      if (res.status === 429) {
        this.retryAt = Date.now() + Number(res.headers.get('retry-after') ?? '2') * 1000
        this.seq -= 1 // la trama no se aceptó: se reutiliza el número
        return
      }
      if (!res.ok) {
        this.errors++
        this.retryAt = Date.now() + (res.status === 401 ? 60_000 : 5_000)
        say(`${this.code}: el servidor respondió ${res.status} (el nodo sigue operando de forma autónoma)`)
        return
      }
      const json = (await res.json()) as { cfg?: Record<string, number>; ordenes?: Order[]; dup?: boolean }
      // Éxito: se vacían los eventos y acuses que viajaron en esta trama.
      this.ctrl.ackEvents(sentEvents)
      for (const a of sentAcks) a.sent = true
      this.acks = this.acks.filter((a) => !a.sent)
      this.frames++
      this.nextFrameMs = Date.now() + this.intervalS * 1000
      this.applyCfg(json.cfg)
      for (const o of json.ordenes ?? []) this.handleOrder(o)
      if (!QUIET && (sentEvents > 0 || sentAcks.length > 0)) {
        say(`${this.code}: trama #${body.seq} → ${res.status} (${(this.lastLatencyMs / 1000).toFixed(1)} s)${sentEvents ? ` · eventos: ${body.ev.map((e) => `${e.t}/${e.why}`).join(', ')}` : ''}${sentAcks.length ? ` · acuses: ${sentAcks.map((a) => a.estado).join(', ')}` : ''}`)
      }
    } catch (e) {
      this.errors++
      this.retryAt = Date.now() + 5_000
      say(`${this.code}: sin conexión con el servidor (${(e as Error).message}). El nodo sigue regando de forma autónoma.`)
    } finally {
      this.inflight = false
    }
  }

  private applyCfg(cfg: Record<string, number> | undefined): void {
    if (!cfg) return
    if (typeof cfg.intervalo_s === 'number') this.serverIntervalS = cfg.intervalo_s
    if (this.isMast || cfg.suelo_on === undefined) return
    if (cfg.ver === this.ctrl.config.ver) return
    const ok = this.ctrl.setConfig({
      ver: cfg.ver!, intervalS: cfg.intervalo_s!, soilOn: cfg.suelo_on, soilOff: cfg.suelo_off!, soilSat: cfg.suelo_sat!,
      tempMax: cfg.temp_max!, pumpMaxS: cfg.riego_max_s!, waitS: cfg.espera_s!,
    })
    say(`${this.code}: configuración v${cfg.ver} ${ok ? 'aplicada' : 'IGNORADA (viola los límites del nodo)'}`)
  }

  private handleOrder(o: Order): void {
    const known = this.acks.find((a) => a.id === o.id)
    if (known) return
    const ack = this.ctrl.handleOrder(o, Date.now())
    this.acks.push({ ...ack })
    say(`${this.code}: orden «${o.tipo}${o.dur_s ? ` ${o.dur_s} s` : ''}» → ${ack.estado}: ${ack.detalle}`)
  }

  summary(): string {
    const s = this.lastSample
    const state = this.ctrl.pumpOn ? 'REGANDO' : this.ctrl.state(Date.now())
    if (this.isMast) return `${this.code.padEnd(5)} viento ${this.wind(Date.now()).toFixed(1)} m/s`
    return `${this.code.padEnd(5)} T ${s.tempC === null ? '  —  ' : s.tempC.toFixed(1).padStart(5)}°  suelo ${String(s.soilRaw ?? '—').padStart(4)}  ${state.padEnd(10)} tramas ${String(this.frames).padStart(3)}${this.errors ? `  errores ${this.errors}` : ''}${this.offline ? '  [SIN RED]' : ''}`
  }
}

// ---------------------------------------------------------------- escenarios
type Step = { at: number; label: string; run: (n: Map<string, SimNode>) => void }

function scenarioSteps(name: string): Step[] {
  const heat: Step[] = [
    { at: 20, label: 'Ola de calor en I5 (+16 °C)', run: (n) => n.get('I5')?.world?.bumpTemp(16) },
    { at: 200, label: 'Termina el calor en I5', run: (n) => n.get('I5')?.world?.bumpTemp(-16) },
  ]
  const fault: Step[] = [
    { at: 30, label: 'Falla el sensor DHT22 de I9', run: (n) => { const x = n.get('I9'); if (x) x.dhtFault = true } },
    { at: 150, label: 'Se repara el DHT22 de I9', run: (n) => { const x = n.get('I9'); if (x) x.dhtFault = false } },
  ]
  const offline: Step[] = [
    { at: 40, label: 'I2 pierde la conexión (el nodo sigue regando solo)', run: (n) => { const x = n.get('I2'); if (x) x.offline = true } },
    { at: 300, label: 'I2 recupera la conexión', run: (n) => { const x = n.get('I2'); if (x) x.offline = false } },
  ]
  const wind: Step[] = [
    { at: 60, label: 'Ráfaga de viento fuerte en el mástil (+24 m/s)', run: (n) => { const x = n.get('MAST'); if (x) x.windGust = 24 } },
    { at: 150, label: 'Cede el viento', run: (n) => { const x = n.get('MAST'); if (x) x.windGust = 0 } },
  ]
  const dry: Step[] = [
    { at: 20, label: 'El sensor de suelo de I7 queda «pegado» en seco (lectura 820): la bomba riega sin efecto', run: (n) => { const x = n.get('I7'); if (x) x.soilStuck = 820 } },
    { at: 900, label: 'Se repara el sensor de I7', run: (n) => { const x = n.get('I7'); if (x) x.soilStuck = null } },
  ]
  const irrigate: Step[] = [
    { at: 10, label: 'Se seca el suelo de I4 → debería iniciar un riego automático', run: (n) => n.get('I4')?.world?.bumpSoil(190) },
    { at: 35, label: 'Se seca el suelo de I8 → riego automático', run: (n) => n.get('I8')?.world?.bumpSoil(190) },
  ]
  switch (name) {
    case 'irrigate': return irrigate
    case 'heat': return heat
    case 'fault': return fault
    case 'offline': return offline
    case 'wind': return wind
    case 'dry': return dry
    case 'demo':
      return [...irrigate, ...heat, ...fault.map((s) => ({ ...s, at: s.at + 30 })), ...offline.map((s) => ({ ...s, at: s.at + 60 })), ...wind.map((s) => ({ ...s, at: s.at + 20 }))].sort((a, b) => a.at - b.at)
    default: return []
  }
}

// ---------------------------------------------------------------- «reporte rápido» temporal
async function setFastInterval(seconds: number | null): Promise<void> {
  loadEnvFiles('.env.local')
  const db = appDb(1)
  try {
    if (seconds !== null) {
      await db`update iot.thresholds set interval_s = ${seconds}, version = version + 1, updated_at = now() where interval_s <> ${seconds}`
      await audit(db, { actorLabel: 'simulador', action: 'thresholds.update', detail: { changes: { intervalS: { to: seconds } }, motivo: 'modo --fast del simulador' } })
    } else {
      await db`update iot.thresholds set interval_s = 300, version = version + 1, updated_at = now() where interval_s <> 300`
      await audit(db, { actorLabel: 'simulador', action: 'thresholds.update', detail: { changes: { intervalS: { to: 300 } }, motivo: 'fin del modo --fast del simulador' } })
    }
  } finally {
    await db.end({ timeout: 5 })
  }
}

// ---------------------------------------------------------------- principal
async function main(): Promise<void> {
  const file = path.join(DASHBOARD_DIR, '.demo-devices.json')
  if (!fs.existsSync(file)) throw new Error('Falta .demo-devices.json: ejecuta «npm run db:seed» primero (guarda los tokens de los nodos).')
  const tokens = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, string>

  const health = await fetch(`${BASE_URL}/api/health`, { signal: AbortSignal.timeout(8000) }).catch(() => null)
  if (!health?.ok) throw new Error(`El dashboard no responde en ${BASE_URL}. Inícialo con «npm run dev» (o usa --url).`)

  const nodes = new Map<string, SimNode>()
  Object.entries(tokens).forEach(([code, token], i) => {
    if (ONLY.size > 0 && !ONLY.has(code.toUpperCase())) return
    nodes.set(code, new SimNode(code, token, 7000 + i * 31, code === 'MAST'))
  })
  if (nodes.size === 0) throw new Error('Ningún nodo coincide con --only.')

  say(`Simulador iniciado: ${nodes.size} nodos → ${BASE_URL} · cadencia ${INTERVAL_OVERRIDE > 0 ? `${INTERVAL_OVERRIDE} s (forzada)` : 'la que indica el servidor'} · física ×${SPEED}${SCENARIO !== 'none' ? ` · escenario «${SCENARIO}»` : ''}`)
  say('Ctrl+C para detener. Los nodos siguen «regando solos» mientras no haya red, igual que el firmware.')

  if (FAST) {
    await setFastInterval(15)
    say('Modo --fast: «reporte del nodo» fijado en 15 s (se restaura a 300 s al salir).')
  }

  let stopping = false
  const stop = async () => {
    if (stopping) return
    stopping = true
    clearInterval(loopTimer)
    clearInterval(sumTimer)
    if (FAST) {
      try { await setFastInterval(null); say('Configuración restaurada (reporte cada 300 s).') } catch (e) { say(`No se pudo restaurar la configuración: ${(e as Error).message}. Ajusta «Reporte del nodo» a 300 s en el panel de umbrales.`) }
    }
    process.exit(0)
  }
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)

  const steps = scenarioSteps(SCENARIO)
  const t0 = Date.now()
  const done = new Set<number>()
  const loopTimer = setInterval(() => {
    for (const n of nodes.values()) void n.loop()
    const elapsed = (Date.now() - t0) / 1000
    steps.forEach((s, i) => {
      if (!done.has(i) && elapsed >= s.at) {
        done.add(i)
        say(`▶ ESCENARIO: ${s.label}`)
        s.run(nodes)
      }
    })
  }, 250)
  const sumTimer = setInterval(() => {
    if (QUIET) return
    say(`resumen (${nodes.size} nodos):\n  ${[...nodes.values()].map((n) => n.summary()).join('\n  ')}`)
  }, 60_000)
}

main().catch((e: Error) => {
  console.error(`✗ ${e.message}`)
  process.exit(1)
})
