import type { AlertType, Severity } from '../domain/types'

/**
 * Motor de alertas: función PURA que decide, a partir de la última lectura y del historial reciente,
 * qué alertas hay que levantar y cuáles se despejan. Sin base de datos → fácil de probar.
 *
 * Reglas (informe, sección 5.1: «si alguna variable está fuera de rango, se emite una alerta»):
 *  - Temperatura: calor, frío y helada actúan de inmediato (el daño es rápido).
 *  - Suelo, humedad del aire: se exige que la condición se SOSTENGA un tiempo, para no molestar
 *    mientras el riego automático ya está corrigiendo el problema.
 *  - Histéresis al despejar, para que una alerta no parpadee cuando el valor oscila en el límite.
 */

export interface AlertThresholds {
  soilOn: number
  soilOff: number
  soilSat: number
  tempMax: number
  tempHeat: number
  tempCold: number
  tempFrost: number
  humAirMin: number
  humAirMax: number
  intervalS: number
}

export interface RecentReading {
  /** epoch ms */
  ts: number
  soilRaw: number | null
  humAir: number | null
}

export interface GreenhouseEvalInput {
  code: string
  thresholds: AlertThresholds
  now: number
  tempC: number | null
  humAir: number | null
  soilRaw: number | null
  faults: readonly string[]
  /** Lecturas recientes, la más nueva primero. Debe incluir la lectura actual en el índice 0. */
  recent: readonly RecentReading[]
}

export interface AlertDraft {
  type: AlertType
  severity: Severity
  message: string
  detail: Record<string, unknown>
}

export interface EvalOutput {
  raise: AlertDraft[]
  clear: AlertType[]
}

/** Códigos de falla que se consideran problema de sensor (no de conectividad). */
const SENSOR_FAULTS = new Set(['dht', 'suelo', 'luz', 'viento', 'temp_rango', 'hum_rango', 'suelo_rango', 'luz_rango', 'viento_rango'])

const FAULT_LABEL: Record<string, string> = {
  dht: 'sensor DHT22 (temperatura/humedad del aire)',
  suelo: 'sensor de humedad de suelo YL-38',
  luz: 'sensor de luz BH1750',
  viento: 'anemómetro',
  temp_rango: 'temperatura fuera de rango físico',
  hum_rango: 'humedad del aire fuera de rango físico',
  suelo_rango: 'humedad de suelo fuera de rango físico',
  luz_rango: 'luz fuera de rango físico',
  viento_rango: 'viento fuera de rango físico',
}

/** Tiempo que una condición debe sostenerse antes de alertar: ≥ 2 min y ≥ 3 intervalos de reporte. */
export function sustainMs(intervalS: number): number {
  return Math.max(120_000, 3 * intervalS * 1000)
}

/**
 * ¿La condición se cumple de forma continua hasta ahora durante al menos `minMs`?
 * Recorre el historial desde la lectura más nueva hacia atrás; una lectura sin dato
 * (`null`) no cuenta como evidencia y corta la racha.
 */
export function sustained(
  recent: readonly RecentReading[],
  pred: (r: RecentReading) => boolean | null,
  minMs: number,
): boolean {
  const newest = recent[0]
  if (!newest || pred(newest) !== true) return false
  let oldestTs = newest.ts
  for (const r of recent) {
    if (pred(r) !== true) break
    oldestTs = r.ts
  }
  // Duración de la racha continua: desde su lectura más antigua hasta la más nueva.
  return newest.ts - oldestTs >= minMs
}

const fmt = (n: number, d = 1) => n.toFixed(d).replace('.', ',')

