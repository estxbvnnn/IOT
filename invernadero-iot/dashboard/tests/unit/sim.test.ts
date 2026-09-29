import { describe, expect, it } from 'vitest'
import { DEFAULT_CONFIG } from '@/lib/sim/controller'
import { generateHistory } from '@/lib/sim/history'
import { GreenhouseWorld, gaussian, mulberry32 } from '@/lib/sim/world'

const START = Date.UTC(2026, 8, 25, 3, 0, 0) // 25-sep-2026 03:00 UTC = 00:00 en Santiago
const HOURS = 72

const run = (seed: number, hours = HOURS) =>
  generateHistory({ seed, startMs: START, endMs: START + hours * 3600_000, config: DEFAULT_CONFIG })

describe('generador aleatorio determinista', () => {
  it('la misma semilla produce la misma secuencia y semillas distintas producen otra', () => {
    const a = mulberry32(42), b = mulberry32(42), c = mulberry32(43)
    const sa = [a(), a(), a()], sb = [b(), b(), b()]
    expect(sa).toEqual(sb)
    expect([c(), c(), c()]).not.toEqual(sa)
    for (const v of sa) expect(v).toBeGreaterThanOrEqual(0), expect(v).toBeLessThan(1)
  })

  it('el ruido gaussiano tiene media ≈ 0 y desviación ≈ 1', () => {
    const r = mulberry32(1)
    const xs = Array.from({ length: 20000 }, () => gaussian(r))
    const mean = xs.reduce((s, x) => s + x, 0) / xs.length
    const sd = Math.sqrt(xs.reduce((s, x) => s + (x - mean) ** 2, 0) / xs.length)
    expect(Math.abs(mean)).toBeLessThan(0.05)
    expect(sd).toBeGreaterThan(0.95)
    expect(sd).toBeLessThan(1.05)
  })
})

describe('modelo físico del invernadero', () => {
  it('sin riego el suelo se seca (la lectura del YL-38 sube) y con la bomba baja', () => {
    const w = new GreenhouseWorld({ seed: 5, soil0: 500 })
    let now = START + 9 * 3600_000 // media mañana local: hay sol
    const s0 = w.soilRaw()
    for (let i = 0; i < 6 * 60; i++) { w.step(60, 60, now, false); now += 60_000 }
    const dried = w.soilRaw()
    expect(dried).toBeGreaterThan(s0 + 40)
    for (let i = 0; i < 30; i++) { w.step(1, 1, now, true); now += 1000 }
    for (let i = 0; i < 20; i++) { w.step(10, 10, now, false); now += 10_000 } // la sonda tarda en «ver» el agua
    expect(w.soilRaw()).toBeLessThan(dried - 60)
  })

  it('la temperatura sigue un ciclo diario: más cálida por la tarde que de madrugada', () => {
    const w = new GreenhouseWorld({ seed: 9, tempOffset: 0 })
    const night = w.environment(START + 6 * 3600_000).tempC // 06:00 local (START = 00:00 en Santiago)
    const afternoon = w.environment(START + 15 * 3600_000).tempC // 15:00 local
    expect(afternoon).toBeGreaterThan(night + 10)
    expect(w.environment(START).lux).toBe(0) // medianoche: sin luz
  })

  it('la lectura nunca sale de la escala 0–1023 aunque se fuerce', () => {
    const w = new GreenhouseWorld({ seed: 1 })
    w.bumpSoil(5000)
    expect(w.soilRaw()).toBeLessThanOrEqual(1023)
    w.bumpSoil(-9000)
    expect(w.soilRaw()).toBeGreaterThanOrEqual(0)
  })
})

describe('historial sintético (72 h, riego automático de los diez invernaderos)', () => {
  const runs = Array.from({ length: 10 }, (_, i) => run(1001 + i))

  it('es reproducible', () => {
    expect(run(1003, 24)).toEqual(run(1003, 24))
  })

  it('las lecturas están ordenadas, dentro de escala y con valores físicamente plausibles', () => {
    for (const h of runs) {
      for (let i = 1; i < h.readings.length; i++) expect(h.readings[i]!.ts).toBeGreaterThanOrEqual(h.readings[i - 1]!.ts)
      for (const r of h.readings) {
        expect(r.soilRaw).toBeGreaterThanOrEqual(0)
        expect(r.soilRaw).toBeLessThanOrEqual(1023)
        expect(r.tempC).toBeGreaterThan(-5)
        expect(r.tempC).toBeLessThan(45)
        expect(r.humAir).toBeGreaterThanOrEqual(0)
        expect(r.humAir).toBeLessThanOrEqual(100)
        expect(r.lightLux).toBeGreaterThanOrEqual(0)
      }
    }
  })

  it('cada diez invernaderos riega a lo largo de tres días', () => {
    for (const h of runs) expect(h.irrigations.length).toBeGreaterThanOrEqual(1)
  })

  it('NINGÚN riego supera el máximo de 30 s (corte duro)', () => {
    for (const h of runs) for (const e of h.irrigations) expect(e.durationS).toBeLessThanOrEqual(30)
  })

  it('respeta la espera de 5 min entre riegos', () => {
    for (const h of runs) {
      for (let i = 1; i < h.irrigations.length; i++) {
        const gap = (h.irrigations[i]!.startedAt - h.irrigations[i - 1]!.endedAt) / 1000
        expect(gap).toBeGreaterThanOrEqual(DEFAULT_CONFIG.waitS - 1)
      }
    }
  })

  it('los riegos automáticos empiezan con el suelo seco y bajan la lectura', () => {
    let improved = 0, total = 0
    for (const h of runs) {
      for (const e of h.irrigations) {
        expect(e.soilRawStart).toBeGreaterThanOrEqual(DEFAULT_CONFIG.soilOn - 15) // ruido de ±5 de la sonda
        total++
        if (e.soilRawEnd < e.soilRawStart) improved++
      }
    }
    expect(improved / total).toBeGreaterThan(0.5)
  })

  it('el suelo se mantiene mayormente en la banda óptima o seca, casi nunca saturado', () => {
    const all = runs.flatMap((h) => h.readings)
    const saturated = all.filter((r) => r.soilRaw < 300).length / all.length
    expect(saturated).toBeLessThan(0.05)
  })

  it('cada motivo de término es uno de los que define el contrato', () => {
    const ok = new Set(['objetivo', 'tiempo_max', 'orden', 'seguridad', 'saturado'])
    for (const h of runs) for (const e of h.irrigations) expect(ok.has(e.endReason)).toBe(true)
  })
})
