import { describe, expect, it } from 'vitest'
import {
  type AlertThresholds, type RecentReading, evaluateGreenhouse, evaluatePumpAnomaly, evaluateWind,
  offlineAfterS, sustainMs, sustained,
} from '@/lib/alerts/engine'

const T: AlertThresholds = {
  soilOn: 700, soilOff: 500, soilSat: 300, tempMax: 40, tempHeat: 35, tempCold: 5, tempFrost: 2, humAirMin: 30, humAirMax: 90, intervalS: 60,
}
const NOW = 1_800_000_000_000
const min = 60_000

function frame(over: Partial<Parameters<typeof evaluateGreenhouse>[0]> = {}) {
  return evaluateGreenhouse({
    code: 'I3', thresholds: T, now: NOW, tempC: 22, humAir: 60, soilRaw: 500, faults: [],
    recent: [{ ts: NOW, soilRaw: 500, humAir: 60 }], ...over,
  })
}
const types = (o: ReturnType<typeof frame>) => o.raise.map((r) => `${r.type}:${r.severity}`)

/** Historial de N minutos con el mismo valor, del más nuevo al más antiguo. */
function streak(minutes: number, v: Partial<RecentReading>): RecentReading[] {
  return Array.from({ length: minutes + 1 }, (_, i) => ({ ts: NOW - i * min, soilRaw: 500, humAir: 60, ...v }))
}

describe('temperatura (inmediata, con histéresis de 1 °C)', () => {
  it('≥ 40 °C es crítica y avisa que el riego queda bloqueado', () => {
    const o = frame({ tempC: 41 })
    expect(types(o)).toContain('temp_high:critical')
    expect(o.raise[0]!.message).toMatch(/bloqueado/)
  })
  it('35–40 °C es aviso', () => expect(types(frame({ tempC: 36 }))).toContain('temp_high:warning'))
  it('despeja bajo 34 °C y mantiene entre 34 y 35 (sin parpadeo)', () => {
    expect(frame({ tempC: 33 }).clear).toContain('temp_high')
    const hold = frame({ tempC: 34.5 })
    expect(hold.clear).not.toContain('temp_high')
    expect(types(hold)).not.toContain('temp_high:warning')
  })
  it('helada ≤ 2 °C es crítica; ≤ 5 °C aviso; despeja sobre 6 °C', () => {
    expect(types(frame({ tempC: 1 }))).toContain('temp_low:critical')
    expect(types(frame({ tempC: 4 }))).toContain('temp_low:warning')
    expect(frame({ tempC: 7 }).clear).toContain('temp_low')
    expect(frame({ tempC: 5.5 }).clear).not.toContain('temp_low')
  })
  it('sin lectura de temperatura no levanta ni despeja alertas de temperatura', () => {
    const o = frame({ tempC: null })
    expect(types(o).some((t) => t.startsWith('temp_'))).toBe(false)
    expect(o.clear.some((t) => t.startsWith('temp_'))).toBe(false)
  })
})

describe('suelo: la condición debe sostenerse (no molesta mientras el riego corrige)', () => {
  const hold = sustainMs(T.intervalS) // máx(2 min, 3 intervalos) = 3 min
  it('el tiempo exigido es ≥ 2 min y ≥ 3 intervalos', () => {
    expect(sustainMs(10)).toBe(120_000)
    expect(sustainMs(300)).toBe(900_000)
  })
  it('seco durante menos del tiempo exigido: no alerta y no despeja', () => {
    const o = frame({ soilRaw: 750, recent: streak(2, { soilRaw: 750 }) })
    expect(o.raise).toHaveLength(0)
    expect(o.clear).not.toContain('soil_dry')
  })
  it('seco de forma sostenida: aviso; muy prolongado: crítico', () => {
    expect(hold).toBe(180_000)
    expect(types(frame({ soilRaw: 750, recent: streak(3, { soilRaw: 750 }) }))).toContain('soil_dry:warning')
    const long = frame({ soilRaw: 750, recent: streak(12, { soilRaw: 750 }) })
    expect(types(long)).toContain('soil_dry:critical')
    expect(long.raise[0]!.message).toMatch(/bomba, válvula o sensor/)
  })
  it('vuelve a la banda óptima: despeja', () => {
    expect(frame({ soilRaw: 600 }).clear).toContain('soil_dry')
  })
  it('saturado sostenido: aviso «No regar»; fuera de la banda despeja', () => {
    const o = frame({ soilRaw: 250, recent: streak(4, { soilRaw: 250 }) })
    expect(types(o)).toContain('soil_saturated:warning')
    expect(o.raise[0]!.message).toMatch(/No regar/)
    expect(frame({ soilRaw: 400 }).clear).toContain('soil_saturated')
  })
  it('una lectura sin dato rompe la racha', () => {
    const r = streak(6, { soilRaw: 750 })
    r[2] = { ...r[2]!, soilRaw: null }
    expect(sustained(r, (x) => (x.soilRaw === null ? null : x.soilRaw >= 700), 180_000)).toBe(false)
  })
})

