import { describe, expect, it } from 'vitest'
import {
  PREFIJO_AES, PREFIJO_B64, claveDesdeHex, cifrarAes, codificar, decodificar, descifrarAes, detectarModo,
} from '../../scripts/lib/mqtt-crypto'
import { formatRx, parseTx } from '../../scripts/lib/gateway-mqtt'

const CLAVE_HEX = '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f'
const CLAVE = claveDesdeHex(CLAVE_HEX)
const TEMA = 'invernadero/nodo-aa6490/tx'
const TEXTO = 'TOKEN-DE-PRUEBA\n{"v":1,"seq":7,"temp":69.0,"hum_aire":40.5}'
// Generado con una implementación INDEPENDIENTE (python-cryptography / OpenSSL), nonce a1a2…ac y AAD = TEMA.
// El mismo vector sirve para comprobar el firmware de la NodeMCU (BearSSL) contra el de la pasarela (node:crypto).
const VECTOR_AES = 'aes1:oaKjpKWmp6ipqquscqDMKrp4eiqjLuAlEYCNeRm1XA1NdHilkfpGcl4vS/Rn4cuLwUt+1vxD29W3Ejmu1VnwykpR3tgZqzh4xUj1jX5HdQMUlH48T9LD'
const NONCE_VECTOR = Buffer.from('a1a2a3a4a5a6a7a8a9aaabac', 'hex')
// El mismo texto, nonce y tema con una clave de 128 bits (AES-128-GCM), también generado con la implementación independiente.
const CLAVE_128_HEX = '000102030405060708090a0b0c0d0e0f'
const CLAVE_128 = claveDesdeHex(CLAVE_128_HEX)
const VECTOR_AES128 = 'aes1:oaKjpKWmp6ipqqusEuzGoYU24/86D6N7XuXCqJfoPTSvdki/LHmkdeqAwo6EDT9jjhq5g5m3bwD0+LdG6rPgOA5xEPC1v/TyLbu8oZRtXHmKDx879rjD'

describe('clave AES', () => {
  it('acepta 32 caracteres hex (AES-128) o 64 (AES-256) y rechaza el resto', () => {
    expect(CLAVE.length).toBe(32)
    expect(claveDesdeHex(CLAVE_128_HEX).length).toBe(16)
    expect(() => claveDesdeHex('abc')).toThrow(/32 caracteres/)
    expect(() => claveDesdeHex('a'.repeat(48))).toThrow()
    expect(() => claveDesdeHex('z'.repeat(64))).toThrow()
    expect(() => claveDesdeHex(CLAVE_HEX.slice(2))).toThrow()
  })
})

describe('AES-256-GCM', () => {
  it('coincide con el vector de una implementación independiente (cifrar y descifrar)', () => {
    expect(cifrarAes(TEXTO, TEMA, CLAVE, NONCE_VECTOR)).toBe(VECTOR_AES)
    expect(descifrarAes(VECTOR_AES, TEMA, CLAVE)).toBe(TEXTO)
  })

  it('ida y vuelta con nonce aleatorio, y dos cifrados del mismo texto nunca son iguales', () => {
    const a = cifrarAes(TEXTO, TEMA, CLAVE)
    const b = cifrarAes(TEXTO, TEMA, CLAVE)
    expect(a).not.toBe(b)
    expect(descifrarAes(a, TEMA, CLAVE)).toBe(TEXTO)
    expect(descifrarAes(b, TEMA, CLAVE)).toBe(TEXTO)
  })

  it('lo cifrado no contiene nada legible del texto original', () => {
    const c = cifrarAes(TEXTO, TEMA, CLAVE)
    expect(c.startsWith(PREFIJO_AES)).toBe(true)
    // (no se busca «69» ni otros números sueltos: en Base64 aparecen por azar y haría el test intermitente)
    for (const s of ['TOKEN', 'temp', 'hum_aire']) expect(c).not.toContain(s)
    expect(Buffer.from(c.slice(PREFIJO_AES.length), 'base64').toString('latin1')).not.toContain('temp')
  })

  it('un mensaje alterado (un solo bit, en cualquier parte) se rechaza', () => {
    const raw = Buffer.from(VECTOR_AES.slice(PREFIJO_AES.length), 'base64')
    for (const pos of [0, 12, 20, raw.length - 1]) {
      const malo = Buffer.from(raw)
      malo[pos] = malo[pos]! ^ 0x01
      expect(descifrarAes(PREFIJO_AES + malo.toString('base64'), TEMA, CLAVE), `byte ${pos}`).toBeNull()
    }
  })

  it('clave distinta, tema distinto (tx reinyectado como rx o en otro nodo) o mensaje truncado: se rechazan', () => {
    expect(descifrarAes(VECTOR_AES, TEMA, claveDesdeHex('ff'.repeat(32)))).toBeNull()
    expect(descifrarAes(VECTOR_AES, 'invernadero/nodo-aa6490/rx', CLAVE)).toBeNull()
    expect(descifrarAes(VECTOR_AES, 'invernadero/otro-nodo/tx', CLAVE)).toBeNull()
    expect(descifrarAes(PREFIJO_AES + 'AAAA', TEMA, CLAVE)).toBeNull()
    expect(descifrarAes('sin-prefijo', TEMA, CLAVE)).toBeNull()
  })

  it('exige un nonce de 12 bytes', () => {
    expect(() => cifrarAes(TEXTO, TEMA, CLAVE, Buffer.alloc(8))).toThrow(/12 bytes/)
  })
})

