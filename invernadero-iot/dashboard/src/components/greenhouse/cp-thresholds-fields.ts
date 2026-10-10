/**
 * Campos, límites y validación del formulario de umbrales. Lógica PURA (sin React ni servidor) para poder
 * probarla. Refleja las reglas de `thresholdsSchema` (src/lib/services/thresholds.ts), que sigue siendo la
 * autoridad: aquí solo se adelantan los errores, con mensajes en español, antes de viajar al servidor.
 */

export const THRESHOLD_KEYS = [
  'soilOn', 'soilOff', 'soilSat', 'tempMax', 'tempHeat', 'tempCold', 'tempFrost', 'humAirMin', 'humAirMax',
  'pumpMaxS', 'pumpWaitS', 'intervalS',
] as const

export type ThresholdKey = (typeof THRESHOLD_KEYS)[number]
export type ThresholdValues = Record<ThresholdKey, number>
export type ThresholdErrors = Partial<Record<ThresholdKey, string>>

export interface FieldSpec {
  label: string
  unit: string
  min: number
  max: number
  int: boolean
  step: number
  hint?: string
}

export const FIELD_SPECS: Record<ThresholdKey, FieldSpec> = {
  soilOn: { label: 'Iniciar riego con lectura ≥', unit: '/1023', min: 2, max: 1023, int: true, step: 1, hint: 'Suelo SECO: desde aquí se riega.' },
  soilOff: { label: 'Detener riego con lectura ≤', unit: '/1023', min: 1, max: 1022, int: true, step: 1, hint: 'Humedad objetivo: al llegar aquí se apaga.' },
  soilSat: { label: 'Saturado bajo', unit: '/1023', min: 0, max: 1021, int: true, step: 1, hint: 'Bajo este valor NO se riega.' },
  tempMax: { label: 'No iniciar riego sobre', unit: '°C', min: 30, max: 60, int: false, step: 0.5, hint: 'Solo inhibe el riego automático.' },
  tempHeat: { label: 'Alerta de calor desde', unit: '°C', min: -20, max: 60, int: false, step: 0.5 },
  tempCold: { label: 'Alerta de frío hasta', unit: '°C', min: -20, max: 60, int: false, step: 0.5 },
  tempFrost: { label: 'Alerta crítica de helada hasta', unit: '°C', min: -20, max: 60, int: false, step: 0.5 },
  humAirMin: { label: 'Humedad del aire mínima', unit: '%', min: 0, max: 100, int: false, step: 1 },
  humAirMax: { label: 'Humedad del aire máxima', unit: '%', min: 0, max: 100, int: false, step: 1 },
  pumpMaxS: { label: 'Máximo de riego por ciclo', unit: 's', min: 5, max: 120, int: true, step: 1, hint: 'Corte duro del nodo (5–120 s).' },
  pumpWaitS: { label: 'Espera entre riegos', unit: 's', min: 0, max: 3600, int: true, step: 10, hint: 'Protege el motor de arranques repetidos. 0 = sin espera (el nodo hace una pausa técnica de 3 s).' },
  intervalS: { label: 'Reporte del nodo cada', unit: 's', min: 5, max: 3600, int: true, step: 5, hint: 'El informe pide al menos una lectura cada 5 min (300 s).' },
}

/** Valores por defecto del sistema: la tabla de bandas de la clase (700/500/300) y los del informe. */
export const DEFAULT_THRESHOLDS: ThresholdValues = {
  soilOn: 700, soilOff: 500, soilSat: 300,
  tempMax: 40, tempHeat: 35, tempCold: 5, tempFrost: 2,
  humAirMin: 30, humAirMax: 90,
  pumpMaxS: 30, pumpWaitS: 300, intervalS: 300,
}

