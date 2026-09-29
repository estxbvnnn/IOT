import { describe, expect, it } from 'vitest'
import { DEFAULT_CONFIG, NodeController, type ControllerConfig, type Order, validateConfig } from '@/lib/sim/controller'

/** Reloj de pruebas: todo el controlador recibe el tiempo inyectado (sin timers reales). */
const S = 1000
const cfg = (over: Partial<ControllerConfig> = {}): ControllerConfig => ({ ...DEFAULT_CONFIG, ...over })
const dry = (temp = 25) => ({ soilRaw: 750, tempC: temp })
const orderRiego = (id: string, dur: number, vence = 240): Order => ({ id, tipo: 'riego', dur_s: dur, vence_s: vence })

describe('arranque y estado seguro', () => {
  it('arranca con la bomba apagada y sin espera pendiente', () => {
    const c = new NodeController()
    expect(c.pumpOn).toBe(false)
    expect(c.state(0)).toBe('idle')
    expect(c.cooldownRemainingS(0)).toBe(0)
    expect(c.pendingEvents()).toHaveLength(0)
  })
})

describe('riego automático con histéresis', () => {
  it('inicia cuando el suelo está SECO (≥ 700) y hay temperatura válida y segura', () => {
    const c = new NodeController(cfg())
    c.tick(0, dry())
    expect(c.pumpOn).toBe(true)
    expect(c.pendingEvents()[0]).toMatchObject({ t: 'pump_on', why: 'auto' })
  })

  it('no inicia con el suelo óptimo, ni justo bajo el umbral', () => {
    const c = new NodeController(cfg())
    c.tick(0, { soilRaw: 699, tempC: 25 })
    expect(c.pumpOn).toBe(false)
    c.tick(1, { soilRaw: 500, tempC: 25 })
    expect(c.pumpOn).toBe(false)
  })

  it('inicia exactamente en el umbral de 700', () => {
    const c = new NodeController(cfg())
    c.tick(0, { soilRaw: 700, tempC: 25 })
    expect(c.pumpOn).toBe(true)
  })

  it('sigue regando mientras no llegue al objetivo y se apaga al alcanzar ≤ 500', () => {
    const c = new NodeController(cfg())
    c.tick(0, dry())
    c.tick(5 * S, { soilRaw: 650, tempC: 25 }) // entre off y on: sigue (histéresis)
    expect(c.pumpOn).toBe(true)
    c.tick(10 * S, { soilRaw: 520, tempC: 25 })
    expect(c.pumpOn).toBe(true)
    c.tick(15 * S, { soilRaw: 500, tempC: 25 })
    expect(c.pumpOn).toBe(false)
    expect(c.pendingEvents().at(-1)).toMatchObject({ t: 'pump_off', why: 'objetivo', durS: 15 })
  })
})

describe('corte duro por tiempo máximo (30 s por ciclo)', () => {
  it('corta a los 30 s aunque no llegue lectura nueva', () => {
    const c = new NodeController(cfg())
    c.tick(0, dry())
    c.tick(29_900)
    expect(c.pumpOn).toBe(true)
    c.tick(30_000)
    expect(c.pumpOn).toBe(false)
    expect(c.pendingEvents().at(-1)).toMatchObject({ why: 'tiempo_max', durS: 30 })
  })

  it('con el bucle corriendo cada 100 ms la bomba jamás supera el máximo', () => {
    const c = new NodeController(cfg({ waitS: 60 }))
    let onMs = 0
    c.tick(0, dry())
    for (let t = 100; t <= 120_000; t += 100) {
      const was = c.pumpOn
      c.tick(t, t % 5000 === 0 ? dry() : undefined)
      if (was) onMs += 100
    }
    // Hubo al menos dos ciclos y ninguno duró más de 30,1 s.
    const offs = c.pendingEvents().filter((e) => e.t === 'pump_off')
    expect(offs.length).toBeGreaterThanOrEqual(1)
    for (const e of offs) expect(e.durS!).toBeLessThanOrEqual(30)
    expect(onMs).toBeLessThanOrEqual(offs.length * 30_100 + 30_100)
  })

  it('si el bucle se bloquea, corta en la primera vuelta posterior', () => {
    const c = new NodeController(cfg())
    c.tick(0, dry())
    c.tick(10 * 60_000) // el bucle estuvo detenido 10 minutos
    expect(c.pumpOn).toBe(false)
    expect(c.pendingEvents().at(-1)?.why).toBe('tiempo_max')
  })
})

