import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { Gateway, type IngestFn } from '../../scripts/lib/gateway-core'
import type { IngestInput, IngestResult } from '@/lib/services/ingest'

const TOKEN_A = 'A'.repeat(43)
const TOKEN_B = 'B'.repeat(43)
const UUID = '0b6c1a52-7c1e-4f0e-9a0c-2f3e7a9d1c11'
const CFG = { ver: 4, intervalo_s: 10, suelo_on: 700, suelo_off: 500, suelo_sat: 300, temp_max: 40, riego_max_s: 30, espera_s: 300, auto: 1 as const }

const frame = (seq: number, over: Record<string, unknown> = {}) =>
  ({ v: 1, fw: '1.0.0-esp8266', boot: 7, seq, up: seq * 10, temp: 24.3, hum_aire: 61, suelo_raw: 450, bomba: 0, est: 'idle', ...over })

type IngestOkBody = Extract<IngestResult, { status: 200 }>['body']
const ok = (over: Partial<IngestOkBody> = {}): IngestResult =>
  ({ status: 200, body: { ok: true, t: '2026-10-07T00:00:00Z', cfg: CFG, ordenes: [], ...over } }) as IngestResult

interface Harness { gw: Gateway; base: string; calls: IngestInput[]; clock: { t: number }; close: () => Promise<void> }

async function start(ingest: IngestFn | null): Promise<Harness> {
  const calls: IngestInput[] = []
  const clock = { t: 1_000_000_000_000 }
  const fn: IngestFn = ingest ? async (i) => { calls.push(i); return ingest(i) } : async (i) => { calls.push(i); return ok() }
  const gw = new Gateway({ ingest: fn, now: () => clock.t })
  const server = gw.server()
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  return { gw, base, calls, clock, close: () => new Promise<void>((r) => { server.close(() => r()); server.closeAllConnections() }) }
}

const post = (h: Harness, token: string | null, body: unknown, raw?: string) =>
  fetch(`${h.base}/api/ingest`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: raw ?? JSON.stringify(body),
  })

let h: Harness | null = null
afterEach(async () => { await h?.close(); h = null })

describe('pasarela: recepción de tramas de los nodos', () => {
  it('cada trama se procesa al momento y devuelve la configuración y las órdenes reales de la base', async () => {
    h = await start(async () => ok({ ordenes: [{ id: UUID, tipo: 'riego', dur_s: 10, vence_s: 600 }] }))
    const res = await post(h, TOKEN_A, frame(1))
    expect(res.status).toBe(200)
    expect(res.headers.get('content-length')).not.toBeNull()          // sin «chunked»: el ESP8266 lee mal ese formato
    expect(await res.json()).toMatchObject({ ok: true, cfg: { ver: 4, auto: 1 }, ordenes: [{ id: UUID, tipo: 'riego' }] })
    expect((await post(h, TOKEN_A, frame(2))).status).toBe(200)
    expect(h.calls).toHaveLength(2)                                     // las dos fueron a la base: no hay cola ni caché
  })

  it('pasa a la base el token, el cuerpo, la hora de llegada y la IP del nodo', async () => {
    h = await start(null)
    await post(h, TOKEN_A, frame(1))
    const c = h.calls[0]!
    expect(c.authorization).toBe(`Bearer ${TOKEN_A}`)
    expect(JSON.parse(c.rawBody).seq).toBe(1)
    expect(c.now!.getTime()).toBe(h.clock.t)
    expect(c.ip).toBe('127.0.0.1')
    expect(c.skipSweep).toBe(true)                                       // el barrido corre aparte, con su propio reloj
  })

  it('una orden o configuración nueva llega al nodo en su siguiente trama', async () => {
    let ver = 4
    let ordenes: unknown[] = []
    h = await start(async () => ok({ cfg: { ...CFG, ver, auto: ver > 4 ? 0 : 1 }, ordenes: ordenes as never }))
    expect((await (await post(h, TOKEN_A, frame(1))).json()).cfg.auto).toBe(1)
    ver = 5                                                              // el usuario desactiva el riego automático en el dashboard
    ordenes = [{ id: UUID, tipo: 'riego', dur_s: 20, vence_s: 600 }]
    const b = await (await post(h, TOKEN_A, frame(2))).json()
    expect(b.cfg).toMatchObject({ ver: 5, auto: 0 })
    expect(b.ordenes).toHaveLength(1)
  })

  it('cada nodo recibe su propia respuesta', async () => {
    h = await start(async (i) => ok({ cfg: { ...CFG, ver: i.authorization!.includes(TOKEN_A) ? 11 : 22 } }))
    expect((await (await post(h, TOKEN_A, frame(1))).json()).cfg.ver).toBe(11)
    expect((await (await post(h, TOKEN_B, frame(1))).json()).cfg.ver).toBe(22)
  })

  it('rechaza sin token (401), JSON roto (400), trama inválida (400) y cuerpos enormes (413) sin tocar la base', async () => {
    h = await start(null)
    expect((await post(h, null, frame(1))).status).toBe(401)
    expect((await post(h, TOKEN_A, null, '{no es json')).status).toBe(400)
    const mala = await post(h, TOKEN_A, { ...frame(1), bomba: 7 })
    expect(mala.status).toBe(400)
    expect((await mala.json()).detalle.length).toBeGreaterThan(0)
    expect((await post(h, TOKEN_A, null, 'x'.repeat(5000))).status).toBe(413)
    expect(h.calls).toHaveLength(0)
  })

  it('token inválido: el 401 de la base llega al nodo', async () => {
    h = await start(async () => ({ status: 401, body: { ok: false, error: 'unauthorized' } }))
    expect((await post(h, TOKEN_A, frame(1))).status).toBe(401)
  })

  it('límite de frecuencia: el 429 y su Retry-After llegan al nodo', async () => {
    h = await start(async () => ({ status: 429, body: { ok: false, error: 'rate_limited' }, retryAfterS: 3 }) as IngestResult)
    const res = await post(h, TOKEN_A, frame(1))
    expect(res.status).toBe(429)
    expect(res.headers.get('retry-after')).toBe('3')
  })

  it('si la base local no responde, 503 (el nodo reintenta y conserva sus eventos) y /api/health lo refleja', async () => {
    let caida = true
    h = await start(async () => { if (caida) throw new Error('ECONNREFUSED'); return ok() })
    expect((await post(h, TOKEN_A, frame(1))).status).toBe(503)
    const mal = await fetch(`${h.base}/api/health`)
    expect(mal.status).toBe(503)
    expect(await mal.json()).toMatchObject({ ok: false, baseLocal: false })
    caida = false
    expect((await post(h, TOKEN_A, frame(2))).status).toBe(200)
    expect((await fetch(`${h.base}/api/health`)).status).toBe(200)
  })

  it('/api/health informa las tramas aceptadas y la hora de la última', async () => {
    h = await start(null)
    expect(await (await fetch(`${h.base}/api/health`)).json()).toMatchObject({ ok: true, baseLocal: null, tramas: 0, ultimaTrama: null })
    await post(h, TOKEN_A, frame(1))
    await post(h, TOKEN_A, frame(2))
    expect(await (await fetch(`${h.base}/api/health`)).json()).toMatchObject({ ok: true, baseLocal: true, tramas: 2, ultimaTrama: new Date(h.clock.t).toISOString() })
    expect((await fetch(`${h.base}/otra-cosa`)).status).toBe(404)
  })
})
