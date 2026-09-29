/**
 * Controlador de riego del nodo — implementación de referencia en TypeScript.
 *
 * Es la MISMA lógica normativa del contrato (docs/contrato-api.md §6 y §7) que ejecuta el firmware
 * del ESP32 (firmware/nodo_invernadero/riego.h). Aquí sirve para simular los diez nodos sin hardware
 * y para verificar con pruebas que las protecciones del informe se cumplen. Es PURO: el tiempo se
 * inyecta (`nowMs`), no toca red ni base de datos.
 *
 * Protecciones (informe, sección 16):
 *   1. Estado seguro al arrancar: bomba apagada.
 *   2. Tiempo máximo de riego por ciclo (corte duro, evaluado en cada vuelta del bucle).
 *   3. Espera obligatoria entre riegos (protege el motor de arranques repetidos).
 *   4. Riego bloqueado por temperatura alta o sin lectura válida (falla de sensor).
 */

export type PumpStateName = 'idle' | 'riego' | 'espera' | 'bloq_temp' | 'bloq_sensor' | 'saturado'
export type PumpOnWhy = 'auto' | 'manual'
export type PumpOffWhy = 'objetivo' | 'tiempo_max' | 'orden' | 'seguridad' | 'saturado'

export interface ControllerConfig {
  ver: number
  intervalS: number
  soilOn: number
  soilOff: number
  soilSat: number
  tempMax: number
  pumpMaxS: number
  waitS: number
}

export const DEFAULT_CONFIG: ControllerConfig = {
  ver: 0, intervalS: 300, soilOn: 700, soilOff: 500, soilSat: 300, tempMax: 40, pumpMaxS: 30, waitS: 300,
}

/** Límites duros del nodo: ninguna configuración u orden del servidor puede superarlos. */
export const LIMITS = {
  intervalS: [5, 3600], tempMax: [30, 60], pumpMaxS: [5, 120], waitS: [60, 3600],
} as const

/** Muestreo mientras la bomba está encendida (respuesta rápida para cortar a tiempo). */
export const SAMPLE_WHILE_PUMPING_S = 5

export interface Sample {
  /** Lectura del YL-38 en escala 0…1023 o null si el sensor falló. */
  soilRaw: number | null
  tempC: number | null
}

export interface PumpEventRecord {
  t: 'pump_on' | 'pump_off'
  why: PumpOnWhy | PumpOffWhy
  atMs: number
  durS?: number
  cmd?: string
}

export interface Order { id: string; tipo: 'riego' | 'parar'; dur_s?: number; vence_s: number }
export interface OrderAck { id: string; estado: 'ejecutada' | 'rechazada'; detalle: string }

const inRange = (v: number, [lo, hi]: readonly [number, number]) => Number.isFinite(v) && v >= lo && v <= hi

/** Devuelve la configuración validada o null si viola las reglas (entonces se ignora COMPLETA). */
export function validateConfig(c: ControllerConfig): ControllerConfig | null {
  const ok =
    Number.isInteger(c.soilOn) && Number.isInteger(c.soilOff) && Number.isInteger(c.soilSat) &&
    c.soilSat < c.soilOff && c.soilOff < c.soilOn && c.soilSat >= 0 && c.soilOn <= 1023 &&
    inRange(c.intervalS, LIMITS.intervalS) && inRange(c.tempMax, LIMITS.tempMax) &&
    inRange(c.pumpMaxS, LIMITS.pumpMaxS) && inRange(c.waitS, LIMITS.waitS)
  return ok ? c : null
}

const REMEMBERED_ORDERS = 8

export class NodeController {
  private cfg: ControllerConfig
  private on = false
  private startMs = 0
  private startedBy: PumpOnWhy = 'auto'
  private limitMs = 0
  private startCmd: string | undefined
  private lastEndMs: number | null = null
  private idleState: PumpStateName = 'idle'
  private lastSoil: number | null = null
  private acks = new Map<string, OrderAck>()
  private queue: PumpEventRecord[] = []
  /** Relé: el estado seguro al arrancar es apagado. */
  constructor(cfg: ControllerConfig = DEFAULT_CONFIG) {
    this.cfg = validateConfig(cfg) ?? DEFAULT_CONFIG
  }

  get config(): ControllerConfig { return this.cfg }
  get pumpOn(): boolean { return this.on }

  /** Aplica una configuración recibida del servidor; si es inválida se ignora completa y se devuelve false. */
  setConfig(c: ControllerConfig): boolean {
    const v = validateConfig(c)
    if (!v) return false
    this.cfg = v
    return true
  }

  cooldownRemainingS(nowMs: number): number {
    if (this.lastEndMs === null) return 0
    return Math.max(0, Math.ceil((this.cfg.waitS * 1000 - (nowMs - this.lastEndMs)) / 1000))
  }

