import crypto from 'node:crypto'
import { safeEqual } from './tokens'

/**
 * Hash de contraseñas con scrypt (incluido en Node: sin dependencias nativas).
 * Parámetros: N = 2^15, r = 8, p = 1  →  ~32 MiB y ~80 ms por verificación.
 * Formato almacenado: scrypt$N$r$p$<sal base64>$<hash base64>  (los parámetros viajan con el hash,
 * así se pueden endurecer más adelante y detectar hashes viejos con needsRehash()).
 */
const PARAMS = { N: 2 ** 15, r: 8, p: 1 } as const
const KEYLEN = 32
const SALT_BYTES = 16

function scrypt(password: string, salt: Buffer, N: number, r: number, p: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password.normalize('NFKC'), salt, KEYLEN, { N, r, p, maxmem: 256 * N * r }, (err, key) =>
      err ? reject(err) : resolve(key),
    )
  })
}

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.randomBytes(SALT_BYTES)
  const key = await scrypt(password, salt, PARAMS.N, PARAMS.r, PARAMS.p)
  return ['scrypt', PARAMS.N, PARAMS.r, PARAMS.p, salt.toString('base64'), key.toString('base64')].join('$')
}

interface Parsed { N: number; r: number; p: number; salt: Buffer; key: Buffer }

function parse(stored: string): Parsed | null {
  const parts = stored.split('$')
  if (parts.length !== 6 || parts[0] !== 'scrypt') return null
  const [N, r, p] = [Number(parts[1]), Number(parts[2]), Number(parts[3])]
  if (![N, r, p].every((n) => Number.isInteger(n) && n > 0)) return null
  // Límite superior: un hash manipulado en la base no debe poder agotar la memoria del servidor.
  if (N > 2 ** 20 || r > 32 || p > 16) return null
  return { N, r, p, salt: Buffer.from(parts[4]!, 'base64'), key: Buffer.from(parts[5]!, 'base64') }
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parsed = parse(stored)
  if (!parsed) return false
  const key = await scrypt(password, parsed.salt, parsed.N, parsed.r, parsed.p)
  return safeEqual(key, parsed.key)
}

/** true si el hash usa parámetros más débiles que los actuales. */
export function needsRehash(stored: string): boolean {
  const parsed = parse(stored)
  if (!parsed) return true
  return parsed.N < PARAMS.N || parsed.r < PARAMS.r || parsed.p < PARAMS.p
}

let dummy: Promise<string> | null = null

/**
 * Hash falso para «gastar» el mismo tiempo cuando el correo no existe:
 * sin esto, responder más rápido delata qué cuentas existen.
 */
export function dummyHash(): Promise<string> {
  dummy ??= hashPassword(crypto.randomBytes(16).toString('hex'))
  return dummy
}

const COMMON = new Set([
  'password1234', 'contrasena123', 'contraseña123', '123456789012', '1234567890ab', 'qwertyuiop12',
  'administrador', 'invernadero123', 'invernadero1234', 'passwordpassword', 'welcome12345',
])

/**
 * Política de contraseñas del informe («alta entropía»): largo mínimo 12, sin datos personales
 * obvios ni claves triviales. Devuelve un mensaje de error o null si es aceptable.
 */
export function validatePasswordStrength(password: string, ctx: { email?: string; name?: string } = {}): string | null {
  if (password.length < 12) return 'La contraseña debe tener al menos 12 caracteres.'
  if (password.length > 128) return 'La contraseña no puede superar los 128 caracteres.'
  if (new Set(password).size < 5) return 'La contraseña es demasiado repetitiva.'
  const lower = password.toLowerCase()
  if (COMMON.has(lower)) return 'La contraseña es demasiado común.'
  const local = ctx.email?.split('@')[0]?.toLowerCase()
  if (local && local.length >= 4 && lower.includes(local)) return 'La contraseña no debe contener tu correo.'
  for (const part of (ctx.name ?? '').toLowerCase().split(/\s+/)) {
    if (part.length >= 4 && lower.includes(part)) return 'La contraseña no debe contener tu nombre.'
  }
  if (!/[a-zA-Z]/.test(password) || !/[0-9]/.test(password)) return 'Combina letras y números.'
  return null
}
