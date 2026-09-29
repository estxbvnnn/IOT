/**
 * Generación de historial sintético: recorre el modelo físico + el controlador del nodo en
 * tiempo virtual y produce lecturas y eventos de riego. Lo usa el seed para que el panel no
 * arranque vacío. Todo el historial es DEMOSTRATIVO (ver README) y se puede borrar con
 * `npm run db:reset-data`.
 */
import { NodeController, type ControllerConfig, SAMPLE_WHILE_PUMPING_S } from './controller'
import { GreenhouseWorld, gaussian, mulberry32 } from './world'

export interface HistoryReading {
  ts: number
  tempC: number
  humAir: number
  soilRaw: number
  lightLux: number
  pumpOn: boolean
  rssi: number
}

export interface HistoryIrrigation {
  startedAt: number
  endedAt: number
  durationS: number
  trigger: 'auto' | 'manual'
  endReason: string
  soilRawStart: number
  soilRawEnd: number
}

export interface History {
  readings: HistoryReading[]
  irrigations: HistoryIrrigation[]
  finalSoil: number
}

export interface HistoryOptions {
  seed: number
  startMs: number
  endMs: number
  config: ControllerConfig
}

/**
 * Simula desde `startMs` hasta `endMs`. Mientras la bomba está encendida avanza de a 1 s y muestrea
 * cada 5 s (como el nodo real); en reposo salta hasta la próxima muestra (cada `intervalS`).
 * Igual que el nodo real, informa una lectura extra en cada encendido/apagado de la bomba.
 */
export function generateHistory(opts: HistoryOptions): History {
  const world = new GreenhouseWorld({ seed: opts.seed })
  const rng = mulberry32(opts.seed ^ 0x9e3779b9)
  const ctrl = new NodeController(opts.config)
  const readings: HistoryReading[] = []
  const irrigations: HistoryIrrigation[] = []
  const baseRssi = -58 - Math.floor(rng() * 14)

  let now = opts.startMs
  let lastStep = now
  let nextSample = now
  let lastSoil = world.soilRaw()
  let open: { startedAt: number; soilStart: number; trigger: 'auto' | 'manual' } | null = null

  const record = (soil: number, tempC: number, humAir: number): void => {
    readings.push({
      ts: now, tempC, humAir, soilRaw: soil, lightLux: world.lux(now),
      pumpOn: ctrl.pumpOn, rssi: Math.round(baseRssi + gaussian(rng) * 2),
    })
  }

  while (now <= opts.endMs) {
    // 1) La física avanza con el estado de la bomba que había DURANTE el intervalo.
    const dt = (now - lastStep) / 1000
    if (dt > 0) world.step(dt, dt, now, ctrl.pumpOn)
    lastStep = now

    // 2) Corte por tiempo: se evalúa en cada vuelta, haya o no lectura nueva.
    ctrl.tick(now)

    // 3) Muestreo.
    let sampled = false
    if (now >= nextSample) {
      const dht = world.dht(now)
      lastSoil = world.soilRaw()
      ctrl.tick(now, { soilRaw: lastSoil, tempC: dht.tempC })
      record(lastSoil, dht.tempC, dht.humAir)
      sampled = true
      nextSample = now + (ctrl.pumpOn ? SAMPLE_WHILE_PUMPING_S : ctrl.config.intervalS) * 1000
    }

    // 4) Eventos de la bomba → riegos.
    const events = ctrl.pendingEvents()
    if (events.length > 0) {
      for (const ev of events) {
        if (ev.t === 'pump_on') {
          open = { startedAt: ev.atMs, soilStart: lastSoil, trigger: ev.why === 'manual' ? 'manual' : 'auto' }
        } else if (open) {
          irrigations.push({
            startedAt: open.startedAt, endedAt: ev.atMs,
            durationS: ev.durS ?? Math.round((ev.atMs - open.startedAt) / 1000),
            trigger: open.trigger, endReason: ev.why, soilRawStart: open.soilStart, soilRawEnd: lastSoil,
          })
          open = null
        }
      }
      ctrl.ackEvents(events.length)
      if (!sampled) {
        const dht = world.dht(now)
        record(lastSoil, dht.tempC, dht.humAir) // trama inmediata por evento
      }
    }

    // 5) Avance del reloj virtual.
    now += ctrl.pumpOn ? 1000 : Math.max(1000, Math.min(nextSample - now, 60_000))
  }
  return { readings, irrigations, finalSoil: lastSoil }
}
