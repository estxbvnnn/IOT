import { generateKeyPairSync } from 'node:crypto'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { Gateway, type IngestFn } from '../../scripts/lib/gateway-core'
import { crearProcesador } from '../../scripts/lib/gateway-mqtt'
import { abrirRespuesta, cifrarRsa } from '../../scripts/lib/mqtt-crypto'
import type { IngestInput, IngestResult } from '@/lib/services/ingest'

const TOKEN = 'A'.repeat(43)
const CFG = { ver: 1, intervalo_s: 10 }
const okResult = (): IngestResult => ({ status: 200, body: { ok: true, t: '2026-11-06T00:00:00Z', cfg: CFG, ordenes: [] } }) as IngestResult

interface Harness { base: string; calls: IngestInput[]; close: () => Promise<void> }
let h: Harness | null = null
afterEach(async () => { await h?.close(); h = null })

async function start(opts: { rsa?: ReturnType<typeof generateKeyPairSync>['privateKey']; politica?: 'permitir' | 'exigir-rsa'; sinRelay?: boolean } = {}): Promise<Harness> {
  const calls: IngestInput[] = []
  const ingest: IngestFn = async (i) => { calls.push(i); return okResult() }
  const gw = new Gateway({ ingest })
  if (!opts.sinRelay) {
    const procesar = crearProcesador(gw, { rsaPrivada: opts.rsa ?? null, politica: opts.politica ?? 'permitir', log: () => undefined })
    gw.relay = async (id, body, route) => (await procesar(`invernadero/${id}/tx`, body, route))?.text ?? null
  }
  const server = gw.server()
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  return {
    base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, calls,
    close: () => new Promise<void>((r) => { server.close(() => r()); server.closeAllConnections() }),
  }
}

const relay = (id: string, body: string, headers: Record<string, string> = {}) =>
  fetch(`${h!.base}/relay/${id}`, { method: 'POST', headers: { 'Content-Type': 'text/plain', ...headers }, body })

describe('POST /relay/<id>: carga de la malla ESP-NOW', () => {
  it('un nodo sube su propia trama: transporte http, sin vía, y recibe «<HTTP> <Retry-After>\\n{json}»', async () => {
    h = await start()
    const res = await relay('nodo-aaaaaa', `${TOKEN}\n{"seq":1,"temp":23.5}`)
    expect(res.status).toBe(200)
    const txt = await res.text()
    expect(txt.startsWith('200 0\n')).toBe(true)
    expect(JSON.parse(txt.slice(6))).toMatchObject({ ok: true })
    expect(h.calls[0]!.route).toEqual({ transport: 'http', via: null, hops: null })
    expect(h.calls[0]!.authorization).toBe(`Bearer ${TOKEN}`)
  })

  it('un vecino sube la trama de otro: transporte espnow con la vía y los saltos', async () => {
    h = await start()
    await relay('nodo-aaaaaa', `${TOKEN}\n{"seq":2}`, { 'X-Via': 'nodo-bbbbbb', 'X-Saltos': '2' })
    expect(h.calls[0]!.route).toEqual({ transport: 'espnow', via: 'nodo-bbbbbb', hops: 2 })
  })

  it('ignora cabeceras de ruta mal formadas', async () => {
    h = await start()
    await relay('nodo-aaaaaa', `${TOKEN}\n{"seq":3}`, { 'X-Via': 'nodo;DROP', 'X-Saltos': '99' })
    expect(h.calls[0]!.route).toEqual({ transport: 'espnow', via: null, hops: null })
  })

  it('acepta un JSON con solo seq (el de otro grupo) y rechaza uno sin seq', async () => {
    h = await start()
    expect((await (await relay('nodo-x', `${TOKEN}\n{"seq":4}`)).text()).startsWith('200')).toBe(true)
    expect((await (await relay('nodo-x', `${TOKEN}\n{"temperature":20}`)).text()).startsWith('400')).toBe(true)
    expect(h.calls).toHaveLength(1)
  })

  it('RSA de extremo a extremo: la respuesta vuelve cifrada con la misma clave de un solo uso', async () => {
    const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
    h = await start({ rsa: privateKey, politica: 'exigir-rsa' })
    const tema = 'invernadero/nodo-aaaaaa/tx'
    const { payload, sesion } = cifrarRsa(`${TOKEN}\n{"seq":5,"temp":21}`, tema, publicKey)
    const res = await relay('nodo-aaaaaa', payload, { 'X-Via': 'nodo-bbbbbb', 'X-Saltos': '1' })
    const cuerpo = await res.text()
    expect(cuerpo.startsWith('rsa1:')).toBe(true)
    expect(cuerpo).not.toContain('"ok"')
    const abierta = abrirRespuesta(cuerpo, 'invernadero/nodo-aaaaaa/rx', null, sesion)
    expect(abierta.ok && abierta.texto.startsWith('200 0\n')).toBe(true)
    expect(h.calls[0]!.route).toMatchObject({ transport: 'espnow', via: 'nodo-bbbbbb', hops: 1 })
  })

  it('con política exigir-rsa una carga en claro no llega a la base', async () => {
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
    h = await start({ rsa: privateKey, politica: 'exigir-rsa' })
    const res = await relay('nodo-aaaaaa', `${TOKEN}\n{"seq":6}`)
    expect((await res.text()).startsWith('400')).toBe(true)
    expect(h.calls).toHaveLength(0)
  })

  it('sin procesador registrado responde 404; los temas raros no coinciden con la ruta', async () => {
    h = await start({ sinRelay: true })
    expect((await relay('nodo-aaaaaa', 'x')).status).toBe(404)
    const raro = await fetch(`${h.base}/relay/nodo;aaa`, { method: 'POST', body: 'x' })
    expect(raro.status).toBe(404)
  })
})
