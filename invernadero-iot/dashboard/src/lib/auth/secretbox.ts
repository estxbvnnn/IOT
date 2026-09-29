import crypto from 'node:crypto'

/**
 * Cifrado autenticado (AES-256-GCM) de secretos en reposo, p. ej. la semilla TOTP de cada usuario.
 * La clave se deriva de APP_SECRET con HKDF; rotar APP_SECRET invalida los secretos guardados
 * (los usuarios tendrían que volver a registrar su segundo factor).
 *
 * Formato: base64url( versión(1) ‖ iv(12) ‖ etiqueta(16) ‖ texto cifrado )
 */
const VERSION = 1

function key(appSecret: string, purpose: string): Buffer {
  return Buffer.from(crypto.hkdfSync('sha256', appSecret, 'invernadero-iot/secretbox/v1', purpose, 32))
}

export function seal(plain: string, appSecret: string, purpose = 'totp'): string {
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', key(appSecret, purpose), iv)
  cipher.setAAD(Buffer.from(purpose))
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
  return Buffer.concat([Buffer.from([VERSION]), iv, cipher.getAuthTag(), enc]).toString('base64url')
}

/** Devuelve null si el dato fue alterado, la clave cambió o el formato no es válido. */
export function open(blob: string, appSecret: string, purpose = 'totp'): string | null {
  try {
    const buf = Buffer.from(blob, 'base64url')
    if (buf.length < 1 + 12 + 16 || buf[0] !== VERSION) return null
    const iv = buf.subarray(1, 13)
    const tag = buf.subarray(13, 29)
    const enc = buf.subarray(29)
    const decipher = crypto.createDecipheriv('aes-256-gcm', key(appSecret, purpose), iv)
    decipher.setAAD(Buffer.from(purpose))
    decipher.setAuthTag(tag)
    return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8')
  } catch {
    return null
  }
}
