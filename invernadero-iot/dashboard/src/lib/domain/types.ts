import type { SoilBand } from './soil'

/** Tipos compartidos servidor ↔ cliente. Solo datos serializables (fechas como ISO o epoch ms). */

export type PumpState = 'idle' | 'riego' | 'espera' | 'bloq_temp' | 'bloq_sensor' | 'saturado'

export type GreenhouseStatus = 'ok' | 'warning' | 'critical' | 'offline' | 'nodata'

export type Severity = 'info' | 'warning' | 'critical'
export type AlertStatus = 'open' | 'acknowledged' | 'resolved'

export const ALERT_TYPES = [
  'soil_dry', 'soil_saturated', 'temp_high', 'temp_low', 'hum_air_high', 'hum_air_low',
  'wind_high', 'sensor_fault', 'node_offline', 'pump_anomaly',
] as const
export type AlertType = (typeof ALERT_TYPES)[number]

export interface ThresholdsDTO {
  soilOn: number
  soilOff: number
  soilSat: number
  tempMax: number
  tempHeat: number
  tempCold: number
  tempFrost: number
  humAirMin: number
  humAirMax: number
  pumpMaxS: number
  pumpWaitS: number
  /** Riego automático activado: si es false el nodo no inicia riegos por humedad (el manual sigue funcionando). */
  autoEnabled: boolean
  intervalS: number
  version: number
  updatedAt: string
}

export interface GreenhouseSummary {
  id: number
  code: string
  name: string
  crop: string | null
  x: number
  y: number
  areaM2: number | null
  /** Distancia en línea recta a la subestación del mástil (m). */
  distanceM: number
  hasNode: boolean
  nodeEnabled: boolean
  lastSeen: string | null
  ageS: number | null
  online: boolean
  status: GreenhouseStatus
  tempC: number | null
  humAir: number | null
  soilRaw: number | null
  soilPct: number | null
  band: SoilBand | null
  lightLux: number | null
  pumpOn: boolean | null
  pumpState: PumpState | null
  pumpRunS: number | null
  cooldownS: number | null
  faults: string[]
  openAlerts: { critical: number; warning: number; info: number }
  thresholds: ThresholdsDTO
  /** Lecturas crudas de suelo de las últimas 6 h (promedio cada 15 min). */
  soilSpark: (number | null)[]
  irrigationsToday: number
  waterTodayL: number
  /** % de las lecturas de las últimas 24 h dentro de la banda óptima. */
  optimalPct24h: number | null
}

export interface AlertDTO {
  id: number
  greenhouseId: number | null
  greenhouseCode: string | null
  type: AlertType | string
  severity: Severity
  status: AlertStatus
  message: string
  openedAt: string
  lastSeenAt: string
  occurrences: number
  acknowledgedAt: string | null
  acknowledgedBy: string | null
  resolvedAt: string | null
  resolvedReason: 'auto' | 'manual' | null
}

export interface WindSummary {
  ms: number | null
  ageS: number | null
  online: boolean
  warn: number
  crit: number
  level: 'ok' | 'warning' | 'critical' | 'nodata'
}

export interface SiteOverview {
  siteName: string
  widthM: number
  heightM: number
  substation: { x: number; y: number }
  /** Estanque de agua (opcional): null = el predio no tiene o no se dibuja. */
  tank: { x: number; y: number } | null
  generatedAt: string
  greenhouses: GreenhouseSummary[]
  wind: WindSummary
  recentAlerts: AlertDTO[]
  kpis: {
    total: number
    ok: number
    warning: number
    critical: number
    offline: number
    nodata: number
    pumpsOn: number
    avgTempC: number | null
    avgHumAir: number | null
    avgSoilPct: number | null
    irrigationsToday: number
    waterTodayL: number
    activeAlerts: number
  }
}

export type Point = [t: number, v: number | null]

/** Rangos de tiempo del detalle de un invernadero. `bucketS` = ancho de cada promedio en segundos. */
export const RANGE_KEYS = ['1h', '6h', '24h', '7d', '30d'] as const
export type RangeKey = (typeof RANGE_KEYS)[number]

export const RANGE_SPECS: Record<RangeKey, { label: string; ms: number; bucketS: number }> = {
  '1h': { label: 'Última hora', ms: 3_600_000, bucketS: 30 },
  '6h': { label: '6 horas', ms: 6 * 3_600_000, bucketS: 120 },
  '24h': { label: '24 horas', ms: 24 * 3_600_000, bucketS: 600 },
  '7d': { label: '7 días', ms: 7 * 86_400_000, bucketS: 3_600 },
  '30d': { label: '30 días', ms: 30 * 86_400_000, bucketS: 4 * 3_600 },
}

export function isRangeKey(v: unknown): v is RangeKey {
  return typeof v === 'string' && (RANGE_KEYS as readonly string[]).includes(v)
}

export interface IrrigationEventDTO {
  id: number
  startedAt: string
  endedAt: string | null
  durationS: number | null
  trigger: 'auto' | 'manual' | 'schedule'
  endReason: string | null
  waterL: number | null
  soilRawStart: number | null
  soilRawEnd: number | null
}

export interface SeriesBundle {
  from: number
  to: number
  bucketS: number
  temp: Point[]
  humAir: Point[]
  soilRaw: Point[]
  soilPct: Point[]
  light: Point[]
  /** Solo para quienes pueden ver la calidad de enlace. */
  rssi: Point[] | null
  events: IrrigationEventDTO[]
}

/** Invernadero tal como lo administra el administrador (activos y dados de baja). */
export interface ManagedGreenhouseDTO {
  id: number
  code: string
  name: string
  crop: string | null
  /** Centro del invernadero en el predio (m), con origen en la esquina superior izquierda. */
  x: number
  y: number
  areaM2: number | null
  flowLph: number
  archived: boolean
  archivedAt: string | null
  createdAt: string
  /** Nodo ESP32 asociado (uno por invernadero); null si no tiene. */
  node: { id: number; enabled: boolean; tokenPrefix: string; lastSeen: string | null } | null
}

/** Ajustes del predio que definen el mapa. */
export interface SiteSettingsDTO {
  siteName: string
  widthM: number
  heightM: number
  substation: { x: number; y: number }
  tank: { x: number; y: number } | null
}

export interface DeviceDTO {
  id: number
  kind: 'greenhouse' | 'mast'
  label: string
  greenhouseCode: string | null
  /** El invernadero del nodo está dado de baja (el nodo no puede reactivarse sin reactivar el invernadero). */
  greenhouseArchived: boolean
  enabled: boolean
  tokenPrefix: string
  tokenRotatedAt: string
  fw: string | null
  lastSeen: string | null
  ageS: number | null
  online: boolean
  rssi: number | null
  snr: number | null
  uptimeS: number | null
  faults: string[]
  intervalS: number
  frames24h: number
  expected24h: number
  /** Porcentaje de tramas recibidas frente a las esperadas en 24 h. */
  linkPct: number | null
  rssiSpark: (number | null)[]
}
