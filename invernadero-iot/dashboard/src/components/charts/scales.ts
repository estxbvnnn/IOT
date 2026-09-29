import { TZ } from '@/lib/format'

/** Escalas y ticks de los gráficos. Todo puro y probado (tests/unit/scales.test.ts). */

export function niceTicks(lo: number, hi: number, target = 5): number[] {
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return []
  if (hi <= lo) hi = lo + 1
  const rough = (hi - lo) / Math.max(target, 1)
  const pow = 10 ** Math.floor(Math.log10(rough))
  const frac = rough / pow
  const step = (frac < 1.5 ? 1 : frac < 3 ? 2 : frac < 7 ? 5 : 10) * pow
  // Múltiplos ENTEROS del paso, redondeados a los decimales del paso: evita 0,6000000000000001.
  const decimals = Math.max(0, 1 - Math.floor(Math.log10(step)))
  const k0 = Math.ceil(lo / step - 1e-9)
  const k1 = Math.floor(hi / step + 1e-9)
  const out: number[] = []
  for (let k = k0; k <= k1; k++) out.push(Number((k * step).toFixed(decimals)) + 0) // «+ 0» convierte -0 en 0
  return out
}

/** Dominio Y «agradable» que envuelve los datos con un margen, opcionalmente anclado a un mínimo. */
export function niceDomain(values: readonly number[], opts: { min?: number; max?: number; pad?: number } = {}): [number, number] {
  if (values.length === 0) return [opts.min ?? 0, opts.max ?? 1]
  let lo = Math.min(...values)
  let hi = Math.max(...values)
  if (hi === lo) {
    lo -= 1
    hi += 1
  }
  const pad = (hi - lo) * (opts.pad ?? 0.12)
  lo = opts.min !== undefined ? opts.min : lo - pad
  hi = opts.max !== undefined ? opts.max : hi + pad
  const t = niceTicks(lo, hi, 5)
  return [Math.min(lo, t[0] ?? lo), Math.max(hi, t[t.length - 1] ?? hi)]
}

/** Desfase (ms) de la zona horaria del predio respecto de UTC en un instante dado. */
export function tzOffsetMs(ms: number, tz: string = TZ): number {
  const p = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric',
  }).formatToParts(new Date(ms))
  const g = (t: string) => Number(p.find((x) => x.type === t)?.value)
  return Date.UTC(g('year'), g('month') - 1, g('day'), g('hour'), g('minute'), g('second')) - Math.floor(ms / 1000) * 1000
}

const MIN = 60_000
const HOUR = 3_600_000
const DAY = 86_400_000
const STEPS = [MIN, 2 * MIN, 5 * MIN, 10 * MIN, 15 * MIN, 30 * MIN, HOUR, 2 * HOUR, 3 * HOUR, 4 * HOUR, 6 * HOUR, 12 * HOUR, DAY, 2 * DAY, 5 * DAY, 7 * DAY]

export interface TimeTick { t: number; /** true si el paso es de un día o más (etiqueta de fecha) */ day: boolean }

/** Ticks de tiempo alineados a la hora LOCAL del predio (medianoche, horas en punto…). */
export function timeTicks(from: number, to: number, target = 6): TimeTick[] {
  const span = to - from
  if (span <= 0) return []
  const step = STEPS.find((s) => span / s <= target) ?? STEPS[STEPS.length - 1]!
  const off = tzOffsetMs(from)
  const first = Math.ceil((from + off) / step) * step - off
  const out: TimeTick[] = []
  for (let t = first; t <= to; t += step) out.push({ t, day: step >= DAY })
  return out
}

/** Índice del valor de `xs` (ordenado ascendente) más cercano a `x`. */
export function nearestIndex(xs: readonly number[], x: number): number {
  if (xs.length === 0) return -1
  let lo = 0
  let hi = xs.length - 1
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (xs[mid]! < x) lo = mid + 1
    else hi = mid
  }
  if (lo > 0 && Math.abs(xs[lo - 1]! - x) <= Math.abs(xs[lo]! - x)) return lo - 1
  return lo
}

/** Une, ordena y deduplica las marcas de tiempo de varias series. */
export function mergeTimes(series: readonly { points: readonly (readonly [number, number | null])[] }[]): number[] {
  const set = new Set<number>()
  for (const s of series) for (const p of s.points) set.add(p[0])
  return [...set].sort((a, b) => a - b)
}

/** Divide una serie en tramos continuos: un valor nulo o un hueco mayor a `gapMs` interrumpe la línea. */
export function splitSegments(points: readonly (readonly [number, number | null])[], gapMs: number): [number, number][][] {
  const out: [number, number][][] = []
  let cur: [number, number][] = []
  let prevT: number | null = null
  for (const [t, v] of points) {
    if (v === null) {
      if (cur.length) out.push(cur)
      cur = []
      prevT = null
      continue
    }
    if (prevT !== null && t - prevT > gapMs && cur.length) {
      out.push(cur)
      cur = []
    }
    cur.push([t, v])
    prevT = t
  }
  if (cur.length) out.push(cur)
  return out
}
