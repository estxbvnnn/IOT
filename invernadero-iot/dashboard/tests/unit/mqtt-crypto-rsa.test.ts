import { constants, createPrivateKey, createPublicKey, generateKeyPairSync, publicEncrypt, randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  PREFIJO_RSA, abrirRespuesta, bytesRsa, claveDesdeHex, cifrarAes, cifrarRsa, codificar, decodificar, descifrarRsa, detectarModo,
} from '../../scripts/lib/mqtt-crypto'
import { formatRx, parseTx } from '../../scripts/lib/gateway-mqtt'

const TEMA = 'invernadero/nodo-aa6490/tx'
const TEXTO = 'TOKEN-DE-PRUEBA\n{"v":1,"seq":7,"temp":69.0,"hum_aire":40.5}'
const CLAVE_AES = claveDesdeHex('000102030405060708090a0b0c0d0e0f')

// Clave RSA-2048 SOLO PARA PRUEBAS (no es la de la Pi) y un mensaje cifrado con ella por una implementación INDEPENDIENTE
// (python-cryptography / OpenSSL): OAEP con SHA-256 envuelve la clave de sesión K = f0e1d2c3b4a5968778695a4b3c2d1e0f y
// AES-128-GCM cifra el texto (nonce b1b2…bc, AAD = TEMA). Así se comprueba que la pasarela abre lo que cifre otro programa.
const RSA_PRUEBA_PEM = `-----BEGIN PRIVATE KEY-----
MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQCGUVx4fvezW7N+
q7tKY1PgJAYEQw6Eg5yV+kfrq0JmOyzinb3XFPUcN8vczUZeXiv9P/hlKe/Ow7Te
PaLBHzm8e9rRyTlcrmAFXZIzmLTZvw8lwL7GRG6WVaSRn5O/PalYixSBHcWBRNW6
LlqQKSFA0jzwhuqbKzISHJr3fIFg/b+Z6YUvkvZjtOf+SToGpPQTCMGiE+LVBvqc
zCM6rHXC6+GepTfxVJttBE6sTeTf0p/pGaSbmzX0X7xx1N0ycDZQZRuOxux+21vX
huYyqZJhUd8WmxCu+8L2L31IPuZNe9h80aTIp+JaB/sZCfgELcgV+bLqcGDJdx2K
3QrI07j/AgMBAAECggEANdzgsS1xVYqbg1uIor8MPqETjJf7dWZ136rbNoWZ/fcS
+9l37I1p8aPqa6Qh6OvoxgjmKmNT2F2g5VJgNwO3mn8sc94205TVyrEIVQqS05ML
lv8hQc7lbgHwGbmdfR5UD77OPSzcLAeXka7PAGqN/DmS2H2yDQGYdazk9AQIugTT
FqJrCexSlVVhL1bHiZxVkrne4cuW9BtWXpc/XTOArDgdinmGYxDUQPzEsewPgG6L
DTJx3u4PK6oFESXXmhcOLDC8eW/eNZj1O64z9nZxFLIM3b+5B0yYPe86aqK3n9R7
5/B/5TbI/RvRf1NPxxTz0LHRN9KivY+YHTCwWWEb6QKBgQC80AoJecVolsDtl0Gh
O+0okdQL+DSJ2CV2SlLaYaKSQLN4y9Wqp5C/jcXQBzK6937mJCX86hK0PxhXfWhJ
lo+pbn1kivPCulpfTDEZzDDh7qtUPFPUtjWgILkMpofTT00CaJEIZZCA6xawV82B
NbxtKd8epQKsiAzcjaioHAFLgwKBgQC2HRgXNdBksA1eF+UngGzvO9E62BacLHFb
FHoQdBhf5wLivAuxhLl41B6sonf9eX6ynMGOm2mRlCX3Xkd04IjA1AF7mAnpC29v
YgyPbPb0d5GEH6gjgKI3V8z+dc/LQ/ct8A0kRm1Sh+aKu0RS78nXoODsfPP1B8tk
n5FHaOJ31QKBgQCen2BvSYARN+VpNVOLsx6woKK2U5U/4PjIAfTNRo0ftX+Rkh01
O4UdiGuRMxrpfBd+HQxVCAkiqIc4qUC94eFbhFmP6DSVeZ2GxinR9Ht0s9/36p66
60Dt/8+20wj0+4BE77g4h6r4w4fSKlGZpZ1hUHYD9rjiXYIAoHn6kVx9JQKBgF2p
dPxq9vTx/s4H6Bl62Yvo7eEfxfEoglxfma/gpbCdNUS7hiAUrPdR0TzkimXZGKpw
KLRZheATm7svx/x6hpr17pVMSryK3xMgEGmrlw+Ad1zGk0k/HS7tf0bX/LkECZqc
vYWMmyk5L/7l9WvaW6sE2OmIEkhRa/AiiSt67A7JAoGAfCFFyaLowCRJVy3Zecl1
PEE09quSRRYpb1qCPIIDo/xRLCrFp2G1quTK0/vBkt3EWRLXcUgE8BKi9yT75r3Z
eoKWbCLRt6SHln/Mah0VYrMMu+ewCOaU83o9UR6bWmHfkf3uzadZ05L+6qteMdhO
+kk39h+ER1pzzRoT9PWoJr0=
-----END PRIVATE KEY-----
`
const VECTOR_RSA =
  'rsa1:IvDgYvZTX9e+SLpSvkHM56WGM4r7Ktt1bp5JoSFLxXJskbC+bLo5lzrLtQ5vnzkbSlln1YJKRKSc934Sn3Sp3mkXt2iKByk+QopsCEErWooLsnt1dI/j5TEz38eCg9kpJOnqIo1u84lOb8zTulMgiSk4BakuxJdbCusig6Dtl7LL4f2DpyxlFcmhZ78+gMOxioeVGCn2medzFsd5m9m89BJfpa8WP72xyjqvpnuYt77LGrB/tBaE0TKltYVFJiqQFDhzl/tcmgH1POAXHfrhh1XXsD9dj7j64BSS2IFL4Hx2ZbZjyt3E9vTOMQ8Fmge+WovRa6+MMm4fvugZlB5Ce7Gys7S1tre4ubq7vNaxtn5VJe5i5s4D1dxT627zTOW1HH142R2n6cT6a9a1ZQHunVzcYCWcycuDlvofnzu1B9/e3LrCYk7RSzlmvJtllnY+WiV8knPvfA=='
