import { describe, expect, it } from 'vitest'
import { mergeTimes, nearestIndex, niceDomain, niceTicks, splitSegments, timeTicks, tzOffsetMs } from '@/components/charts/scales'
import { localParts } from '@/lib/services/schedules'

describe('ticks numéricos', () => {
  it('elige pasos redondos (1, 2, 5 × 10ⁿ)', () => {
    expect(niceTicks(0, 100, 5)).toEqual([0, 20, 40, 60, 80, 100])
    expect(niceTicks(0, 1023, 4)).toEqual([0, 200, 400, 600, 800, 1000])
    expect(niceTicks(10, 34, 5)).toEqual([10, 15, 20, 25, 30])
    expect(niceTicks(0, 1, 4)).toEqual([0, 0.2, 0.4, 0.6, 0.8, 1])
  })
  it('no acumula errores de coma flotante', () => {
    for (const t of niceTicks(0, 0.7, 7)) expect(String(t).length).toBeLessThan(6)
  })
  it('un rango vacío o inválido no rompe', () => {
    expect(niceTicks(5, 5).length).toBeGreaterThan(0)
    expect(niceTicks(NaN, 3)).toEqual([])
  })
  it('el dominio envuelve los datos, con márgenes y anclajes opcionales', () => {
    const [lo, hi] = niceDomain([12.4, 27.9])
    expect(lo).toBeLessThanOrEqual(12.4)
    expect(hi).toBeGreaterThanOrEqual(27.9)
    expect(niceDomain([5, 9], { min: 0 })[0]).toBe(0)
    expect(niceDomain([])).toEqual([0, 1])
    const flat = niceDomain([7, 7])
    expect(flat[0]).toBeLessThan(7)
    expect(flat[1]).toBeGreaterThan(7)
  })
})

describe('ticks de tiempo en hora local de Chile', () => {
  const from = Date.UTC(2026, 8, 28, 3, 0, 0) // 00:00 local (UTC-3)
  it('el desfase de Santiago es UTC-3 en septiembre y UTC-4 en invierno', () => {
    expect(tzOffsetMs(Date.UTC(2026, 8, 28, 12))).toBe(-3 * 3600_000)
    expect(tzOffsetMs(Date.UTC(2026, 6, 15, 12))).toBe(-4 * 3600_000)
  })
  it('para 24 h cae en horas locales redondas (no en horas UTC)', () => {
    const ticks = timeTicks(from, from + 24 * 3600_000, 6)
    expect(ticks.length).toBeGreaterThanOrEqual(5)
    for (const t of ticks) expect(localParts(new Date(t.t)).minutes % 60).toBe(0)
    expect(ticks.every((t) => !t.day)).toBe(true)
    // El paso es de 4 h: 00:00, 04:00, 08:00…
    expect(ticks.map((t) => localParts(new Date(t.t)).minutes / 60).slice(0, 3)).toEqual([0, 4, 8])
  })
  it('para 7 días marca medianoches locales y etiqueta por día', () => {
    const ticks = timeTicks(from, from + 7 * 86_400_000, 8)
    expect(ticks.length).toBe(8)
    expect(ticks.every((t) => t.day)).toBe(true)
    for (const t of ticks) expect(localParts(new Date(t.t)).minutes).toBe(0)
  })
  it('para 1 hora usa minutos', () => {
    const ticks = timeTicks(from, from + 3600_000, 6)
    expect(ticks.length).toBeGreaterThanOrEqual(4)
    expect(ticks[1]!.t - ticks[0]!.t).toBeLessThanOrEqual(15 * 60_000)
  })
  it('un intervalo inválido no produce ticks', () => {
    expect(timeTicks(10, 10)).toEqual([])
    expect(timeTicks(10, 5)).toEqual([])
  })
})

describe('utilidades de interacción', () => {
  it('nearestIndex encuentra el más cercano, incluso en los extremos', () => {
    const xs = [10, 20, 30, 45]
    expect(nearestIndex(xs, 0)).toBe(0)
    expect(nearestIndex(xs, 14)).toBe(0)
    expect(nearestIndex(xs, 16)).toBe(1)
    expect(nearestIndex(xs, 37)).toBe(2)
    expect(nearestIndex(xs, 40)).toBe(3)
    expect(nearestIndex(xs, 999)).toBe(3)
    expect(nearestIndex([], 5)).toBe(-1)
  })
  it('mergeTimes une y ordena las marcas de varias series', () => {
    expect(mergeTimes([{ points: [[3, 1], [1, 1]] }, { points: [[2, null], [3, 5]] }])).toEqual([1, 2, 3])
  })
  it('splitSegments corta en valores nulos y en huecos grandes', () => {
    const pts: [number, number | null][] = [[0, 1], [10, 2], [20, null], [30, 4], [200, 5], [210, 6]]
    expect(splitSegments(pts, 50)).toEqual([[[0, 1], [10, 2]], [[30, 4]], [[200, 5], [210, 6]]])
    expect(splitSegments([], 10)).toEqual([])
  })
})
