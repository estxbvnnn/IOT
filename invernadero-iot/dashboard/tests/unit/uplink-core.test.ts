import { generateKeyPairSync } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { descifrarRsa } from '../../scripts/lib/mqtt-crypto'
import { UPLINK_AAD, armarCuerpo, toReading, uplinkOnce, type UplinkConfig } from '../../scripts/lib/uplink-core'
import type { Db } from '../../src/lib/db/types'

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })

const fila = {
  id: '41', ts: new Date('2026-11-10T12:00:00Z'), gh: 'I3', node: 'nodo-8d572e', temp_c: 24.1, hum_air: 60, soil_raw: 580, soil_pct: 44,
  flow_lmin: 1.8, pump_on: false, rssi: null, seq: '7', boot: '99', transport: 'espnow', via: 'nodo-fef2cc', hops: 2,
}

describe('envío a la nube · cuerpo del lote', () => {
  it('convierte una fila de la base al formato del lote (con el flujo de agua)', () => {
    const l = toReading(fila)
    expect(l).toMatchObject({ id: 41, invernadero: 'I3', nodo: 'nodo-8d572e', temp_c: 24.1, hum_aire: 60, flujo_lmin: 1.8, transporte: 'espnow', via: 'nodo-fef2cc', saltos: 2, seq: 7 })
  })

  it('con clave pública de AWS el lote viaja cifrado y solo la clave privada lo abre', () => {
    const { body, contentType } = armarCuerpo([toReading(fila)], { origen: 'pi-test', publicKey }, new Date('2026-11-10T12:00:05Z'))
    expect(contentType).toBe('text/plain')
    expect(body.startsWith('rsa1:')).toBe(true)
    expect(body).not.toContain('nodo-8d572e')           // nada legible en el cable
    const abierto = descifrarRsa(body, UPLINK_AAD, privateKey)
    expect(abierto).not.toBeNull()
    const lote = JSON.parse(abierto!.texto) as { origen: string; lecturas: { id: number }[] }
    expect(lote.origen).toBe('pi-test')
    expect(lote.lecturas[0]!.id).toBe(41)
  })

  it('con otra clave privada no se puede abrir', () => {
    const otra = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey
    const { body } = armarCuerpo([toReading(fila)], { origen: 'x', publicKey }, new Date())
    expect(descifrarRsa(body, UPLINK_AAD, otra)).toBeNull()
  })

  it('un lote alterado en el camino se rechaza', () => {
    const { body } = armarCuerpo([toReading(fila)], { origen: 'x', publicKey }, new Date())
    const roto = body.slice(0, -6) + (body.endsWith('AAAAAA') ? 'BBBBBB' : 'AAAAAA')
    expect(descifrarRsa(roto, UPLINK_AAD, privateKey)).toBeNull()
  })

  it('sin clave pública (solo pruebas) va en JSON', () => {
    const { body, contentType } = armarCuerpo([toReading(fila)], { origen: 'x', publicKey: null }, new Date())
    expect(contentType).toBe('application/json')
    expect(JSON.parse(body).lecturas).toHaveLength(1)
  })
})

/** Base de datos de mentira: responde a las 3 consultas del ciclo (cursor, lecturas, guardar cursor). */
function fakeDb(rows: unknown[], cursor = 0) {
  const guardados: { lastId: number; error: string | null }[] = []
  const db = ((strings: TemplateStringsArray, ...vals: unknown[]) => {
    const sql = strings.join('?')
    if (sql.includes('from iot.uplink_state')) return Promise.resolve(cursor ? [{ last_id: String(cursor) }] : [])
    if (sql.includes('from iot.readings')) return Promise.resolve(rows)
    if (sql.includes('insert into iot.uplink_state')) { guardados.push({ lastId: vals[1] as number, error: vals[3] as string | null }); return Promise.resolve([]) }
    return Promise.resolve([])
  }) as unknown as Db
  return { db, guardados }
}

describe('envío a la nube · ciclo', () => {
  const cfg: UplinkConfig = { url: 'https://aws.example/ingest', apiKey: 'k123', publicKey, batch: 200, origen: 'pi-test' }

  it('envía lo pendiente y avanza el cursor solo si la nube responde 2xx', async () => {
    const { db, guardados } = fakeDb([fila])
    let visto: { url: string; init: RequestInit } | null = null
    const f = (async (url: string, init: RequestInit) => { visto = { url, init }; return new Response('ok', { status: 200 }) }) as unknown as typeof fetch
    const r = await uplinkOnce(db, cfg, { fetch: f })
    expect(r).toMatchObject({ ok: true, sent: 1, lastId: 41 })
    expect(visto!.url).toBe(cfg.url)
    expect((visto!.init.headers as Record<string, string>)['x-api-key']).toBe('k123')
    expect(guardados).toEqual([{ lastId: 41, error: null }])
  })

  it('si la nube falla NO avanza el cursor (reintenta el mismo lote después)', async () => {
    const { db, guardados } = fakeDb([fila], 10)
    const f = (async () => new Response('x', { status: 503 })) as unknown as typeof fetch
    const r = await uplinkOnce(db, cfg, { fetch: f })
    expect(r.ok).toBe(false)
    expect(r.error).toContain('503')
    expect(guardados).toEqual([{ lastId: 10, error: 'la nube respondió HTTP 503' }])
  })

  it('sin internet tampoco lanza ni pierde datos', async () => {
    const { db, guardados } = fakeDb([fila], 5)
    const f = (async () => { throw new Error('fetch failed') }) as unknown as typeof fetch
    const r = await uplinkOnce(db, cfg, { fetch: f })
    expect(r.ok).toBe(false)
    expect(guardados[0]).toEqual({ lastId: 5, error: 'fetch failed' })
  })

  it('sin lecturas nuevas no llama a la nube', async () => {
    const { db } = fakeDb([])
    let llamadas = 0
    const f = (async () => { llamadas++; return new Response('ok') }) as unknown as typeof fetch
    const r = await uplinkOnce(db, cfg, { fetch: f })
    expect(r).toMatchObject({ ok: true, sent: 0 })
    expect(llamadas).toBe(0)
  })
})