describe('espera obligatoria entre riegos (300 s)', () => {
  it('no vuelve a partir antes de 5 min y sí a los 5 min', () => {
    const c = new NodeController(cfg())
    c.tick(0, dry())
    c.tick(30_000) // corte por tiempo
    expect(c.state(30_000)).toBe('espera')
    c.tick(30_000 + 299 * S, dry())
    expect(c.pumpOn).toBe(false)
    expect(c.cooldownRemainingS(30_000 + 299 * S)).toBe(1)
    c.tick(30_000 + 300 * S, dry())
    expect(c.pumpOn).toBe(true)
  })
})

describe('bloqueos de seguridad', () => {
  it('no inicia con temperatura sobre el máximo (solo > 40 °C bloquea)', () => {
    const c = new NodeController(cfg())
    c.tick(0, { soilRaw: 800, tempC: 40.1 })
    expect(c.pumpOn).toBe(false)
    expect(c.state(0)).toBe('bloq_temp')
    c.tick(1, { soilRaw: 800, tempC: 40 })
    expect(c.pumpOn).toBe(true)
  })

  it('no inicia sin lectura válida de temperatura (falla del sensor)', () => {
    const c = new NodeController(cfg())
    c.tick(0, { soilRaw: 800, tempC: null })
    expect(c.pumpOn).toBe(false)
    expect(c.state(0)).toBe('bloq_sensor')
  })

  it('no inicia con el sensor de suelo inválido', () => {
    const c = new NodeController(cfg())
    c.tick(0, { soilRaw: null, tempC: 25 })
    expect(c.pumpOn).toBe(false)
    expect(c.state(0)).toBe('bloq_sensor')
  })

  it('no inicia con el suelo saturado, y corta si se satura regando', () => {
    const c = new NodeController(cfg())
    c.tick(0, { soilRaw: 250, tempC: 25 })
    expect(c.pumpOn).toBe(false)
    expect(c.state(0)).toBe('saturado')

    const d = new NodeController(cfg())
    d.tick(0, dry())
    d.tick(5 * S, { soilRaw: 280, tempC: 25 })
    expect(d.pumpOn).toBe(false)
    expect(d.pendingEvents().at(-1)?.why).toBe('saturado')
  })

  it('corta por seguridad si el sensor de suelo falla regando', () => {
    const c = new NodeController(cfg())
    c.tick(0, dry())
    c.tick(5 * S, { soilRaw: null, tempC: 25 })
    expect(c.pumpOn).toBe(false)
    expect(c.pendingEvents().at(-1)?.why).toBe('seguridad')
  })
})