export const GROUPS: { id: string; title: string; description?: string; keys: readonly ThresholdKey[] }[] = [
  { id: 'riego', title: 'Riego automático', description: 'Escala 0–1023 del sensor YL-38: a mayor lectura, más seco.', keys: ['soilOn', 'soilOff', 'soilSat'] },
  { id: 'bomba', title: 'Seguridad de la bomba', keys: ['pumpMaxS', 'pumpWaitS', 'tempMax'] },
  { id: 'temp', title: 'Alertas de temperatura', keys: ['tempHeat', 'tempCold', 'tempFrost'] },
  { id: 'aire', title: 'Humedad del aire', keys: ['humAirMin', 'humAirMax'] },
  { id: 'reporte', title: 'Reporte del nodo', keys: ['intervalS'] },
]

const nf = new Intl.NumberFormat('es-CL', { maximumFractionDigits: 1 })
/** Enteros sin separador de miles (1023, 3600): «1.023» se leería mal en una escala de 10 bits. */
const fmt = (n: number) => (Number.isInteger(n) ? String(n) : nf.format(n))

/** Convierte el texto de un campo a número; «1,5» y «1.5» valen lo mismo. */
export function parseField(key: ThresholdKey, raw: string): { value: number } | { error: string } {
  const spec = FIELD_SPECS[key]
  const text = raw.trim().replace(',', '.')
  if (text === '') return { error: 'Ingresa un valor.' }
  if (!/^-?\d+(\.\d+)?$/.test(text)) return { error: 'Debe ser un número.' }
  const value = Number(text)
  if (!Number.isFinite(value)) return { error: 'Debe ser un número.' }
  if (spec.int && !Number.isInteger(value)) return { error: 'Debe ser un número entero.' }
  if (value < spec.min || value > spec.max) return { error: `Debe estar entre ${fmt(spec.min)} y ${fmt(spec.max)} ${spec.unit === '/1023' ? '' : spec.unit}`.trim() + '.' }
  return { value }
}

/** Reglas cruzadas (mismas que el servidor y que las restricciones de la base). */
export function orderErrors(v: ThresholdValues): ThresholdErrors {
  const e: ThresholdErrors = {}
  if (!(v.soilSat < v.soilOff && v.soilOff < v.soilOn)) {
    e.soilOff = 'Debe cumplirse: saturado < apagar < regar (escala 0–1023).'
  }
  if (!(v.tempFrost < v.tempCold && v.tempCold < v.tempHeat && v.tempHeat <= v.tempMax)) {
    e.tempHeat = 'Debe cumplirse: helada < frío < calor ≤ máxima de riego.'
  }
  if (!(v.humAirMin < v.humAirMax)) {
    e.humAirMin = 'La humedad mínima debe ser menor que la máxima.'
  }
  return e
}

export interface FormResult {
  values: ThresholdValues | null
  errors: ThresholdErrors
}

/** Valida todo el formulario (texto por campo). Devuelve los valores numéricos solo si no hay errores. */
export function validateForm(raw: Record<ThresholdKey, string>): FormResult {
  const errors: ThresholdErrors = {}
  const values: Partial<ThresholdValues> = {}
  for (const k of THRESHOLD_KEYS) {
    const r = parseField(k, raw[k])
    if ('error' in r) errors[k] = r.error
    else values[k] = r.value
  }
  if (Object.keys(errors).length === 0) {
    const cross = orderErrors(values as ThresholdValues)
    Object.assign(errors, cross)
  }
  return { values: Object.keys(errors).length === 0 ? (values as ThresholdValues) : null, errors }
}

/** Solo los campos que cambiaron respecto de la base (el servidor recibe un parche). */
export function changedFields(next: ThresholdValues, base: ThresholdValues): Partial<ThresholdValues> {
  const out: Partial<ThresholdValues> = {}
  for (const k of THRESHOLD_KEYS) if (next[k] !== base[k]) out[k] = next[k]
  return out
}

export function toFormText(v: ThresholdValues): Record<ThresholdKey, string> {
  const out = {} as Record<ThresholdKey, string>
  for (const k of THRESHOLD_KEYS) out[k] = String(v[k]).replace('.', ',')
  return out
}

/** Duraciones sugeridas del riego manual, sin superar el máximo del invernadero. */
export function durationPresets(maxS: number): number[] {
  const p = [10, 20, 30].filter((n) => n <= maxS)
  return p.length > 0 ? p : [Math.max(5, Math.min(maxS, 10))]
}
