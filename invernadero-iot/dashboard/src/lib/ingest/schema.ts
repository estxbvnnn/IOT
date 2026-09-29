import { z } from 'zod'

/**
 * Esquema de la trama de telemetría — ver docs/contrato-api.md (protocolo v1).
 * Solo se valida la ESTRUCTURA aquí; los rangos físicos (temperatura, humedad…) se sanean después
 * para poder registrar la trama igualmente y levantar una alerta de sensor, en vez de perderla.
 */

export const FRAME_MAX_BYTES = 4096

const uint32 = z.number().int().min(0).max(0xffffffff)
const nullableNumber = z.number().finite().nullable()

export const pumpEventSchema = z.discriminatedUnion('t', [
  z.object({
    t: z.literal('pump_on'),
    why: z.enum(['auto', 'manual']),
    ago: z.number().int().min(0).max(86_400).default(0),
    cmd: z.uuid().optional(),
  }),
  z.object({
    t: z.literal('pump_off'),
    why: z.enum(['objetivo', 'tiempo_max', 'orden', 'seguridad', 'saturado']),
    ago: z.number().int().min(0).max(86_400).default(0),
    dur: z.number().int().min(0).max(3_600).optional(),
    cmd: z.uuid().optional(),
  }),
])
export type PumpEvent = z.infer<typeof pumpEventSchema>

export const ackSchema = z.object({
  id: z.uuid(),
  estado: z.enum(['ejecutada', 'rechazada']),
  detalle: z.string().max(200).optional(),
})
export type Ack = z.infer<typeof ackSchema>

export const PUMP_STATES = ['idle', 'riego', 'espera', 'bloq_temp', 'bloq_sensor', 'saturado'] as const

export const frameSchema = z.object({
  v: z.literal(1),
  fw: z.string().min(1).max(16),
  boot: uint32,
  seq: uint32.min(1),
  up: uint32,
  temp: nullableNumber,
  hum_aire: nullableNumber,
  suelo_raw: z.number().finite().nullable(),
  luz: nullableNumber.optional(),
  viento: nullableNumber.optional(),
  bomba: z.union([z.literal(0), z.literal(1)]),
  riego_s: z.number().int().min(0).max(86_400).optional(),
  est: z.enum(PUMP_STATES).optional(),
  esp: z.number().int().min(0).max(86_400).optional(),
  rssi: z.number().int().min(-160).max(0).optional(),
  snr: z.number().finite().min(-40).max(40).nullable().optional(),
  fallas: z.array(z.string().min(1).max(24)).max(8).optional(),
  ev: z.array(pumpEventSchema).max(8).optional(),
  acks: z.array(ackSchema).max(8).optional(),
})
export type Frame = z.infer<typeof frameSchema>

/** Rangos físicos válidos; un valor fuera de rango se descarta (null) y se registra la falla. */
export const RANGES = {
  temp: [-40, 80],
  hum: [0, 100],
  soil: [0, 1023],
  lux: [0, 65_535],
  wind: [0, 60],
} as const

export interface SanitizedFrame {
  tempC: number | null
  humAir: number | null
  soilRaw: number | null
  lightLux: number | null
  windMs: number | null
  faults: string[]
}

const inRange = (v: number, [lo, hi]: readonly [number, number]) => v >= lo && v <= hi

/** Descarta lecturas imposibles (informe, tabla 12: «validación de rango»). Puro y testeable. */
export function sanitizeFrame(f: Frame): SanitizedFrame {
  const faults = new Set<string>((f.fallas ?? []).filter((x) => /^[a-z0-9_]+$/.test(x)))
  const pick = (value: number | null | undefined, range: readonly [number, number], fault: string): number | null => {
    if (value === null || value === undefined) return null
    if (!inRange(value, range)) {
      faults.add(fault)
      return null
    }
    return value
  }
  const soil = pick(f.suelo_raw, RANGES.soil, 'suelo_rango')
  return {
    tempC: pick(f.temp, RANGES.temp, 'temp_rango'),
    humAir: pick(f.hum_aire, RANGES.hum, 'hum_rango'),
    soilRaw: soil === null ? null : Math.round(soil),
    lightLux: pick(f.luz, RANGES.lux, 'luz_rango'),
    windMs: pick(f.viento, RANGES.wind, 'viento_rango'),
    faults: [...faults].sort(),
  }
}
