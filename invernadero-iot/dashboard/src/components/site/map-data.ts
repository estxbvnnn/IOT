import type { SoilBand } from '@/lib/domain/soil'
import type { GreenhouseStatus, GreenhouseSummary, PumpState } from '@/lib/domain/types'
import { fmtAgo, fmtDuration, fmtNum } from '@/lib/format'

/**
 * Datos «ligeros» de un invernadero para el mapa (componente cliente): solo lo que se dibuja o se lee en
 * el tooltip. Todo serializable (números, textos y booleanos).
 */
export interface MapGreenhouse {
  code: string
  crop: string | null
  /** Posición del centro en metros, con origen en la esquina superior izquierda del predio. */
  x: number
  y: number
  distanceM: number
  status: GreenhouseStatus
  online: boolean
  ageS: number | null
  tempC: number | null
  humAir: number | null
  soilRaw: number | null
  band: SoilBand | null
  /** Límites de las bandas de este invernadero (tabla del YL-38: 300 y 700 por defecto). */
  satLimit: number
  onLimit: number
  pumpOn: boolean
  pumpState: PumpState | null
  pumpRunS: number | null
  cooldownS: number | null
}

/** Lo último que informó un nodo caído no es confiable: no se muestra la bomba «regando» ni el pulso. */
export function toMapItems(gs: readonly GreenhouseSummary[]): MapGreenhouse[] {
  return gs.map((g) => ({
    code: g.code, crop: g.crop, x: g.x, y: g.y, distanceM: g.distanceM, status: g.status, online: g.online, ageS: g.ageS,
    tempC: g.tempC, humAir: g.humAir, soilRaw: g.soilRaw, band: g.band,
    satLimit: g.thresholds.soilSat, onLimit: g.thresholds.soilOn,
    pumpOn: g.online && g.pumpOn === true, pumpState: g.pumpState, pumpRunS: g.pumpRunS, cooldownS: g.cooldownS,
  }))
}

export const STATUS_TEXT: Record<GreenhouseStatus, string> = {
  ok: 'Normal',
  warning: 'Atención',
  critical: 'Crítico',
  offline: 'Sin conexión',
  nodata: 'Sin datos',
}

export const BAND_TEXT: Record<SoilBand, string> = { saturado: 'saturado', optimo: 'óptimo', seco: 'seco' }

/** Texto corto del estado de la bomba. */
export function pumpText(g: Pick<MapGreenhouse, 'online' | 'pumpOn' | 'pumpState' | 'pumpRunS' | 'cooldownS' | 'status'>): string {
  if (!g.online) return 'sin datos'
  if (g.pumpOn) return g.pumpRunS ? `regando (${fmtDuration(g.pumpRunS)})` : 'regando'
  switch (g.pumpState) {
    case 'espera': return g.cooldownS && g.cooldownS > 0 ? `en espera (${Math.max(1, Math.ceil(g.cooldownS / 60))} min)` : 'en espera'
    case 'bloq_temp': return 'bloqueada por calor'
    case 'bloq_sensor': return 'bloqueada por falla de sensor'
    case 'saturado': return 'sin regar: suelo saturado'
    default: return 'apagada'
  }
}

/** Descripción completa para lectores de pantalla (el color nunca es la única señal). */
export function describeGreenhouse(g: MapGreenhouse): string {
  const parts = [
    `${g.code}${g.crop ? ` ${g.crop}` : ''}`,
    STATUS_TEXT[g.status],
  ]
  if (g.online) {
    if (g.tempC !== null) parts.push(`temperatura ${fmtNum(g.tempC)} °C`)
    if (g.humAir !== null) parts.push(`humedad del aire ${fmtNum(g.humAir, 0)} %`)
    if (g.band) parts.push(`suelo ${BAND_TEXT[g.band]}`)
    parts.push(`bomba ${pumpText(g)}`)
  } else {
    parts.push(g.ageS === null ? 'sin lecturas' : `última lectura ${fmtAgo(g.ageS)}`)
  }
  return parts.join(', ')
}