const SESION_VECTOR = Buffer.from('f0e1d2c3b4a5968778695a4b3c2d1e0f', 'hex')

describe('RSA: clave pública para cifrar, clave privada para descifrar', () => {
  const privada = createPrivateKey(RSA_PRUEBA_PEM)
  const publicaPem = createPublicKey(privada).export({ type: 'spki', format: 'pem' }) as string

  it('abre el mensaje cifrado por otra implementación (OpenSSL) y recupera la clave de sesión', () => {
    const r = descifrarRsa(VECTOR_RSA, TEMA, privada)
    expect(r?.texto).toBe(TEXTO)
    expect(r?.sesion.equals(SESION_VECTOR)).toBe(true)
    expect(detectarModo(VECTOR_RSA)).toBe('rsa')
  })

  it('ida y vuelta con la clave pública; dos cifrados del mismo texto nunca son iguales ni contienen nada legible', () => {
    const a = cifrarRsa(TEXTO, TEMA, publicaPem)
    const b = cifrarRsa(TEXTO, TEMA, publicaPem)
    expect(a.payload).not.toBe(b.payload)
    expect(a.payload.startsWith(PREFIJO_RSA)).toBe(true)
    for (const s of ['TOKEN', 'temp', 'hum_aire']) expect(a.payload).not.toContain(s)
    expect(descifrarRsa(a.payload, TEMA, privada)?.texto).toBe(TEXTO)
    expect(descifrarRsa(b.payload, TEMA, privada)?.sesion.equals(b.sesion)).toBe(true)
    expect(bytesRsa(privada)).toBe(256)
  })

  it('la clave de sesión por defecto es AES-256 (32 bytes) y la de AES-128 (16 bytes, firmware anterior) también se acepta', () => {
    const nueva = cifrarRsa(TEXTO, TEMA, publicaPem)
    expect(nueva.sesion.length).toBe(32)
    expect(descifrarRsa(nueva.payload, TEMA, privada)).toMatchObject({ texto: TEXTO })
    expect(descifrarRsa(nueva.payload, TEMA, privada)?.sesion.length).toBe(32)
    const vieja = cifrarRsa(TEXTO, TEMA, publicaPem, randomBytes(16))
    expect(descifrarRsa(vieja.payload, TEMA, privada)?.sesion.length).toBe(16)
    // otro largo no es una clave AES válida: se rechaza
    const envuelta24 = publicEncrypt({ key: publicaPem, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, randomBytes(24))
    const malo = PREFIJO_RSA + Buffer.concat([envuelta24, randomBytes(12 + 40 + 16)]).toString('base64')
    expect(descifrarRsa(malo, TEMA, privada)).toBeNull()
    // la respuesta con una sesión de 32 bytes la abre solo el nodo que la tiene
    const rx = codificar('200 0\n{"ok":true}', 'invernadero/nodo-aa6490/rx', 'rsa', null, nueva.sesion)
    expect(abrirRespuesta(rx, 'invernadero/nodo-aa6490/rx', null, nueva.sesion)).toMatchObject({ ok: true, texto: '200 0\n{"ok":true}' })
  })

  it('otra clave privada no puede abrirlo', () => {
    const { payload } = cifrarRsa(TEXTO, TEMA, publicaPem)
    const otra = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey
    expect(descifrarRsa(payload, TEMA, otra)).toBeNull()
  })

  it('un bit alterado (en la clave envuelta, en el cifrado o en la etiqueta), otro tema o un truncado: se rechazan', () => {
    const { payload } = cifrarRsa(TEXTO, TEMA, publicaPem)
    const raw = Buffer.from(payload.slice(PREFIJO_RSA.length), 'base64')
    for (const pos of [5, 255, 256 + 3, 256 + 12 + 2, raw.length - 1]) {
      const malo = Buffer.from(raw)
      malo[pos] = malo[pos]! ^ 0x01
      expect(descifrarRsa(PREFIJO_RSA + malo.toString('base64'), TEMA, privada), `byte ${pos}`).toBeNull()
    }
    expect(descifrarRsa(payload, 'invernadero/nodo-aa6490/rx', privada)).toBeNull()
    expect(descifrarRsa(payload, 'invernadero/otro/tx', privada)).toBeNull()
    expect(descifrarRsa(PREFIJO_RSA + 'AAAA', TEMA, privada)).toBeNull()
    expect(descifrarRsa('sin-prefijo', TEMA, privada)).toBeNull()
  })

  it('decodificar(): con la privada abre; sin ella pide la clave; exigir-rsa solo admite rsa; exigir admite aes o rsa', () => {
    expect(decodificar(VECTOR_RSA, TEMA, null, 'permitir', privada)).toMatchObject({ ok: true, modo: 'rsa', texto: TEXTO })
    expect(decodificar(VECTOR_RSA, TEMA, null, 'permitir', null)).toEqual({ ok: false, motivo: 'sin_clave' })
    expect(decodificar(VECTOR_RSA, TEMA, null, 'exigir', privada)).toMatchObject({ ok: true, modo: 'rsa' })
    expect(decodificar(VECTOR_RSA, TEMA, null, 'exigir-rsa', privada)).toMatchObject({ ok: true, modo: 'rsa' })
    const aes = cifrarAes(TEXTO, TEMA, CLAVE_AES)
    expect(decodificar(TEXTO, TEMA, CLAVE_AES, 'exigir-rsa', privada)).toEqual({ ok: false, motivo: 'cifrado_requerido' })
    expect(decodificar(aes, TEMA, CLAVE_AES, 'exigir-rsa', privada)).toEqual({ ok: false, motivo: 'cifrado_requerido' })
    expect(decodificar(aes, TEMA, CLAVE_AES, 'exigir', privada)).toMatchObject({ ok: true, modo: 'aes' })
    expect(decodificar(TEXTO, TEMA, CLAVE_AES, 'exigir', privada)).toEqual({ ok: false, motivo: 'cifrado_requerido' })
  })

  it('la respuesta va cifrada con la clave de sesión de ESA petición: solo el nodo que la hizo la puede leer', () => {
    const { payload, sesion } = cifrarRsa(TEXTO, TEMA, publicaPem)
    const dec = decodificar(payload, TEMA, null, 'permitir', privada)
    expect(dec.ok && dec.sesion?.equals(sesion)).toBe(true)
    const reply = formatRx({ status: 200, body: { ok: true, cfg: { auto: 0 }, ordenes: [{ id: 'x', tipo: 'riego', dur_s: 10 }] } })
    const TEMA_RX = 'invernadero/nodo-aa6490/rx'
    const rx = codificar(reply, TEMA_RX, 'rsa', null, dec.ok ? (dec.sesion ?? null) : null)
    expect(rx.startsWith(PREFIJO_RSA)).toBe(true)
    expect(rx).not.toContain('riego')
    expect(abrirRespuesta(rx, TEMA_RX, null, sesion)).toMatchObject({ ok: true, texto: reply })
    expect(abrirRespuesta(rx, TEMA_RX, null, randomBytes(16))).toEqual({ ok: false, motivo: 'descifrado_fallido' })
    expect(abrirRespuesta(rx, TEMA, null, sesion)).toEqual({ ok: false, motivo: 'descifrado_fallido' })
    expect(abrirRespuesta(rx, TEMA_RX, null, null)).toEqual({ ok: false, motivo: 'sin_clave' })
    expect(() => codificar(reply, TEMA_RX, 'rsa', null, null)).toThrow(/sesión/)
  })

  it('cifrar con la clave pública no autentica al emisor: el token, que viaja DENTRO, es lo que identifica al nodo', () => {
    const { payload } = cifrarRsa('TOKEN-FALSO\n{"v":1}', TEMA, publicaPem)
    const dec = decodificar(payload, TEMA, null, 'permitir', privada)
    expect(dec.ok).toBe(true)
    if (dec.ok) expect(parseTx(TEMA, dec.texto)?.authorization).toBe('Bearer TOKEN-FALSO') // la pasarela lo valida contra la base
  })
})
