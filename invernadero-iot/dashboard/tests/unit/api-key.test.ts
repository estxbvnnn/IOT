import { describe, expect, it } from 'vitest'
import { API_KEY_PREFIX, parseApiKey } from '@/lib/auth/api-key'

const KEY = `${API_KEY_PREFIX}${'A'.repeat(43)}`

describe('clave de API: formato de la cabecera', () => {
  it('acepta «Bearer iotk_…» (con espacios de más)', () => {
    expect(parseApiKey(`Bearer ${KEY}`)).toBe(KEY)
    expect(parseApiKey(`  Bearer   ${KEY}  `)).toBe(KEY)
  })

  it('no confunde un token de nodo (sin el prefijo iotk_) con una clave de API', () => {
    expect(parseApiKey(`Bearer ${'A'.repeat(43)}`)).toBeNull()
  })

  it('rechaza cabeceras ausentes, de otro tipo, cortas o con caracteres raros', () => {
    expect(parseApiKey(null)).toBeNull()
    expect(parseApiKey('')).toBeNull()
    expect(parseApiKey(`Basic ${KEY}`)).toBeNull()
    expect(parseApiKey(`Bearer ${API_KEY_PREFIX}corta`)).toBeNull()
    expect(parseApiKey(`Bearer ${KEY}!`)).toBeNull()
    expect(parseApiKey(`Bearer ${KEY} otra`)).toBeNull()
  })
})
