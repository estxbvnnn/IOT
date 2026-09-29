import { describe, expect, it } from 'vitest'
import { open, seal } from '@/lib/auth/secretbox'

const KEY = 'clave-maestra-de-prueba-de-al-menos-32-caracteres'

describe('cifrado de secretos en reposo (AES-256-GCM)', () => {
  it('cifra y descifra', () => {
    const blob = seal('JBSWY3DPEHPK3PXP', KEY)
    expect(blob).not.toContain('JBSWY3DPEHPK3PXP')
    expect(open(blob, KEY)).toBe('JBSWY3DPEHPK3PXP')
  })

  it('el mismo texto cifrado dos veces da resultados distintos (IV aleatorio)', () => {
    expect(seal('x', KEY)).not.toBe(seal('x', KEY))
  })

  it('con otra clave maestra no descifra', () => {
    expect(open(seal('secreto', KEY), `${KEY}-otra`)).toBeNull()
  })

  it('el propósito forma parte de la autenticación (no se puede reutilizar un blob en otro contexto)', () => {
    expect(open(seal('secreto', KEY, 'totp'), KEY, 'totp-enroll')).toBeNull()
  })

  it('detecta cualquier alteración del contenido', () => {
    const blob = seal('secreto', KEY)
    const buf = Buffer.from(blob, 'base64url')
    buf[buf.length - 1] = buf[buf.length - 1]! ^ 1
    expect(open(buf.toString('base64url'), KEY)).toBeNull()
    expect(open('no-es-un-blob', KEY)).toBeNull()
    expect(open('', KEY)).toBeNull()
  })
})
