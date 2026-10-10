import fs from 'node:fs'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
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

interface Harness { gw: Gateway; base: string; calls: IngestInput[]; clock: { t: number }; dir: string; close: () => Promise<void> }

async function start(ingest: IngestFn | null, opts: { dir?: string; sweep?: () => Promise<void> } = {}): Promise<Harness> {
  const dir = opts.dir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'gw-'))
  const calls: IngestInput[] = []
  const clock = { t: 1_000_000_000_000 }
  const fn: IngestFn = ingest ? async (i) => { calls.push(i); return ingest(i) } : async (i) => { calls.push(i); return ok() }
  const gw = new Gateway({ ingest: fn, spoolDir: path.join(dir, 'cola'), cachePath: path.join(dir, 'respuestas.json'), now: () => clock.t, sweep: opts.sweep })
  const server = gw.server()
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  return { gw, base, calls, clock, dir, close: () => new Promise<void>((r) => { server.close(() => r()); server.closeAllConnections() }) }
}

const post = (h: Harness, token: string | null, body: unknown, raw?: string) =>
  fetch(`${h.base}/api/ingest`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: raw ?? JSON.stringify(body),
  })

let h: Harness | null = null
afterEach(async () => { await h?.close(); if (h) fs.rmSync(h.dir, { recursive: true, force: true }); h = null })

describe('pasarela: recepción de tramas de los nodos', () => {
  it('la primera trama de un nodo se procesa al momento y devuelve su configuración real', async () => {
    h = await start(async () => ok({ ordenes: [{ id: UUID, tipo: 'riego', dur_s: 10, vence_s: 600 }] }))
    const res = await post(h, TOKEN_A, frame(1))
    expect(res.status).toBe(200)
    expect(res.headers.get('content-length')).not.toBeNull()          // sin «chunked»: el ESP8266 lee mal ese formato
    const body = await res.json()
    expect(body).toMatchObject({ ok: true, cfg: { ver: 4, auto: 1 }, ordenes: [{ id: UUID, tipo: 'riego' }] })
    expect(h.calls).toHaveLength(1)
    expect(h.gw.spoolSize()).toBe(0)
  })

  it('las siguientes se encolan y se responden con lo último que dijo Supabase (sin tocar Supabase)', async () => {
    h = await start(async () => ok({ ordenes: [{ id: UUID, tipo: 'riego', dur_s: 10, vence_s: 600 }] }))
    await post(h, TOKEN_A, frame(1))
    h.clock.t += 15_000
    const res = await post(h, TOKEN_A, frame(2))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.cfg.ver).toBe(4)
    expect(body.ordenes[0].vence_s).toBe(585)                          // 600 − 15 s esperando en la pasarela
    expect(h.calls).toHaveLength(1)
    expect(h.gw.spoolSize()).toBe(1)
  })

  it('las órdenes vencidas mientras esperaban en la pasarela ya no se entregan', async () => {
    h = await start(async () => ok({ ordenes: [{ id: UUID, tipo: 'riego', dur_s: 10, vence_s: 20 }] }))
    await post(h, TOKEN_A, frame(1))
    h.clock.t += 30_000
    expect((await (await post(h, TOKEN_A, frame(2))).json()).ordenes).toEqual([])
  })

  it('rechaza sin token (401), JSON roto (400), trama inválida (400) y cuerpos enormes (413)', async () => {
    h = await start(null)
    expect((await post(h, null, frame(1))).status).toBe(401)
    expect((await post(h, TOKEN_A, null, '{no es json')).status).toBe(400)
    const mala = await post(h, TOKEN_A, { ...frame(1), bomba: 7 })
    expect(mala.status).toBe(400)
    expect((await mala.json()).detalle.length).toBeGreaterThan(0)
    expect((await post(h, TOKEN_A, null, 'x'.repeat(5000))).status).toBe(413)
    expect(h.calls).toHaveLength(0)
  })

  it('token inválido en la primera trama: el 401 de Supabase llega al nodo y no se guarda nada', async () => {
    h = await start(async () => ({ status: 401, body: { ok: false, error: 'unauthorized' } }))
    const res = await post(h, TOKEN_A, frame(1))
    expect(res.status).toBe(401)
    expect(h.gw.spoolSize()).toBe(0)
    expect((await post(h, TOKEN_A, frame(2))).status).toBe(401)        // sigue sin respuesta guardada: vuelve a preguntar
    expect(h.calls).toHaveLength(2)
  })

  it('si Supabase no responde en la primera trama, 503 (el nodo reintenta y conserva sus eventos)', async () => {
    h = await start(async () => { throw new Error('ECONNREFUSED') })
    expect((await post(h, TOKEN_A, frame(1))).status).toBe(503)
  })

  it('/api/health informa la cola y los nodos conocidos', async () => {
    h = await start(null)
    await post(h, TOKEN_A, frame(1))
    await post(h, TOKEN_A, frame(2))
    const b = await (await fetch(`${h.base}/api/health`)).json()
    expect(b).toMatchObject({ ok: true, cola: 1, nodos: 1, ultimoReenvio: null })
    expect((await fetch(`${h.base}/otra-cosa`)).status).toBe(404)
  })
})

