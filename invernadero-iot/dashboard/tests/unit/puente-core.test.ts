import { describe, expect, it, vi } from 'vitest'
import { parseLinea, procesarRx, type RxLinea } from '../../scripts/lib/puente-core'

const MSG = 'rsa1:' + 'QUJD'.repeat(40)

describe('puente serie · interpretación de líneas del ESP', () => {
  it('reconoce un @RX válido', () => {
    expect(parseLinea(`@RX 8d572e 12 0 2 nodo-fef2cc ${MSG}\r\n`)).toEqual({
      kind: 'rx', origen: '8d572e', seq: 12, intento: 0, saltos: 2, via: 'nodo-fef2cc', mensaje: MSG,
    })
  })

  it('reconoce @HOLA', () => {
    expect(parseLinea('@HOLA concentrador')).toEqual({ kind: 'hola', nombre: 'concentrador' })
  })

  it('lo que no empieza con @ es registro de depuración', () => {
    expect(parseLinea('<< datos de nodo-8d572e')).toEqual({ kind: 'log', texto: '<< datos de nodo-8d572e' })
  })

  it.each([
    ['origen no hexadecimal', `@RX zzzzzz 1 0 1 nodo-a ${MSG}`],
    ['seq cero', `@RX 8d572e 0 0 1 nodo-a ${MSG}`],
    ['saltos fuera de rango', `@RX 8d572e 1 0 99 nodo-a ${MSG}`],
    ['mensaje que no es rsa1', '@RX 8d572e 1 0 1 nodo-a hola'],
    ['mensaje con basura en medio (cable con ruido)', `@RX 8d572e 1 0 1 nodo-a rsa1:QUJD\u0000QUJD`],
    ['faltan campos', '@RX 8d572e 1 0'],
  ])('descarta una línea rota: %s', (_n, linea) => {
    expect(parseLinea(linea).kind).toBe('log')
  })
})

describe('puente serie · subida a la pasarela', () => {
  const rx: RxLinea = { kind: 'rx', origen: '8d572e', seq: 12, intento: 1, saltos: 2, via: 'nodo-fef2cc', mensaje: MSG }
  const resp = 'rsa1:' + 'WFla'.repeat(20)

  it('sube a /relay/nodo-<origen> con X-Via y X-Saltos y devuelve la línea @TX', async () => {
    const f = vi.fn(async () => new Response(resp, { status: 200 }))
    const r = await procesarRx(rx, 'http://pasarela:3100/', f as unknown as typeof fetch)
    expect(r.tx).toBe(`@TX 8d572e 12 1 ${resp}\n`)
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('http://pasarela:3100/relay/nodo-8d572e')
    expect(init.method).toBe('POST')
    expect(init.body).toBe(MSG)
    expect(init.headers).toMatchObject({ 'x-via': 'nodo-fef2cc', 'x-saltos': '2' })
  })

  it('si la pasarela rechaza, no hay respuesta para la malla', async () => {
    const f = vi.fn(async () => new Response('no', { status: 400 }))
    const r = await procesarRx(rx, 'http://p', f as unknown as typeof fetch)
    expect(r.tx).toBeNull()
    expect(r.estado).toContain('400')
  })

  it('si la pasarela no es alcanzable, no lanza: informa', async () => {
    const f = vi.fn(async () => { throw new Error('ECONNREFUSED') })
    const r = await procesarRx(rx, 'http://p', f as unknown as typeof fetch)
    expect(r.tx).toBeNull()
    expect(r.estado).toContain('inalcanzable')
  })

  it('una respuesta que no es cifrada no se manda a la malla', async () => {
    const f = vi.fn(async () => new Response('200 0\n{"ok":1}', { status: 200 }))
    const r = await procesarRx(rx, 'http://p', f as unknown as typeof fetch)
    expect(r.tx).toBeNull()
  })
})
