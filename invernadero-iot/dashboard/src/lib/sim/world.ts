/**
 * Modelo físico simplificado de un invernadero, para simular sensores realistas sin hardware.
 * Determinista: con la misma semilla produce siempre la misma «historia» (útil para pruebas y seed).
 *
 * Diseño de los tiempos (importa para acelerar la simulación en una demo):
 *  - Ambiente (temperatura, luz, evaporación) corre en tiempo VIRTUAL: se puede acelerar.
 *  - La bomba y el retardo del sensor corren en tiempo REAL (la bomba real no se acelera).
 *
 * Sensor de suelo (YL-38, escala 0…1023): a más seco, MÁS alta la lectura.
 */
import { localParts } from '../services/schedules'

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Ruido gaussiano N(0,1) por Box–Muller. */
export function gaussian(rng: () => number): number {
  const u = Math.max(rng(), 1e-12)
  const v = rng()
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v)
}

export interface WorldOptions {
  seed: number
  /** Lectura inicial del suelo (0…1023). */
  soil0?: number
  /** Ajuste de temperatura media de este invernadero (°C). */
  tempOffset?: number
}

export interface Environment {
  tempC: number
  humAir: number
  lux: number
}

const SOIL_MIN = 260 // saturación física del sustrato
const SOIL_MAX = 1000

export class GreenhouseWorld {
  private rng: () => number
  private tempNoise = 0
  private cloud = 1
  private cloudTarget = 1
  private soilTrue: number
  private soilRead: number
  readonly tempOffset: number

  constructor(opts: WorldOptions) {
    this.rng = mulberry32(opts.seed)
    this.tempOffset = opts.tempOffset ?? (this.rng() - 0.5) * 3
    this.soilTrue = opts.soil0 ?? 470 + this.rng() * 120
    this.soilRead = this.soilTrue
  }

  /** Temperatura, humedad del aire y luz para una hora local del predio (curva diaria + ruido lento). */
  environment(virtualNowMs: number): Environment {
    const { minutes } = localParts(new Date(virtualNowMs))
    const h = minutes / 60
    // Temperatura interior: mínimo hacia las 06:00, máximo hacia las 15:00.
    const base = 19 + this.tempOffset + 9 * Math.sin((2 * Math.PI * (h - 9)) / 24)
    const tempC = base + this.tempNoise
    // Humedad relativa: inversa a la temperatura.
    const humAir = Math.min(98, Math.max(25, 86 - 2.3 * (tempC - 10) + this.tempNoise * 1.5))
    // Luz: campana entre las 06:30 y las 19:30, atenuada por nubes y por el polietileno.
    const day = h >= 6.5 && h <= 19.5 ? Math.sin((Math.PI * (h - 6.5)) / 13) : 0
    const lux = Math.max(0, Math.min(65_000, day * 52_000 * this.cloud))
    return { tempC, humAir, lux }
  }

  /**
   * Avanza la física.
   * @param dtRealS   segundos reales transcurridos (bomba y retardo del sensor)
   * @param dtVirtS   segundos virtuales transcurridos (evaporación y clima)
   */
  step(dtRealS: number, dtVirtS: number, virtualNowMs: number, pumpOn: boolean): void {
    const env = this.environment(virtualNowMs)
    // Clima: ruido de temperatura que revierte a 0 y nubosidad que deriva lentamente.
    const k = Math.min(1, dtVirtS / 1800)
    this.tempNoise += (0 - this.tempNoise) * k + gaussian(this.rng) * 0.35 * Math.sqrt(k)
    this.tempNoise = Math.max(-3, Math.min(3, this.tempNoise))
    if (this.rng() < Math.min(1, dtVirtS / 5400)) this.cloudTarget = 0.55 + this.rng() * 0.45
    this.cloud += (this.cloudTarget - this.cloud) * Math.min(1, dtVirtS / 1200)

    // Evaporación (sube la lectura): depende de temperatura y luz. ~4/h de noche, ~25–40/h a pleno sol.
    const perHour = 3 + 0.9 * Math.max(0, env.tempC - 8) + 14 * (env.lux / 52_000)
    this.soilTrue += (perHour / 3600) * dtVirtS
    // Riego: cada segundo de bomba baja la humedad efectiva del sustrato.
    if (pumpOn) this.soilTrue -= 6.5 * dtRealS
    this.soilTrue = Math.min(SOIL_MAX, Math.max(SOIL_MIN, this.soilTrue))
    // La sonda tarda en «ver» el agua (difusión): respuesta de primer orden con τ = 45 s reales.
    this.soilRead += (this.soilTrue - this.soilRead) * (1 - Math.exp(-dtRealS / 45))
  }

  /** Lectura del YL-38 con ruido de sonda (±5) en escala 0…1023. */
  soilRaw(): number {
    return Math.round(Math.min(1023, Math.max(0, this.soilRead + gaussian(this.rng) * 5)))
  }

  /** Forzar un valor (escenarios de demo: p. ej. sequía). */
  bumpSoil(delta: number): void {
    this.soilTrue = Math.min(SOIL_MAX, Math.max(SOIL_MIN, this.soilTrue + delta))
    this.soilRead = Math.min(SOIL_MAX, Math.max(SOIL_MIN, this.soilRead + delta))
  }

  bumpTemp(delta: number): void {
    this.tempNoise = Math.max(-3, Math.min(30, this.tempNoise + delta))
  }

  /** Temperatura del sensor DHT22 (±0,5 °C) y humedad (±2 %). */
  dht(virtualNowMs: number): { tempC: number; humAir: number } {
    const e = this.environment(virtualNowMs)
    return {
      tempC: Math.round((e.tempC + gaussian(this.rng) * 0.25) * 10) / 10,
      humAir: Math.round(Math.min(100, Math.max(0, e.humAir + gaussian(this.rng))) * 10) / 10,
    }
  }

  lux(virtualNowMs: number): number {
    const e = this.environment(virtualNowMs)
    return Math.round(Math.max(0, e.lux * (1 + gaussian(this.rng) * 0.02)))
  }
}
