import crypto from 'node:crypto'
import { safeEqual } from './tokens'

/**
 * TOTP (RFC 6238) con HMAC-SHA1, 6 dígitos y paso de 30 s: compatible con Google Authenticator,
 * Microsoft Authenticator, Aegis, 1Password, etc. Implementado con crypto de Node (sin dependencias).
 */
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

export function base32Encode(buf: Buffer): string {
  let bits = 0
  let value = 0
  let out = ''
  for (const byte of buf) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31]
  return out
}

export function base32Decode(input: string): Buffer {
  const clean = input.replace(/=+$/, '').replace(/\s+/g, '').toUpperCase()
  let bits = 0
  let value = 0
  const out: number[] = []
  for (const ch of clean) {
    const idx = ALPHABET.indexOf(ch)
    if (idx < 0) throw new Error('Base32 inválido')
    value = (value << 5) | idx
    bits += 5
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255)
      bits -= 8
    }
  }
  return Buffer.from(out)
}

export function generateTotpSecret(): string {
  return base32Encode(crypto.randomBytes(20))
}

function hotp(secret: Buffer, counter: number, digits: number): string {
  const msg = Buffer.alloc(8)
  msg.writeBigUInt64BE(BigInt(counter))
  const h = crypto.createHmac('sha1', secret).update(msg).digest()
  const offset = h[h.length - 1]! & 0x0f
  const bin =
    ((h[offset]! & 0x7f) << 24) | (h[offset + 1]! << 16) | (h[offset + 2]! << 8) | h[offset + 3]!
  return String(bin % 10 ** digits).padStart(digits, '0')
}

export interface TotpOptions { digits?: number; period?: number }

/** Contador de tiempo (paso) para un instante dado. */
export function totpStep(nowMs: number, period = 30): number {
  return Math.floor(nowMs / 1000 / period)
}

export function totpAt(secretB32: string, nowMs: number, { digits = 6, period = 30 }: TotpOptions = {}): string {
  return hotp(base32Decode(secretB32), totpStep(nowMs, period), digits)
}

export interface TotpVerification { ok: boolean; step: number | null }

/**
 * Verifica un código con tolerancia de ±1 paso (relojes desfasados) y rechaza reutilizar un paso ya
 * consumido (`lastUsedStep`): un código espiado no sirve una segunda vez.
 */
export function verifyTotp(
  secretB32: string,
  code: string,
  nowMs: number,
  lastUsedStep: number | null = null,
  { digits = 6, period = 30 }: TotpOptions = {},
): TotpVerification {
  const clean = code.replace(/\s+/g, '')
  if (!new RegExp(`^\\d{${digits}}$`).test(clean)) return { ok: false, step: null }
  const secret = base32Decode(secretB32)
  const current = totpStep(nowMs, period)
  let matched: number | null = null
  for (const delta of [0, -1, 1]) {
    const step = current + delta
    // Se recorren siempre las tres ventanas (sin cortar) para no filtrar por tiempo cuál coincidió.
    if (safeEqual(hotp(secret, step, digits), clean) && matched === null) matched = step
  }
  if (matched === null) return { ok: false, step: null }
  if (lastUsedStep !== null && matched <= lastUsedStep) return { ok: false, step: null }
  return { ok: true, step: matched }
}

/** URI otpauth:// que leen las apps autenticadoras (se muestra como QR). */
export function otpauthUri(opts: { secret: string; account: string; issuer: string }): string {
  const label = `${encodeURIComponent(opts.issuer)}:${encodeURIComponent(opts.account)}`
  const q = new URLSearchParams({ secret: opts.secret, issuer: opts.issuer, algorithm: 'SHA1', digits: '6', period: '30' })
  return `otpauth://totp/${label}?${q.toString()}`
}