describe('órdenes manuales', () => {
  it('acepta un riego manual y lo corta al cumplirse la duración (motivo «orden»)', () => {
    const c = new NodeController(cfg())
    c.tick(0, { soilRaw: 600, tempC: 25 })
    const ack = c.handleOrder(orderRiego('a', 20), 1000)
    expect(ack).toMatchObject({ id: 'a', estado: 'ejecutada' })
    expect(c.pumpOn).toBe(true)
    expect(c.pendingEvents().at(-1)).toMatchObject({ t: 'pump_on', why: 'manual', cmd: 'a' })
    c.tick(1000 + 19_900)
    expect(c.pumpOn).toBe(true)
    c.tick(1000 + 20_000)
    expect(c.pumpOn).toBe(false)
    expect(c.pendingEvents().at(-1)).toMatchObject({ t: 'pump_off', why: 'orden', durS: 20, cmd: 'a' })
  })

  it('el riego manual NO se detiene al pasar el objetivo (decide el operador), pero sí al saturarse', () => {
    const c = new NodeController(cfg())
    c.tick(0, { soilRaw: 650, tempC: 25 })
    c.handleOrder(orderRiego('a', 30), 0)
    c.tick(5 * S, { soilRaw: 400, tempC: 25 }) // bajo soilOff (500) pero sobre soilSat (300)
    expect(c.pumpOn).toBe(true)
    c.tick(10 * S, { soilRaw: 290, tempC: 25 })
    expect(c.pumpOn).toBe(false)
  })

  it('recorta la duración al máximo configurado e informa el recorte', () => {
    const c = new NodeController(cfg({ pumpMaxS: 30 }))
    const ack = c.handleOrder(orderRiego('a', 90), 0)
    expect(ack.estado).toBe('ejecutada')
    expect(ack.detalle).toMatch(/acortada/)
    c.tick(30 * S)
    expect(c.pumpOn).toBe(false)
  })

  it('rechaza si ya está regando', () => {
    const c = new NodeController(cfg())
    c.handleOrder(orderRiego('a', 20), 0)
    expect(c.handleOrder(orderRiego('b', 20), 1000)).toMatchObject({ estado: 'rechazada', detalle: 'ya está regando' })
  })

  it('rechaza durante la espera entre riegos e indica los segundos que faltan', () => {
    const c = new NodeController(cfg())
    c.handleOrder(orderRiego('a', 10), 0)
    c.tick(10 * S)
    const ack = c.handleOrder(orderRiego('b', 10), 70 * S)
    expect(ack.estado).toBe('rechazada')
    expect(ack.detalle).toMatch(/faltan 240 s/)
  })

  it('rechaza con el suelo saturado', () => {
    const c = new NodeController(cfg())
    c.tick(0, { soilRaw: 200, tempC: 25 })
    expect(c.handleOrder(orderRiego('a', 10), 1000)).toMatchObject({ estado: 'rechazada', detalle: 'suelo saturado' })
  })

  it('rechaza órdenes vencidas o con duración inválida', () => {
    const c = new NodeController(cfg())
    expect(c.handleOrder(orderRiego('a', 10, 0), 0).estado).toBe('rechazada')
    expect(c.handleOrder({ id: 'b', tipo: 'riego', vence_s: 100 }, 0).estado).toBe('rechazada')
  })

  it('una orden repetida devuelve el mismo acuse y no vuelve a ejecutarse', () => {
    const c = new NodeController(cfg({ waitS: 60 }))
    const first = c.handleOrder(orderRiego('a', 10), 0)
    c.tick(10 * S)
    const events = c.pendingEvents().length
    const again = c.handleOrder(orderRiego('a', 10), 200 * S)
    expect(again).toEqual(first)
    expect(c.pumpOn).toBe(false)
    expect(c.pendingEvents()).toHaveLength(events)
  })

  it('«parar» apaga la bomba de inmediato; si ya estaba apagada, igual acusa ejecutada', () => {
    const c = new NodeController(cfg())
    c.handleOrder(orderRiego('a', 30), 0)
    expect(c.handleOrder({ id: 'p', tipo: 'parar', vence_s: 60 }, 5 * S)).toMatchObject({ estado: 'ejecutada', detalle: 'bomba detenida' })
    expect(c.pumpOn).toBe(false)
    expect(c.handleOrder({ id: 'q', tipo: 'parar', vence_s: 60 }, 6 * S)).toMatchObject({ estado: 'ejecutada' })
  })
})

describe('configuración recibida del servidor', () => {
  it('acepta una configuración válida', () => {
    const c = new NodeController()
    expect(c.setConfig(cfg({ ver: 2, soilOn: 650, soilOff: 480 }))).toBe(true)
    expect(c.config.soilOn).toBe(650)
  })

  it('ignora COMPLETA una configuración que viola las reglas o los límites duros', () => {
    const c = new NodeController(cfg({ ver: 1 }))
    expect(c.setConfig(cfg({ ver: 2, soilOff: 800 }))).toBe(false) // off ≥ on
    expect(c.setConfig(cfg({ ver: 2, soilSat: 600 }))).toBe(false) // sat ≥ off
    expect(c.setConfig(cfg({ ver: 2, pumpMaxS: 600 }))).toBe(false) // sobre el límite duro
    expect(c.setConfig(cfg({ ver: 2, waitS: 5 }))).toBe(false) // bajo el mínimo de espera
    expect(c.setConfig(cfg({ ver: 2, tempMax: 90 }))).toBe(false)
    expect(c.config.ver).toBe(1)
    expect(validateConfig(cfg({ intervalS: 1 }))).toBeNull()
  })
})

describe('cola de eventos', () => {
  it('conserva los eventos hasta que se confirman y guarda como máximo 8', () => {
    const c = new NodeController(cfg({ waitS: 60 }))
    let t = 0
    for (let i = 0; i < 6; i++) {
      c.handleOrder(orderRiego(`o${i}`, 5), t)
      t += 5 * S
      c.tick(t)
      t += 60 * S
    }
    expect(c.pendingEvents().length).toBe(8)
    c.ackEvents(3)
    expect(c.pendingEvents().length).toBe(5)
  })
})
