import { describe, expect, it } from 'vitest'
import { frameSchema, sanitizeFrame } from '@/lib/ingest/schema'
import { parseFrame } from '@/lib/ingest/normalize'
import { buildCfg, parseBearer } from '@/lib/services/ingest'

const base = {
  v: 1, fw: '1.0.0', boot: 3735928559, seq: 1, up: 12, temp: 24.3, hum_aire: 61.2, suelo_raw: 512, bomba: 0,
} as const

describe('trama de telemetría (protocolo v1)', () => {
  const ok = (x: unknown) => parseFrame(x).ok

  it('acepta una trama mínima válida', () => {
    expect(ok(base)).toBe(true)
  })

  it('acepta una trama completa con eventos y acuses', () => {
    const r = parseFrame({
      ...base, luz: 18234, viento: null, riego_s: 0, est: 'idle', esp: 0, rssi: -61, snr: null, fallas: [],
      ev: [
        { t: 'pump_on', why: 'auto', ago: 95 },
        { t: 'pump_off', why: 'tiempo_max', ago: 65, dur: 30 },
      ],
      acks: [{ id: '0b6c1a52-7c1e-4f0e-9a0c-2f3e7a9d1c11', estado: 'ejecutada', detalle: 'regando 20 s' }],
    })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.frame.ev).toHaveLength(2)
  })

  it('acepta null en sensores caídos', () => {
    expect(ok({ ...base, temp: null, hum_aire: null, suelo_raw: null })).toBe(true)
  })

  it.each([
    ['versión distinta', { v: 2 }],
    ['seq cero', { seq: 0 }],
    ['seq negativo', { seq: -1 }],
    ['boot fuera de uint32', { boot: 2 ** 32 }],
    ['bomba no binaria', { bomba: 2 }],
    ['temperatura como texto', { temp: '24' }],
    ['NaN / Infinity no son JSON, pero un texto sí llega', { temp: 'NaN' }],
  ])('rechaza: %s', (_n, patch) => {
    expect(ok({ ...base, ...patch })).toBe(false)
  })

  it('sin seq no hay forma de descartar duplicados: se rechaza', () => {
    const { seq: _seq, ...sinSeq } = base
    expect(ok(sinSeq)).toBe(false)
    expect(ok('hola')).toBe(false)
    expect(ok([1, 2])).toBe(false)
  })
})

describe('JSON de otros nodos: campos que faltan, sobran o se llaman distinto', () => {
  it('solo exige seq: lo que falta toma un valor por defecto', () => {
    const r = parseFrame({ seq: 7 })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.frame).toMatchObject({ seq: 7, fw: 'desconocido', boot: 0, up: 0, temp: null, hum_aire: null, suelo_raw: null })
    expect(r.frame.bomba).toBeUndefined()
    expect(r.extra).toBeNull()
  })

  it('entiende nombres alternativos y bomba booleana', () => {
    const r = parseFrame({ sequence: 3, temperature: 22.5, humidity: 61, soil: 480, lux: 900, wind: 2, pump_on: true, uptime: 15, firmware: '1.2' })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.frame).toMatchObject({ seq: 3, temp: 22.5, hum_aire: 61, suelo_raw: 480, luz: 900, viento: 2, bomba: 1, up: 15, fw: '1.2' })
    expect(r.extra).toBeNull()
  })

  it('el nombre canónico gana sobre el alternativo', () => {
    const r = parseFrame({ seq: 1, temp: 20, temperature: 99 })
    expect(r.ok && r.frame.temp).toBe(20)
  })

  it('guarda en extra lo que no conoce (sin romper la trama)', () => {
    const r = parseFrame({ ...base, ph: 6.5, tanque: { nivel: 80 } })
    expect(r.ok && r.extra).toEqual({ ph: 6.5, tanque: { nivel: 80 } })
  })

  it('acota el tamaño de extra', () => {
    const gran: Record<string, string> = {}
    for (let i = 0; i < 50; i++) gran[`k${i}`] = 'x'.repeat(200)
    const r = parseFrame({ ...base, ...gran })
    expect(r.ok).toBe(true)
    if (r.ok) expect(JSON.stringify(r.extra).length).toBeLessThanOrEqual(2000)
  })

  it('descarta, sin rechazar la trama, lo opcional mal formado', () => {
    const r = parseFrame({
      ...base, est: 'hackeado', rssi: 40, fallas: ['ok', 'x'.repeat(100), 7],
      ev: [{ t: 'pump_off', why: 'porque_si', ago: 0 }, { t: 'pump_on', why: 'auto', ago: 1 }],
      acks: [{ id: 'abc', estado: 'ejecutada' }],
    })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.frame.est).toBeUndefined()
    expect(r.frame.rssi).toBeUndefined()
    expect(r.frame.fallas).toEqual(['ok'])
    expect(r.frame.ev).toEqual([{ t: 'pump_on', why: 'auto', ago: 1 }])
    expect(r.frame.acks).toEqual([])
  })

  it('recorta fw largo y limita las listas a 8', () => {
    const r = parseFrame({ ...base, fw: 'a-muy-largo-nombre-de-firmware', ev: Array.from({ length: 9 }, () => ({ t: 'pump_on', why: 'auto', ago: 0 })) })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.frame.fw).toHaveLength(16)
    expect(r.frame.ev).toHaveLength(8)
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