export function evaluateGreenhouse(input: GreenhouseEvalInput): EvalOutput {
  const { thresholds: T, tempC, humAir, soilRaw, code } = input
  const raise: AlertDraft[] = []
  const clear: AlertType[] = []
  const hold = sustainMs(T.intervalS)

  // --- Temperatura (crítica o de aviso, con histéresis de 1 °C) ---------------------------------
  if (tempC !== null) {
    if (tempC >= T.tempMax) {
      raise.push({
        type: 'temp_high', severity: 'critical',
        message: `${code}: temperatura crítica de ${fmt(tempC)} °C (≥ ${fmt(T.tempMax)} °C). El riego automático queda bloqueado por seguridad.`,
        detail: { tempC, limit: T.tempMax },
      })
    } else if (tempC >= T.tempHeat) {
      raise.push({
        type: 'temp_high', severity: 'warning',
        message: `${code}: calor de ${fmt(tempC)} °C (≥ ${fmt(T.tempHeat)} °C). Conviene ventilar.`,
        detail: { tempC, limit: T.tempHeat },
      })
    } else if (tempC < T.tempHeat - 1) clear.push('temp_high')

    if (tempC <= T.tempFrost) {
      raise.push({
        type: 'temp_low', severity: 'critical',
        message: `${code}: riesgo de helada, ${fmt(tempC)} °C (≤ ${fmt(T.tempFrost)} °C).`,
        detail: { tempC, limit: T.tempFrost },
      })
    } else if (tempC <= T.tempCold) {
      raise.push({
        type: 'temp_low', severity: 'warning',
        message: `${code}: temperatura baja de ${fmt(tempC)} °C (≤ ${fmt(T.tempCold)} °C).`,
        detail: { tempC, limit: T.tempCold },
      })
    } else if (tempC > T.tempCold + 1) clear.push('temp_low')
  }

  // --- Humedad de suelo (bandas de la tabla de la clase) -----------------------------------------
  if (soilRaw !== null) {
    const dry = (r: RecentReading) => (r.soilRaw === null ? null : r.soilRaw >= T.soilOn)
    const saturated = (r: RecentReading) => (r.soilRaw === null ? null : r.soilRaw < T.soilSat)

    if (soilRaw >= T.soilOn) {
      if (sustained(input.recent, dry, hold)) {
        const long = sustained(input.recent, dry, hold * 4)
        raise.push({
          type: 'soil_dry', severity: long ? 'critical' : 'warning',
          message: long
            ? `${code}: suelo seco de forma prolongada (lectura ${soilRaw}). El riego no está corrigiendo la sequedad: revisar bomba, válvula o sensor.`
            : `${code}: suelo seco (lectura ${soilRaw} ≥ ${T.soilOn}) sostenido.`,
          detail: { soilRaw, limit: T.soilOn },
        })
      }
    } else clear.push('soil_dry')

    // Si el suelo volvió a la humedad objetivo, el riego funciona: se despeja la anomalía de bomba.
    if (soilRaw <= T.soilOff) clear.push('pump_anomaly')

    if (soilRaw < T.soilSat) {
      if (sustained(input.recent, saturated, hold)) {
        raise.push({
          type: 'soil_saturated', severity: 'warning',
          message: `${code}: suelo saturado (lectura ${soilRaw} < ${T.soilSat}). No regar.`,
          detail: { soilRaw, limit: T.soilSat },
        })
      }
    } else clear.push('soil_saturated')
  }

  // --- Humedad del aire -------------------------------------------------------------------------
  if (humAir !== null) {
    const high = (r: RecentReading) => (r.humAir === null ? null : r.humAir >= T.humAirMax)
    const low = (r: RecentReading) => (r.humAir === null ? null : r.humAir <= T.humAirMin)
    if (humAir >= T.humAirMax) {
      if (sustained(input.recent, high, hold)) {
        raise.push({
          type: 'hum_air_high', severity: 'warning',
          message: `${code}: humedad del aire alta, ${fmt(humAir)} % (≥ ${fmt(T.humAirMax, 0)} %). Riesgo de hongos.`,
          detail: { humAir, limit: T.humAirMax },
        })
      }
    } else if (humAir < T.humAirMax - 2) clear.push('hum_air_high')

    if (humAir <= T.humAirMin) {
      if (sustained(input.recent, low, hold)) {
        raise.push({
          type: 'hum_air_low', severity: 'warning',
          message: `${code}: aire muy seco, ${fmt(humAir)} % (≤ ${fmt(T.humAirMin, 0)} %).`,
          detail: { humAir, limit: T.humAirMin },
        })
      }
    } else if (humAir > T.humAirMin + 2) clear.push('hum_air_low')
  }

  // --- Fallas de sensor reportadas por el nodo ----------------------------------------------------
  const sensorFaults = input.faults.filter((f) => SENSOR_FAULTS.has(f))
  if (sensorFaults.length > 0) {
    raise.push({
      type: 'sensor_fault', severity: 'warning',
      message: `${code}: falla de ${sensorFaults.map((f) => FAULT_LABEL[f] ?? f).join(', ')}.`,
      detail: { faults: sensorFaults },
    })
  } else clear.push('sensor_fault')

  return { raise, clear }
}

