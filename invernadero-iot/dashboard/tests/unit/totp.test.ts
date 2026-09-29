import { describe, expect, it } from 'vitest'
import { base32Decode, base32Encode, generateTotpSecret, otpauthUri, totpAt, verifyTotp } from '@/lib/auth/totp'

// Vectores de la RFC 6238 (SHA-1): semilla ASCII «12345678901234567890».
const RFC_SECRET = base32Encode(Buffer.from('12345678901234567890'))

describe('TOTP (RFC 6238)', () => {
  it('la semilla de la RFC codifica al base32 conocido', () => {
    expect(RFC_SECRET).toBe('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ')
  })

  it.each([
    [59, '94287082'],
    [1111111109, '07081804'],
    [1111111111, '14050471'],
    [1234567890, '89005924'],
    [2000000000, '69279037'],
  ])('reproduce el vector de la RFC en t=%i (8 dígitos)', (t, expected) => {
    expect(totpAt(RFC_SECRET, t * 1000, { digits: 8 })).toBe(expected)
  })

  it('con 6 dígitos son los últimos 6 del vector', () => {
    expect(totpAt(RFC_SECRET, 59_000)).toBe('287082')
  })

  it('base32 es reversible y rechaza caracteres inválidos', () => {
    const buf = Buffer.from([0, 1, 2, 250, 251, 252, 253, 254, 255, 7, 8])
    expect(base32Decode(base32Encode(buf)).equals(buf)).toBe(true)
    expect(() => base32Decode('1!?')).toThrow()
  })

  it('genera semillas distintas de 160 bits', () => {
    const a = generateTotpSecret()
    expect(a).toMatch(/^[A-Z2-7]{32}$/)
    expect(generateTotpSecret()).not.toBe(a)
  })
})

describe('verificación', () => {
  const t0 = 1_800_000_000_000
  const code = (t: number) => totpAt(RFC_SECRET, t)

  it('acepta el código actual, y ±1 paso por desfase de relojes', () => {
    expect(verifyTotp(RFC_SECRET, code(t0), t0).ok).toBe(true)
    expect(verifyTotp(RFC_SECRET, code(t0 - 30_000), t0).ok).toBe(true)
    expect(verifyTotp(RFC_SECRET, code(t0 + 30_000), t0).ok).toBe(true)
  })

  it('rechaza códigos de hace 2 pasos y códigos mal formados', () => {
    expect(verifyTotp(RFC_SECRET, code(t0 - 90_000), t0).ok).toBe(false)
    expect(verifyTotp(RFC_SECRET, '12345', t0).ok).toBe(false)
    expect(verifyTotp(RFC_SECRET, 'abcdef', t0).ok).toBe(false)
    expect(verifyTotp(RFC_SECRET, '1234567', t0).ok).toBe(false)
  })

  it('tolera espacios (así los muestran las apps)', () => {
    const c = code(t0)
    expect(verifyTotp(RFC_SECRET, `${c.slice(0, 3)} ${c.slice(3)}`, t0).ok).toBe(true)
  })

  it('no permite reutilizar un paso ya consumido (anti-repetición)', () => {
    const first = verifyTotp(RFC_SECRET, code(t0), t0)
    expect(first.ok).toBe(true)
    expect(verifyTotp(RFC_SECRET, code(t0), t0, first.step).ok).toBe(false)
    // Un código del paso anterior tampoco sirve después de haber usado el actual.
    expect(verifyTotp(RFC_SECRET, code(t0 - 30_000), t0, first.step).ok).toBe(false)
    // Pero el paso siguiente sí.
    expect(verifyTotp(RFC_SECRET, code(t0 + 30_000), t0 + 30_000, first.step).ok).toBe(true)
  })

  it('el URI otpauth trae emisor, cuenta y parámetros', () => {
    const uri = otpauthUri({ secret: RFC_SECRET, account: 'ana@invernadero.local', issuer: 'Invernadero IoT' })
    expect(uri).toMatch(/^otpauth:\/\/totp\/Invernadero%20IoT:ana%40invernadero\.local\?/)
    expect(uri).toContain(`secret=${RFC_SECRET}`)
    expect(uri).toContain('digits=6')
    expect(uri).toContain('period=30')
  })
})