describe('AES-128-GCM (clave de 32 hex)', () => {
  it('coincide con el vector de la implementación independiente, en ambos sentidos', () => {
    expect(cifrarAes(TEXTO, TEMA, CLAVE_128, NONCE_VECTOR)).toBe(VECTOR_AES128)
    expect(descifrarAes(VECTOR_AES128, TEMA, CLAVE_128)).toBe(TEXTO)
  })

  it('el tamaño de la clave decide el algoritmo: una clave de 128 bits no abre un mensaje de 256 y viceversa', () => {
    expect(descifrarAes(VECTOR_AES128, TEMA, CLAVE)).toBeNull()
    expect(descifrarAes(VECTOR_AES, TEMA, CLAVE_128)).toBeNull()
    expect(VECTOR_AES128).not.toBe(VECTOR_AES)
  })

  it('ida y vuelta con nonce aleatorio, alteración, tema distinto y política exigir', () => {
    const c = cifrarAes(TEXTO, TEMA, CLAVE_128)
    expect(c).not.toContain('temp')
    expect(descifrarAes(c, TEMA, CLAVE_128)).toBe(TEXTO)
    const raw = Buffer.from(c.slice(PREFIJO_AES.length), 'base64')
    raw[20] = raw[20]! ^ 0x01
    expect(descifrarAes(PREFIJO_AES + raw.toString('base64'), TEMA, CLAVE_128)).toBeNull()
    expect(descifrarAes(c, 'invernadero/nodo-aa6490/rx', CLAVE_128)).toBeNull()
    expect(decodificar(c, TEMA, CLAVE_128, 'exigir')).toEqual({ ok: true, modo: 'aes', texto: TEXTO })
    expect(decodificar(TEXTO, TEMA, CLAVE_128, 'exigir')).toEqual({ ok: false, motivo: 'cifrado_requerido' })
  })

  it('la respuesta rx también va en AES-128 y el nodo la puede descifrar', () => {
    const reply = formatRx({ status: 200, body: { ok: true, cfg: { auto: 0 }, ordenes: [{ id: 'x', tipo: 'riego', dur_s: 10 }] } })
    const a = codificar(reply, 'invernadero/nodo-aa6490/rx', 'aes', CLAVE_128)
    expect(a).not.toContain('riego')
    expect(decodificar(a, 'invernadero/nodo-aa6490/rx', CLAVE_128, 'permitir')).toMatchObject({ ok: true, texto: reply })
  })
})