  runningS(nowMs: number): number {
    return this.on ? Math.floor((nowMs - this.startMs) / 1000) : 0
  }

  state(nowMs: number): PumpStateName {
    if (this.on) return 'riego'
    if (this.cooldownRemainingS(nowMs) > 0) return 'espera'
    return this.idleState
  }

  /** Eventos pendientes de informar al servidor (máx. 8). Se vacían con `ackEvents()` al recibir 200. */
  pendingEvents(): readonly PumpEventRecord[] { return this.queue }
  ackEvents(count: number): void { this.queue.splice(0, count) }

  private push(e: PumpEventRecord): void {
    this.queue.push(e)
    if (this.queue.length > 8) this.queue.shift()
  }

  private start(nowMs: number, why: PumpOnWhy, limitMs: number, cmd?: string): void {
    this.on = true
    this.startMs = nowMs
    this.startedBy = why
    this.limitMs = limitMs
    this.startCmd = cmd
    this.push({ t: 'pump_on', why, atMs: nowMs, ...(cmd ? { cmd } : {}) })
  }

  private stop(nowMs: number, why: PumpOffWhy): void {
    if (!this.on) return
    this.on = false
    this.lastEndMs = nowMs
    this.push({
      t: 'pump_off', why, atMs: nowMs, durS: Math.round((nowMs - this.startMs) / 1000),
      ...(this.startCmd ? { cmd: this.startCmd } : {}),
    })
    this.startCmd = undefined
  }

  /**
   * Una vuelta del bucle principal.
   *  - El CORTE POR TIEMPO se evalúa siempre (no depende de que haya lectura nueva).
   *  - `sample` solo llega cuando el nodo tomó una lectura (cada `intervalS`, o cada 5 s regando).
   */
  tick(nowMs: number, sample?: Sample): void {
    if (this.on && nowMs - this.startMs >= this.limitMs) {
      this.stop(nowMs, this.startedBy === 'manual' ? 'orden' : 'tiempo_max')
    }
    if (!sample) return

    this.lastSoil = sample.soilRaw
    const { soilRaw, tempC } = sample
    const c = this.cfg

    if (this.on) {
      if (soilRaw === null) this.stop(nowMs, 'seguridad')
      else if (soilRaw < c.soilSat) this.stop(nowMs, 'saturado')
      else if (this.startedBy === 'auto' && soilRaw <= c.soilOff) this.stop(nowMs, 'objetivo')
      return
    }

    // Bomba apagada: ¿corresponde iniciar riego automático?
    if (soilRaw === null) { this.idleState = 'bloq_sensor'; return }
    if (soilRaw < c.soilSat) { this.idleState = 'saturado'; return }
    if (soilRaw < c.soilOn) { this.idleState = 'idle'; return }
    // El suelo está SECO.
    if (tempC === null) { this.idleState = 'bloq_sensor'; return }
    if (tempC > c.tempMax) { this.idleState = 'bloq_temp'; return }
    this.idleState = 'idle'
    if (this.cooldownRemainingS(nowMs) > 0) return
    this.start(nowMs, 'auto', c.pumpMaxS * 1000)
  }

  /** Atiende una orden del servidor. Devuelve el acuse (o el acuse anterior si la orden ya se atendió). */
  handleOrder(order: Order, nowMs: number): OrderAck {
    const seen = this.acks.get(order.id)
    if (seen) return seen
    const ack = this.decide(order, nowMs)
    this.acks.set(order.id, ack)
    if (this.acks.size > REMEMBERED_ORDERS) this.acks.delete(this.acks.keys().next().value as string)
    return ack
  }

  private decide(order: Order, nowMs: number): OrderAck {
    const reject = (detalle: string): OrderAck => ({ id: order.id, estado: 'rechazada', detalle })
    const ok = (detalle: string): OrderAck => ({ id: order.id, estado: 'ejecutada', detalle })
    if (order.vence_s <= 0) return reject('orden vencida')

    if (order.tipo === 'parar') {
      if (!this.on) return ok('la bomba ya estaba apagada')
      this.stop(nowMs, 'orden')
      return ok('bomba detenida')
    }

    if (this.on) return reject('ya está regando')
    const wait = this.cooldownRemainingS(nowMs)
    if (wait > 0) return reject(`en espera entre riegos (faltan ${wait} s)`)
    if (this.lastSoil !== null && this.lastSoil < this.cfg.soilSat) return reject('suelo saturado')
    const asked = Math.round(order.dur_s ?? 0)
    if (asked < 1) return reject('duración inválida')
    const dur = Math.min(Math.max(asked, LIMITS.pumpMaxS[0]), this.cfg.pumpMaxS)
    this.start(nowMs, 'manual', dur * 1000, order.id)
    return ok(dur < asked ? `regando ${dur} s (acortada al máximo)` : `regando ${dur} s`)
  }
}
