import { describe, expect, it } from 'vitest'
import { dummyHash, hashPassword, needsRehash, validatePasswordStrength, verifyPassword } from '@/lib/auth/password'
import { generatePassword, generateToken, hashToken, safeEqual, sha256 } from '@/lib/auth/tokens'

describe('hash de contraseñas (scrypt)', () => {
  it('verifica la correcta y rechaza la incorrecta', async () => {
    const h = await hashPassword('Correcta-Caballo-9')
    expect(h).toMatch(/^scrypt\$32768\$8\$1\$/)
    expect(await verifyPassword('Correcta-Caballo-9', h)).toBe(true)
    expect(await verifyPassword('correcta-caballo-9', h)).toBe(false)
    expect(await verifyPassword('', h)).toBe(false)
  })

  it('cada hash lleva sal distinta', async () => {
    const [a, b] = await Promise.all([hashPassword('misma-clave-123'), hashPassword('misma-clave-123')])
    expect(a).not.toBe(b)
  })

  it('normaliza Unicode (NFKC): «é» compuesta y descompuesta son la misma contraseña', async () => {
    const h = await hashPassword('café-secreto-12')
    expect(await verifyPassword('café-secreto-12', h)).toBe(true)
  })

  it('un hash manipulado o con parámetros abusivos no se acepta ni agota memoria', async () => {
    expect(await verifyPassword('x', 'no-es-un-hash')).toBe(false)
    expect(await verifyPassword('x', 'scrypt$1048576000$8$1$AAAA$AAAA')).toBe(false)
    expect(await verifyPassword('x', 'scrypt$32768$8$1000$AAAA$AAAA')).toBe(false)
  })

  it('detecta hashes con parámetros más débiles que los actuales', async () => {
    expect(needsRehash(await hashPassword('lo-que-sea-12345'))).toBe(false)
    expect(needsRehash('scrypt$16384$8$1$AAAA$AAAA')).toBe(true)
    expect(needsRehash('basura')).toBe(true)
  })

  it('el hash señuelo existe y no coincide con nada razonable', async () => {
    expect(await verifyPassword('admin', await dummyHash())).toBe(false)
  })
})

describe('política de contraseñas (alta entropía)', () => {
  it.each([
    ['corta1', /12 caracteres/],
    ['a'.repeat(129), /128/],
    ['aaaaaaaaaaaa1', /repetitiva/],
    ['contrasena123', /común/],
    ['soloLetrasSinNumeros', /letras y números/],
    ['123456789012345', /letras y números/],
  ])('rechaza «%s»', (pw, msg) => {
    expect(validatePasswordStrength(pw)).toMatch(msg)
  })

  it('rechaza contraseñas que contienen el correo o el nombre', () => {
    expect(validatePasswordStrength('ana.perez-2026-x', { email: 'ana.perez@correo.cl' })).toMatch(/correo/)
    expect(validatePasswordStrength('clave-de-Mariana-77', { name: 'Mariana Soto' })).toMatch(/nombre/)
  })

  it('acepta una frase larga con letras y números', () => {
    expect(validatePasswordStrength('Tomate-Cherry-Riego-42')).toBeNull()
  })
})

describe('tokens y utilidades', () => {
  it('los tokens son aleatorios de 256 bits en base64url', () => {
    const t = generateToken()
    expect(t).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(generateToken()).not.toBe(t)
  })

  it('las contraseñas generadas usan solo caracteres no ambiguos y tienen el largo pedido', () => {
    for (let i = 0; i < 50; i++) {
      const p = generatePassword(16)
      expect(p).toHaveLength(16)
      expect(p).toMatch(/^[A-HJ-NP-Za-km-z2-9]{16}$/)
    }
  })

  it('safeEqual compara en tiempo constante y con largos distintos devuelve false', () => {
    expect(safeEqual('abc', 'abc')).toBe(true)
    expect(safeEqual('abc', 'abd')).toBe(false)
    expect(safeEqual('abc', 'abcd')).toBe(false)
    expect(safeEqual(Buffer.from('x'), Buffer.from('x'))).toBe(true)
  })

  it('hashToken es SHA-256 (32 bytes) y determinista', () => {
    expect(hashToken('t')).toHaveLength(32)
    expect(hashToken('t').equals(sha256('t'))).toBe(true)
    expect(hashToken('t').equals(hashToken('u'))).toBe(false)
  })
})
