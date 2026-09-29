/** Formateo para la interfaz: español de Chile y hora local del predio (America/Santiago). */

export const TZ = 'America/Santiago'

const num = (d: number) => new Intl.NumberFormat('es-CL', { minimumFractionDigits: d, maximumFractionDigits: d })
const cache = new Map<number, Intl.NumberFormat>()
function nf(d: number): Intl.NumberFormat {
  let f = cache.get(d)
  if (!f) cache.set(d, (f = num(d)))
  return f
}

/** 24,3 · «—» si no hay dato. */
export function fmtNum(v: number | null | undefined, digits = 1): string {
  return v === null || v === undefined || Number.isNaN(v) ? '—' : nf(digits).format(v)
}

/** 24,3 °C */
export function fmtUnit(v: number | null | undefined, unit: string, digits = 1): string {
  return v === null || v === undefined ? '—' : `${fmtNum(v, digits)} ${unit}`.trim()
}

const HM = new Intl.DateTimeFormat('es-CL', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
const HMS = new Intl.DateTimeFormat('es-CL', { timeZone: TZ, hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' })
const DM = new Intl.DateTimeFormat('es-CL', { timeZone: TZ, day: '2-digit', month: '2-digit' })
const DAY = new Intl.DateTimeFormat('es-CL', { timeZone: TZ, weekday: 'short', day: '2-digit' })
const FULL = new Intl.DateTimeFormat('es-CL', { timeZone: TZ, day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
const FULLS = new Intl.DateTimeFormat('es-CL', { timeZone: TZ, day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' })

type T = number | string | Date

const d = (t: T) => (t instanceof Date ? t : new Date(t))

export const fmtHM = (t: T) => HM.format(d(t))
export const fmtHMS = (t: T) => HMS.format(d(t))
export const fmtDM = (t: T) => DM.format(d(t))
export const fmtDay = (t: T) => DAY.format(d(t)).replace('.', '')
export const fmtDateTime = (t: T) => FULL.format(d(t)).replace(',', '')
export const fmtDateTimeSec = (t: T) => FULLS.format(d(t)).replace(',', '')

/** hace 12 s · hace 3 min · hace 2 h · hace 4 d */
export function fmtAgo(ageS: number | null | undefined): string {
  if (ageS === null || ageS === undefined) return 'sin datos'
  if (ageS < 5) return 'ahora'
  if (ageS < 60) return `hace ${Math.round(ageS)} s`
  if (ageS < 3600) return `hace ${Math.round(ageS / 60)} min`
  if (ageS < 86_400) return `hace ${Math.round(ageS / 3600)} h`
  return `hace ${Math.round(ageS / 86_400)} d`
}

/** 30 s · 2 min 5 s · 1 h 05 min */
export function fmtDuration(s: number | null | undefined): string {
  if (s === null || s === undefined) return '—'
  const t = Math.round(s)
  if (t < 60) return `${t} s`
  if (t < 3600) return `${Math.floor(t / 60)} min${t % 60 ? ` ${t % 60} s` : ''}`
  return `${Math.floor(t / 3600)} h ${String(Math.floor((t % 3600) / 60)).padStart(2, '0')} min`
}

/** 1.234 lx · 12,5 klx */
export function fmtLux(lux: number | null | undefined): string {
  if (lux === null || lux === undefined) return '—'
  return lux >= 10_000 ? `${fmtNum(lux / 1000, 1)} klx` : `${fmtNum(lux, 0)} lx`
}

export function fmtLiters(l: number | null | undefined): string {
  if (l === null || l === undefined) return '—'
  return l >= 100 ? `${fmtNum(l, 0)} L` : `${fmtNum(l, 1)} L`
}