export interface WindEvalInput {
  windMs: number | null
  warn: number
  crit: number
}

/** Viento del predio (una sola variable para toda la hectárea, medida en el mástil). */
export function evaluateWind({ windMs, warn, crit }: WindEvalInput): EvalOutput {
  const raise: AlertDraft[] = []
  const clear: AlertType[] = []
  if (windMs === null) return { raise, clear }
  if (windMs >= crit) {
    raise.push({
      type: 'wind_high', severity: 'critical',
      message: `Viento fuerte de ${fmt(windMs)} m/s (≥ ${fmt(crit)} m/s). Cerrar ventilaciones y proteger la estructura.`,
      detail: { windMs, limit: crit },
    })
  } else if (windMs >= warn) {
    raise.push({
      type: 'wind_high', severity: 'warning',
      message: `Viento de ${fmt(windMs)} m/s (≥ ${fmt(warn)} m/s). Preparar el cierre de ventilaciones.`,
      detail: { windMs, limit: warn },
    })
  } else if (windMs < warn - 1) clear.push('wind_high')
  return { raise, clear }
}

export interface PumpAnomalyInput {
  code: string
  /**
   * Segundos entre el FIN de un riego automático y el INICIO del siguiente, del más reciente al más
   * antiguo. El primero es el que acaba de ocurrir.
   */
  gapsS: readonly number[]
  /** Espera obligatoria entre riegos configurada para el invernadero. */
  waitS: number
  /** Cantidad de riegos automáticos seguidos que se consideran anómalos. */
  consecutive?: number
}

/**
 * Informe, tabla 10: «alerta al operador ante activaciones anómalas repetidas».
 *
 * Con el corte de 30 s y una sonda con retardo, casi todos los riegos terminan por tiempo máximo:
 * eso es NORMAL y no sirve como señal. La señal es que el suelo vuelve a estar seco enseguida: tres
 * riegos automáticos seguidos, cada uno iniciado menos de 3 esperas (15 min por defecto) después del
 * anterior, indican bomba sin caudal, válvula cerrada, fuga o un sensor manipulado/desconectado.
 * La alerta se despeja sola cuando el suelo vuelve a la humedad objetivo (ver evaluateGreenhouse).
 */
export function evaluatePumpAnomaly({ code, gapsS, waitS, consecutive = 3 }: PumpAnomalyInput): EvalOutput {
  const need = consecutive - 1
  const limitS = 3 * waitS
  const recent = gapsS.slice(0, need)
  if (recent.length >= need && recent.every((g) => g <= limitS)) {
    return {
      raise: [{
        type: 'pump_anomaly', severity: 'critical',
        message: `${code}: ${consecutive} riegos automáticos seguidos con menos de ${Math.round(limitS / 60)} min entre sí. El suelo vuelve a secarse enseguida: posible falla de bomba o válvula, fuga o sensor manipulado.`,
        detail: { consecutive, gapsS: recent.map(Math.round), limitS },
      }],
      clear: [],
    }
  }
  return { raise: [], clear: [] }
}

export function severityRank(s: Severity): number {
  return s === 'critical' ? 3 : s === 'warning' ? 2 : 1
}

/** Segundos sin tramas a partir de los cuales un nodo se considera fuera de línea. */
export function offlineAfterS(intervalS: number): number {
  return Math.max(90, 3 * intervalS)
}