describe('pasarela: reenvío a Supabase', () => {
  it('envía la cola EN ORDEN y con la hora real de cada trama; luego la vacía y hace el barrido', async () => {
    let barridos = 0
    h = await start(null, { sweep: async () => { barridos++ } })
    const t0 = h.clock.t
    await post(h, TOKEN_A, frame(1))                                   // primera: directa
    for (const s of [2, 3, 4]) { h.clock.t += 15_000; await post(h, TOKEN_A, frame(s)) }
    h.calls.length = 0
    const r = await h.gw.forward()
    expect(r).toMatchObject({ processed: 3, dropped: 0, left: 0, failed: false })
    expect(h.calls.map((c) => JSON.parse(c.rawBody).seq)).toEqual([2, 3, 4])
    expect(h.calls.map((c) => c.now!.getTime())).toEqual([t0 + 15_000, t0 + 30_000, t0 + 45_000])
    expect(h.calls.every((c) => c.skipSweep === true)).toBe(true)
    expect(h.calls[0]!.authorization).toBe(`Bearer ${TOKEN_A}`)
    expect(barridos).toBe(1)
    expect(h.gw.lastForwardOk).toBe(true)
  })

  it('sin conexión con Supabase la cola se conserva y se vacía cuando vuelve', async () => {
    let caido = false
    h = await start(async () => { if (caido) throw new Error('timeout'); return ok() })
    await post(h, TOKEN_A, frame(1))
    for (const s of [2, 3]) { h.clock.t += 15_000; await post(h, TOKEN_A, frame(s)) }
    caido = true
    expect(await h.gw.forward()).toMatchObject({ processed: 0, left: 2, failed: true })
    expect(h.gw.lastForwardOk).toBe(false)
    caido = false
    expect(await h.gw.forward()).toMatchObject({ processed: 2, left: 0, failed: false })
  })

  it('una trama rechazada (400/401/429) se descarta y no bloquea a las demás', async () => {
    let n = 0
    h = await start(async () => { n++; return n === 2 ? { status: 400, body: { ok: false, error: 'invalid', detalle: ['x'] } } : ok() })
    await post(h, TOKEN_A, frame(1))
    for (const s of [2, 3, 4]) { h.clock.t += 15_000; await post(h, TOKEN_A, frame(s)) }
    expect(await h.gw.forward()).toMatchObject({ processed: 2, dropped: 1, left: 0 })
  })

  it('una configuración nueva o una orden nueva de Supabase llegan al nodo en su siguiente trama', async () => {
    let ver = 4
    let ordenes: unknown[] = []
    h = await start(async () => ok({ cfg: { ...CFG, ver, auto: ver > 4 ? 0 : 1 }, ordenes: ordenes as never }))
    await post(h, TOKEN_A, frame(1))
    await post(h, TOKEN_A, frame(2))
    expect((await (await post(h, TOKEN_A, frame(3))).json()).cfg.auto).toBe(1)   // aún lo viejo
    ver = 5                                                                        // el usuario desactiva el riego automático en el dashboard
    ordenes = [{ id: UUID, tipo: 'riego', dur_s: 20, vence_s: 600 }]
    await h.gw.forward()                                                          // el reenvío de cada minuto trae lo nuevo
    const b = await (await post(h, TOKEN_A, frame(4))).json()
    expect(b.cfg).toMatchObject({ ver: 5, auto: 0 })
    expect(b.ordenes).toHaveLength(1)
  })

  it('cada nodo tiene su propia respuesta guardada', async () => {
    h = await start(async (i) => ok({ cfg: { ...CFG, ver: i.authorization!.includes(TOKEN_A) ? 11 : 22 } }))
    await post(h, TOKEN_A, frame(1))
    await post(h, TOKEN_B, frame(1))
    expect((await (await post(h, TOKEN_A, frame(2))).json()).cfg.ver).toBe(11)
    expect((await (await post(h, TOKEN_B, frame(2))).json()).cfg.ver).toBe(22)
  })

  it('al reiniciar la Pi la cola y las respuestas guardadas siguen ahí', async () => {
    h = await start(null)
    await post(h, TOKEN_A, frame(1))
    await post(h, TOKEN_A, frame(2))
    const dir = h.dir
    await h.close()
    const h2 = await start(null, { dir })
    h = h2
    expect(h2.gw.spoolSize()).toBe(1)                                  // la trama pendiente sobrevivió
    const body = await (await post(h2, TOKEN_A, frame(3))).json()      // y el nodo ya no necesita esperar a Supabase
    expect(body.cfg.ver).toBe(4)
    expect(h2.calls).toHaveLength(0)
    expect(await h2.gw.forward()).toMatchObject({ processed: 2, left: 0 })
  })

  it('archivos dañados en la cola no la bloquean', async () => {
    h = await start(null)
    await post(h, TOKEN_A, frame(1))
    fs.writeFileSync(path.join(h.dir, 'cola', '000000000000001-000000.json'), '{roto')
    await post(h, TOKEN_A, frame(2))
    expect(await h.gw.forward()).toMatchObject({ processed: 1, dropped: 1, left: 0 })
  })

  it('la cola tiene un tope: descarta lo más viejo', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-'))
    const gw = new Gateway({ ingest: async () => ok(), spoolDir: path.join(dir, 'cola'), cachePath: path.join(dir, 'r.json'), maxSpool: 3 })
    const server = gw.server()
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    h = { gw, base, calls: [], clock: { t: 0 }, dir, close: () => new Promise<void>((r) => { server.close(() => r()); server.closeAllConnections() }) }
    for (let s = 1; s <= 8; s++) await post(h, TOKEN_A, frame(s))
    expect(gw.spoolSize()).toBe(3)
  })
})
