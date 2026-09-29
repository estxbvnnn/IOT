/**
 * Sensor de humedad de suelo YL-38 / YL-69 — interpretación de la lectura.
 *
 * Bandas de la tabla de la clase (escala 0…1023, ADC de 10 bits):
 *   0 – 300     Sumergido / muy húmedo   → la sonda está en agua o en tierra completamente saturada
 *   300 – 700   Suelo húmedo / óptimo    → humedad adecuada para la mayoría de las plantas
 *   700 – 1023  Suelo seco / aire        → tierra seca o el sensor está fuera del agua/suelo
 *
 * Es un sensor resistivo: entrega MÁS voltaje (lectura más alta) cuanto MÁS seco está el suelo.
 * Los límites se toman como 0–299 / 300–699 / 700–1023 para que cada lectura tenga una sola banda.
 */

export type SoilBand = 'saturado' | 'optimo' | 'seco'

export const ADC_MAX = 1023

/** Límites por defecto = los de la imagen. El agrónomo puede ajustarlos por invernadero. */
export const DEFAULT_SOIL_SAT = 300
export const DEFAULT_SOIL_ON = 700
export const DEFAULT_SOIL_OFF = 500

export interface SoilLimits {
  /** Lecturas por debajo de este valor = SATURADO. */
  sat: number
  /** Lecturas iguales o sobre este valor = SECO (se inicia el riego). */
  on: number
}

export const DEFAULT_SOIL_LIMITS: SoilLimits = { sat: DEFAULT_SOIL_SAT, on: DEFAULT_SOIL_ON }

export function soilBand(raw: number, limits: SoilLimits = DEFAULT_SOIL_LIMITS): SoilBand {
  if (raw < limits.sat) return 'saturado'
  if (raw >= limits.on) return 'seco'
  return 'optimo'
}

export interface SoilBandInfo {
  id: SoilBand
  label: string
  /** Descripción de la tabla de la clase. */
  meaning: string
  advice: string
}

export const SOIL_BAND_INFO: Record<SoilBand, SoilBandInfo> = {
  saturado: {
    id: 'saturado',
    label: 'Saturado',
    meaning: 'Sumergido / muy húmedo: la sonda está en agua o en tierra completamente saturada.',
    advice: 'No regar.',
  },
  optimo: {
    id: 'optimo',
    label: 'Óptimo',
    meaning: 'Suelo húmedo / óptimo: humedad adecuada para la mayoría de las plantas.',
    advice: 'Sin acción.',
  },
  seco: {
    id: 'seco',
    label: 'Seco',
    meaning: 'Suelo seco / aire: tierra seca o el sensor está fuera del agua/suelo.',
    advice: 'Regar.',
  },
}

/**
 * Porcentaje de humedad (0 % = seco, 100 % = saturado) por interpolación lineal entre las lecturas de
 * calibración del sensor: `calDry` = lectura al aire, `calWet` = lectura sumergido en agua.
 * Por defecto 1023 → 0 % y 0 → 100 %.
 */
export function soilPct(raw: number, calDry = ADC_MAX, calWet = 0): number {
  if (calDry <= calWet) return 0
  const pct = ((calDry - raw) / (calDry - calWet)) * 100
  return Math.round(Math.min(100, Math.max(0, pct)) * 10) / 10
}
