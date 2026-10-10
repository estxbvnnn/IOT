import { describe, expect, it } from 'vitest'
import { frameSchema, sanitizeFrame } from '@/lib/ingest/schema'
import { buildCfg, parseBearer } from '@/lib/services/ingest'

const base = {
  v: 1, fw: '1.0.0', boot: 3735928559, seq: 1, up: 12, temp: 24.3, hum_aire: 61.2, suelo_raw: 512, bomba: 0,
} as const

describe('trama de telemetría (protocolo v1)', () => {
  it('acepta una trama mínima válida', () => {
    expect(frameSchema.safeParse(base).success).toBe(true)
  })

  it('acepta una trama completa con eventos y acuses', () => {
    const r = frameSchema.safeParse({
      ...base, luz: 18234, viento: null, riego_s: 0, est: 'idle', esp: 0, rssi: -61, snr: null, fallas: [],
      ev: [
        { t: 'pump_on', why: 'auto', ago: 95 },
        { t: 'pump_off', why: 'tiempo_max', ago: 65, dur: 30 },
      ],
      acks: [{ id: '0b6c1a52-7c1e-4f0e-9a0c-2f3e7a9d1c11', estado: 'ejecutada', detalle: 'regando 20 s' }],
    })
    expect(r.success).toBe(true)
  })

  it('acepta null en sensores caídos', () => {
    expect(frameSchema.safeParse({ ...base, temp: null, hum_aire: null, suelo_raw: null }).success).toBe(true)
  })

  it.each([
    ['versión distinta', { v: 2 }],
    ['seq cero', { seq: 0 }],
    ['seq negativo', { seq: -1 }],
    ['boot fuera de uint32', { boot: 2 ** 32 }],
    ['bomba no binaria', { bomba: 2 }],
    ['temperatura como texto', { temp: '24' }],
    ['NaN / Infinity no son JSON, pero un texto sí llega', { temp: 'NaN' }],
    ['motivo de bomba inventado', { ev: [{ t: 'pump_off', why: 'porque_si', ago: 0 }] }],
    ['acuse con id que no es uuid', { acks: [{ id: 'abc', estado: 'ejecutada' }] }],
    ['demasiados eventos', { ev: Array.from({ length: 9 }, () => ({ t: 'pump_on', why: 'auto', ago: 0 })) }],
    ['estado desconocido', { est: 'hackeado' }],
    ['falla con texto enorme', { fallas: ['x'.repeat(100)] }],
  ])('rechaza: %s', (_n, patch) => {
    expect(frameSchema.safeParse({ ...base, ...patch }).success).toBe(false)
  })

  it('ignora campos desconocidos (compatibilidad hacia adelante)', () => {
    const r = frameSchema.safeParse({ ...base, futuro: 'x' })
    expect(r.success).toBe(true)
  })
})

describe('saneamiento de rangos físicos («validación de rango», tabla 12)', () => {
  const parse = (over: object) => frameSchema.parse({ ...base, ...over })

  it('deja pasar valores válidos', () => {
    const s = sanitizeFrame(parse({ luz: 500, viento: 4.5 }))
    expect(s).toMatchObject({ tempC: 24.3, humAir: 61.2, soilRaw: 512, lightLux: 500, windMs: 4.5 })
    expect(s.faults).toEqual([])
  })

  it('descarta lecturas imposibles y deja constancia de la falla', () => {
    const s = sanitizeFrame(parse({ temp: 120, hum_aire: 140, suelo_raw: 2000, luz: -5, viento: 999 }))
    expect(s.tempC).toBeNull()
    expect(s.humAir).toBeNull()
    expect(s.soilRaw).toBeNull()
    expect(s.lightLux).toBeNull()
    expect(s.windMs).toBeNull()
    expect(s.faults).toEqual(['hum_rango', 'luz_rango', 'suelo_rango', 'temp_rango', 'viento_rango'])
  })

  it('respeta los extremos válidos y redondea el suelo a entero', () => {
    const s = sanitizeFrame(parse({ temp: -40, hum_aire: 100, suelo_raw: 1023.4 }))
    expect(s.tempC).toBe(-40)
    expect(s.humAir).toBe(100)
    expect(sanitizeFrame(parse({ suelo_raw: 300.6 })).soilRaw).toBe(301)
  })

  it('conserva las fallas que reporta el nodo y descarta códigos raros', () => {
    const s = sanitizeFrame(parse({ fallas: ['dht', 'suelo', 'DROP TABLE'] }))
    expect(s.faults).toEqual(['dht', 'suelo'])
  })
})

describe('autenticación por token y configuración', () => {
  it('parseBearer exige el esquema Bearer y un token base64url de largo razonable', () => {
    const tok = 'A'.repeat(43)
    expect(parseBearer(`Bearer ${tok}`)).toBe(tok)
    expect(parseBearer(`bearer ${tok}`)).toBeNull()
    expect(parseBearer(tok)).toBeNull()
    expect(parseBearer(null)).toBeNull()
    expect(parseBearer('Bearer corto')).toBeNull()
    expect(parseBearer(`Bearer ${tok}; DROP`)).toBeNull()
  })

  it('cfg de un invernadero trae los umbrales; la del mástil solo el intervalo', () => {
    const base = { kind: 'greenhouse' as const, soil_on: 700, soil_off: 500, soil_sat: 300, temp_max: 40, pump_max_s: 30, pump_wait_s: 300, auto_enabled: true, interval_s: 300, version: 4 }
    expect(buildCfg(base)).toEqual({ ver: 4, intervalo_s: 300, suelo_on: 700, suelo_off: 500, suelo_sat: 300, temp_max: 40, riego_max_s: 30, espera_s: 300, auto: 1 })
    const mast = buildCfg({ kind: 'mast', soil_on: null, soil_off: null, soil_sat: null, temp_max: null, pump_max_s: null, pump_wait_s: null, auto_enabled: null, interval_s: null, version: null })
    expect(mast).toEqual({ ver: 1, intervalo_s: 60 })
  })

  it('con el riego automático desactivado la cfg lleva auto: 0', () => {
    const cfg = buildCfg({ kind: 'greenhouse', soil_on: 700, soil_off: 500, soil_sat: 300, temp_max: 40, pump_max_s: 30, pump_wait_s: 300, auto_enabled: false, interval_s: 300, version: 5 })
    expect(cfg.auto).toBe(0)
  })
})
