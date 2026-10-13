import { describe, expect, it } from 'vitest'
import { Gateway } from '../../scripts/lib/gateway-core'
import { formatRx, parseTx } from '../../scripts/lib/gateway-mqtt'
import type { IngestResult } from '@/lib/services/ingest'

const TOKEN = 'A'.repeat(43)
const CFG = { ver: 4, intervalo_s: 10, suelo_on: 700, suelo_off: 500, suelo_sat: 300, temp_max: 40, riego_max_s: 30, espera_s: 300, auto: 1 as const }
const FRAME = JSON.stringify({ v: 1, fw: '1.0.0-esp8266', boot: 7, seq: 1, up: 10, temp: 24.3, hum_aire: 61, suelo_raw: 450, bomba: 0, est: 'idle' })
const ok = (): IngestResult => ({ status: 200, body: { ok: true, t: '2026-10-13T00:00:00Z', cfg: CFG, ordenes: [] } }) as IngestResult

describe('MQTT: formato de los mensajes', () => {
  it('separa el token de la trama y calcula el tema de respuesta', () => {
    const r = parseTx('invernadero/nodo-a1b2c3/tx', `${TOKEN}\n${FRAME}`)
    expect(r).toEqual({ replyTopic: 'invernadero/nodo-a1b2c3/rx', authorization: `Bearer ${TOKEN}`, raw: FRAME })
  })

  it('acepta el payload como Buffer', () => {
    expect(parseTx('invernadero/x/tx', Buffer.from(`${TOKEN}\n${FRAME}`))?.raw).toBe(FRAME)
  })

  it('ignora temas ajenos al protocolo o con caracteres raros', () => {
    expect(parseTx('invernadero/x/rx', `${TOKEN}\n${FRAME}`)).toBeNull()
    expect(parseTx('invernadero/../tx', `${TOKEN}\n${FRAME}`)).toBeNull()
    expect(parseTx('otro/x/tx', `${TOKEN}\n${FRAME}`)).toBeNull()
    expect(parseTx(`invernadero/${'a'.repeat(41)}/tx`, `${TOKEN}\n${FRAME}`)).toBeNull()
  })

  it('ignora mensajes sin salto de línea o sin token', () => {
    expect(parseTx('invernadero/x/tx', FRAME)).toBeNull()
    expect(parseTx('invernadero/x/tx', `\n${FRAME}`)).toBeNull()
    expect(parseTx('invernadero/x/tx', `   \n${FRAME}`)).toBeNull()
  })

  it('una trama enorme llega como null (413)', () => {
    expect(parseTx('invernadero/x/tx', `${TOKEN}\n${'x'.repeat(5000)}`)?.raw).toBeNull()
  })

  it('la respuesta lleva «HTTP Retry-After» y el JSON', () => {
    expect(formatRx({ status: 200, body: { ok: true } })).toBe('200 0\n{"ok":true}')
    expect(formatRx({ status: 429, body: { ok: false }, retryAfterS: 30 })).toBe('429 30\n{"ok":false}')
  })
})

describe('MQTT: la trama pasa por el mismo núcleo que HTTP', () => {
  it('se procesa al instante contra la base y vuelve la configuración real', async () => {
    let calls = 0
    const gw = new Gateway({ ingest: async () => { calls++; return ok() } })
    const tx = parseTx('invernadero/n1/tx', `${TOKEN}
${FRAME}`)!
    const first = await gw.ingestFrame(tx.authorization, tx.raw, null)
    expect(first.status).toBe(200)
    expect(first.body).toMatchObject({ ok: true, cfg: { ver: 4 } })
    expect((await gw.ingestFrame(tx.authorization, tx.raw, null)).status).toBe(200)
    expect(calls).toBe(2)
    expect(formatRx(first)).toBe(`200 0\n${JSON.stringify(first.body)}`)
  })

  it('token inválido: el 401 llega al nodo', async () => {
    const gw = new Gateway({ ingest: async () => ({ status: 401, body: { ok: false, error: 'unauthorized' } }) as IngestResult })
    const tx = parseTx('invernadero/n1/tx', `${TOKEN}
${FRAME}`)!
    expect((await gw.ingestFrame(tx.authorization, tx.raw, null)).status).toBe(401)
  })

  it('trama inválida (400), demasiado grande (413), sin token (401) y base caída (503)', async () => {
    const gw = new Gateway({ ingest: async () => { throw new Error('sin base') } })
    expect((await gw.ingestFrame(`Bearer ${TOKEN}`, '{"v":1}', null)).status).toBe(400)
    expect((await gw.ingestFrame(`Bearer ${TOKEN}`, 'no json', null)).status).toBe(400)
    expect((await gw.ingestFrame(`Bearer ${TOKEN}`, null, null)).status).toBe(413)
    expect((await gw.ingestFrame(`Bearer ${TOKEN}`, FRAME, null)).status).toBe(503)
    expect((await gw.ingestFrame(null, FRAME, null)).status).toBe(401)
  })
})
