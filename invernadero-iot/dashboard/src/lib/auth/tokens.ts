import crypto from 'node:crypto'

/** Token aleatorio de 256 bits en base64url (cookie de sesión, token de nodo, contraseñas iniciales). */
export function generateToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString('base64url')
}

export function sha256(input: string | Buffer): Buffer {
  return crypto.createHash('sha256').update(input).digest()
}

/**
 * Los tokens (sesión y nodo) solo se guardan como SHA-256. Como son aleatorios de 256 bits no hace
 * falta un KDF lento: un volcado de la base no permite recuperar ni usar los tokens.
 */
export function hashToken(token: string): Buffer {
  return sha256(token)
}

/** Comparación en tiempo constante (evita ataques de temporización). */
export function safeEqual(a: string | Buffer, b: string | Buffer): boolean {
  const ba = typeof a === 'string' ? Buffer.from(a) : a
  const bb = typeof b === 'string' ? Buffer.from(b) : b
  if (ba.length !== bb.length) {
    // Se compara igualmente para no filtrar por tiempo dónde difiere la longitud.
    crypto.timingSafeEqual(ba, ba)
    return false
  }
  return crypto.timingSafeEqual(ba, bb)
}

/** Alfabeto sin caracteres ambiguos (0/O, 1/l/I) para claves que una persona debe teclear. */
const READABLE = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789'

/** Contraseña aleatoria legible de alta entropía (~5,8 bits por carácter). */
export function generatePassword(length = 16): string {
  const bytes = crypto.randomBytes(length * 2)
  let out = ''
  for (let i = 0; out.length < length && i < bytes.length; i++) {
    // Rechazo de valores sesgados: 224 = 4 * 56, múltiplo del tamaño del alfabeto.
    const b = bytes[i]!
    if (b < 224) out += READABLE[b % READABLE.length]
  }
  if (out.length < length) return generatePassword(length)
  return out
}