describe('humedad del aire', () => {
  it('alta sostenida = riesgo de hongos; baja sostenida = aire muy seco', () => {
    expect(types(frame({ humAir: 95, recent: streak(4, { humAir: 95 }) }))).toContain('hum_air_high:warning')
    expect(types(frame({ humAir: 20, recent: streak(4, { humAir: 20 }) }))).toContain('hum_air_low:warning')
  })
  it('despeja con margen de 2 puntos', () => {
    expect(frame({ humAir: 80 }).clear).toContain('hum_air_high')
    expect(frame({ humAir: 89 }).clear).not.toContain('hum_air_high')
    expect(frame({ humAir: 50 }).clear).toContain('hum_air_low')
  })
})

describe('fallas de sensor', () => {
  it('levanta alerta con las fallas de sensor y la despeja al desaparecer', () => {
    const o = frame({ faults: ['dht', 'suelo_rango'] })
    expect(types(o)).toContain('sensor_fault:warning')
    expect(o.raise.find((r) => r.type === 'sensor_fault')!.message).toMatch(/DHT22/)
    expect(frame({ faults: [] }).clear).toContain('sensor_fault')
  })
  it('una falla de conectividad (wifi) no cuenta como falla de sensor', () => {
    const o = frame({ faults: ['wifi'] })
    expect(types(o)).not.toContain('sensor_fault:warning')
    expect(o.clear).toContain('sensor_fault')
  })
})

describe('viento del predio (mástil)', () => {
  it('aviso desde 15 m/s, crítico desde 25 m/s, despeja bajo 14 m/s', () => {
    expect(evaluateWind({ windMs: 16, warn: 15, crit: 25 }).raise[0]).toMatchObject({ type: 'wind_high', severity: 'warning' })
    expect(evaluateWind({ windMs: 26, warn: 15, crit: 25 }).raise[0]).toMatchObject({ severity: 'critical' })
    expect(evaluateWind({ windMs: 13, warn: 15, crit: 25 }).clear).toContain('wind_high')
    expect(evaluateWind({ windMs: 14.5, warn: 15, crit: 25 })).toEqual({ raise: [], clear: [] })
    expect(evaluateWind({ windMs: null, warn: 15, crit: 25 })).toEqual({ raise: [], clear: [] })
  })
})

describe('anomalía de la bomba (activaciones repetidas: el suelo vuelve a secarse enseguida)', () => {
  const WAIT = 300 // 5 min de espera entre riegos → el límite es 3 esperas = 15 min

  it('3 riegos automáticos seguidos, cada uno a menos de 15 min del anterior = crítica', () => {
    const o = evaluatePumpAnomaly({ code: 'I3', gapsS: [330, 400], waitS: WAIT })
    expect(o.raise[0]).toMatchObject({ type: 'pump_anomaly', severity: 'critical' })
    expect(o.raise[0]!.message).toMatch(/15 min/)
  })

  it('la operación normal (riegos separados por horas) NO alerta, aunque todos corten por tiempo máximo', () => {
    expect(evaluatePumpAnomaly({ code: 'I3', gapsS: [6 * 3600, 5 * 3600], waitS: WAIT })).toEqual({ raise: [], clear: [] })
  })

  it('basta que uno de los dos intervalos sea largo para que no sea anómalo', () => {
    expect(evaluatePumpAnomaly({ code: 'I3', gapsS: [330, 4 * 3600], waitS: WAIT }).raise).toHaveLength(0)
    expect(evaluatePumpAnomaly({ code: 'I3', gapsS: [4 * 3600, 330], waitS: WAIT }).raise).toHaveLength(0)
  })

  it('con menos de 3 riegos de historial no hay conclusión', () => {
    expect(evaluatePumpAnomaly({ code: 'I3', gapsS: [330], waitS: WAIT }).raise).toHaveLength(0)
    expect(evaluatePumpAnomaly({ code: 'I3', gapsS: [], waitS: WAIT }).raise).toHaveLength(0)
  })

  it('el límite escala con la espera configurada', () => {
    expect(evaluatePumpAnomaly({ code: 'I3', gapsS: [1000, 1000], waitS: 600 }).raise).toHaveLength(1) // límite 30 min
    expect(evaluatePumpAnomaly({ code: 'I3', gapsS: [1000, 1000], waitS: 60 }).raise).toHaveLength(0) // límite 3 min
  })

  it('se despeja sola cuando el suelo vuelve a la humedad objetivo (≤ 500)', () => {
    expect(frame({ soilRaw: 480 }).clear).toContain('pump_anomaly')
    expect(frame({ soilRaw: 500 }).clear).toContain('pump_anomaly')
    expect(frame({ soilRaw: 560 }).clear).not.toContain('pump_anomaly')
    expect(frame({ soilRaw: 750, recent: streak(1, { soilRaw: 750 }) }).clear).not.toContain('pump_anomaly')
  })
})

describe('nodo fuera de línea', () => {
  it('umbral = máx(90 s, 3 intervalos)', () => {
    expect(offlineAfterS(10)).toBe(90)
    expect(offlineAfterS(300)).toBe(900)
  })
})