describe('detección y decodificación por formato', () => {
  it('detecta el formato por el prefijo', () => {
    expect(detectarModo(TEXTO)).toBe('claro')
    expect(detectarModo(PREFIJO_B64 + 'AAAA')).toBe('b64')
    expect(detectarModo(VECTOR_AES)).toBe('aes')
  })

  it('claro: pasa tal cual (política permitir)', () => {
    expect(decodificar(TEXTO, TEMA, CLAVE, 'permitir')).toEqual({ ok: true, modo: 'claro', texto: TEXTO })
    expect(decodificar(Buffer.from(TEXTO), TEMA, null, 'permitir')).toEqual({ ok: true, modo: 'claro', texto: TEXTO })
  })

  it('b64: se decodifica, y solo es codificación (se revierte sin clave)', () => {
    const b64 = PREFIJO_B64 + Buffer.from(TEXTO).toString('base64')
    expect(decodificar(b64, TEMA, null, 'permitir')).toEqual({ ok: true, modo: 'b64', texto: TEXTO })
    expect(Buffer.from(b64.slice(PREFIJO_B64.length), 'base64').toString()).toBe(TEXTO)
    expect(decodificar(PREFIJO_B64 + '%%%', TEMA, null, 'permitir')).toEqual({ ok: false, motivo: 'b64_invalido' })
    expect(decodificar(PREFIJO_B64, TEMA, null, 'permitir')).toEqual({ ok: false, motivo: 'b64_invalido' })
  })

  it('aes: descifra con la clave; sin clave o con mensaje alterado devuelve el motivo', () => {
    expect(decodificar(VECTOR_AES, TEMA, CLAVE, 'permitir')).toEqual({ ok: true, modo: 'aes', texto: TEXTO })
    expect(decodificar(VECTOR_AES, TEMA, null, 'permitir')).toEqual({ ok: false, motivo: 'sin_clave' })
    expect(decodificar(VECTOR_AES.slice(0, -4) + 'AAAA', TEMA, CLAVE, 'permitir')).toEqual({ ok: false, motivo: 'descifrado_fallido' })
  })

  it('política exigir: solo se acepta AES (claro y b64 se rechazan aunque haya clave)', () => {
    expect(decodificar(TEXTO, TEMA, CLAVE, 'exigir')).toEqual({ ok: false, motivo: 'cifrado_requerido' })
    expect(decodificar(PREFIJO_B64 + Buffer.from(TEXTO).toString('base64'), TEMA, CLAVE, 'exigir')).toEqual({ ok: false, motivo: 'cifrado_requerido' })
    expect(decodificar(VECTOR_AES, TEMA, CLAVE, 'exigir')).toEqual({ ok: true, modo: 'aes', texto: TEXTO })
  })
})

describe('respuesta (rx): mismo formato que la solicitud', () => {
  const TEMA_RX = 'invernadero/nodo-aa6490/rx'
  const reply = formatRx({ status: 200, body: { ok: true, cfg: { auto: 0 }, ordenes: [{ id: 'x', tipo: 'riego', dur_s: 10 }] } })

  it('claro → claro, b64 → b64, aes → aes (y el nodo la puede descifrar con el tema rx)', () => {
    expect(codificar(reply, TEMA_RX, 'claro', null)).toBe(reply)
    const b = codificar(reply, TEMA_RX, 'b64', null)
    expect(b.startsWith(PREFIJO_B64)).toBe(true)
    expect(decodificar(b, TEMA_RX, null, 'permitir')).toMatchObject({ ok: true, texto: reply })
    const a = codificar(reply, TEMA_RX, 'aes', CLAVE)
    expect(a.startsWith(PREFIJO_AES)).toBe(true)
    expect(a).not.toContain('riego')
    expect(decodificar(a, TEMA_RX, CLAVE, 'permitir')).toMatchObject({ ok: true, texto: reply })
  })

  it('una orden de riego cifrada no se puede falsificar ni reutilizar en otro tema', () => {
    const a = codificar(reply, TEMA_RX, 'aes', CLAVE)
    expect(decodificar(a, 'invernadero/otro/rx', CLAVE, 'permitir')).toEqual({ ok: false, motivo: 'descifrado_fallido' })
    expect(decodificar(a, TEMA, CLAVE, 'permitir')).toEqual({ ok: false, motivo: 'descifrado_fallido' })
  })

  it('cifrar sin clave falla (no se responde en claro por descuido)', () => {
    expect(() => codificar(reply, TEMA_RX, 'aes', null)).toThrow(/sin clave/)
  })
})

describe('integración con el protocolo existente', () => {
  it('el texto descifrado se interpreta igual que el de un nodo en claro (token + trama)', () => {
    const dec = decodificar(cifrarAes(TEXTO, TEMA, CLAVE), TEMA, CLAVE, 'permitir')
    expect(dec.ok).toBe(true)
    if (!dec.ok) return
    const tx = parseTx(TEMA, dec.texto)
    expect(tx?.authorization).toBe('Bearer TOKEN-DE-PRUEBA')
    expect(tx?.replyTopic).toBe('invernadero/nodo-aa6490/rx')
    expect(JSON.parse(tx!.raw!)).toMatchObject({ seq: 7, temp: 69 })
  })
})
