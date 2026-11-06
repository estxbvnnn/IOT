/**
 * Cifrado del payload MQTT entre los nodos y la pasarela (clase de cifrado de datos IoT, 20 oct 2026).
 *
 * Cuatro formatos del mensaje; el texto que viaja es siempre el mismo que ya usa el protocolo
 * («TOKEN\n{trama}» hacia la pasarela, «<HTTP> <Retry-After>\n{respuesta}» de vuelta):
 *
 *   claro   TOKEN\n{json}                                   (el de siempre: cualquiera con Wireshark lo lee)
 *   b64     b64:<base64(texto)>                             (solo CODIFICA: se revierte con «base64 -d», no protege nada)
 *   aes     aes1:<base64(nonce12 ‖ cifrado ‖ etiqueta16)>   AES-GCM con una clave COMPARTIDA (128 o 256 bits)
 *   rsa     rsa1:<base64(clave_envuelta ‖ nonce12 ‖ cifrado ‖ etiqueta16)>   CLAVE PÚBLICA / PRIVADA (ver abajo)
 *
 * AES-GCM (aes): clave compartida (MQTT_AES_KEY): 32 caracteres hex = 16 bytes = AES-128 (el usado en la práctica), o
 * 64 caracteres hex = 32 bytes = AES-256. El algoritmo se elige por el tamaño de la clave; el formato es el mismo.
 * El AAD es el tema MQTT, así un mensaje capturado en «…/tx» no se puede reinyectar como «…/rx» (ni en el tema de otro
 * nodo). El nonce de 12 bytes lo elige quien cifra y NUNCA debe repetirse con la misma clave. Si la etiqueta no coincide
 * (mensaje alterado, clave distinta, tema distinto) el descifrado falla y el mensaje se descarta.
 *
 * RSA (rsa) = cifrado HÍBRIDO con clave pública. El nodo solo conoce la CLAVE PÚBLICA de la Pi; la privada nunca sale de ella.
 * RSA no puede cifrar una trama entera (RSA-2048 con OAEP admite ~190 bytes), así que por cada mensaje:
 *   1. el nodo elige una clave AES-256 aleatoria K de 32 bytes (de un solo uso; también se acepta AES-128 de 16 bytes),
 *   2. cifra el texto con AES-GCM usando K (AAD = tema),
 *   3. cifra K con la clave pública RSA (OAEP, SHA-256) → «clave_envuelta» (256 bytes con RSA-2048).
 *   La pasarela descifra K con su clave privada, abre el mensaje, y RESPONDE cifrando con ese mismo K: solo el nodo que
 *   hizo la petición (que conoce K) puede leer la respuesta, y una orden falsificada no pasa la etiqueta GCM.
 * Ojo: la clave pública no autentica al emisor (cualquiera puede cifrar para la Pi); lo que identifica al nodo sigue
 * siendo su TOKEN, que viaja DENTRO del cifrado.
 *
 * Límite conocido: el usuario y la clave MQTT del CONNECT siguen viajando en claro; solo TLS (puerto 8883) lo evita.
 */
import {
  type KeyObject, constants, createCipheriv, createDecipheriv, createPublicKey, privateDecrypt, publicEncrypt, randomBytes,
} from 'node:crypto'

export type Modo = 'claro' | 'b64' | 'aes' | 'rsa'
/** permitir: todo · exigir: solo aes o rsa · exigir-rsa: solo rsa (clave pública/privada). */
export type Politica = 'permitir' | 'exigir' | 'exigir-rsa'

export const PREFIJO_B64 = 'b64:'
export const PREFIJO_AES = 'aes1:'
export const PREFIJO_RSA = 'rsa1:'
const NONCE = 12
const TAG = 16
/** Largo de la clave de sesión del modo rsa por defecto: 32 bytes = AES-256. La pasarela acepta también 16 (AES-128, firmware anterior). */
export const SESION_BYTES = 32
const SESIONES_VALIDAS: readonly number[] = [16, 32]

/** Algoritmo según el tamaño de la clave (16 o 32 bytes). */
export const algoritmo = (clave: Buffer): 'aes-128-gcm' | 'aes-256-gcm' => (clave.length === 16 ? 'aes-128-gcm' : 'aes-256-gcm')

/** Clave AES desde hex: 32 caracteres = AES-128, 64 caracteres = AES-256. Lanza si no es válida. */
export function claveDesdeHex(hex: string): Buffer {
  const h = hex.trim()
  if (!/^([0-9a-fA-F]{32}|[0-9a-fA-F]{64})$/.test(h)) throw new Error('MQTT_AES_KEY debe tener 32 caracteres hexadecimales (AES-128: openssl rand -hex 16) o 64 (AES-256: openssl rand -hex 32)')
  return Buffer.from(h, 'hex')
}

/** Detecta el formato por su prefijo (un token real solo tiene A-Z a-z 0-9 _ -: nunca lleva «:»). */
export function detectarModo(texto: string): Modo {
  if (texto.startsWith(PREFIJO_AES)) return 'aes'
  if (texto.startsWith(PREFIJO_RSA)) return 'rsa'
  if (texto.startsWith(PREFIJO_B64)) return 'b64'
  return 'claro'
}

// ------------------------------------------------------------------ AES-GCM (núcleo común)
function sellar(prefijo: string, texto: string, tema: string, clave: Buffer, nonce: Buffer, delante: Buffer = Buffer.alloc(0)): string {
  if (nonce.length !== NONCE) throw new Error('el nonce debe tener 12 bytes')
  const c = createCipheriv(algoritmo(clave), clave, nonce)
  c.setAAD(Buffer.from(tema, 'utf8'))
  const ct = Buffer.concat([c.update(texto, 'utf8'), c.final()])
  return prefijo + Buffer.concat([delante, nonce, ct, c.getAuthTag()]).toString('base64')
}

/** `raw` = nonce ‖ cifrado ‖ etiqueta. null si no autentica. */
function abrir(raw: Buffer, tema: string, clave: Buffer): string | null {
  if (raw.length < NONCE + TAG) return null
  try {
    const d = createDecipheriv(algoritmo(clave), clave, raw.subarray(0, NONCE))
    d.setAAD(Buffer.from(tema, 'utf8'))
    d.setAuthTag(raw.subarray(raw.length - TAG))
    return Buffer.concat([d.update(raw.subarray(NONCE, raw.length - TAG)), d.final()]).toString('utf8')
  } catch {
    return null
  }
}

export function cifrarAes(texto: string, tema: string, clave: Buffer, nonce: Buffer = randomBytes(NONCE)): string {
  return sellar(PREFIJO_AES, texto, tema, clave, nonce)
}

/** null = no se pudo descifrar (formato roto, mensaje alterado, clave o tema distintos). */
export function descifrarAes(payload: string, tema: string, clave: Buffer): string | null {
  if (!payload.startsWith(PREFIJO_AES)) return null
  return abrir(Buffer.from(payload.slice(PREFIJO_AES.length).trim(), 'base64'), tema, clave)
}

// ------------------------------------------------------------------ RSA (clave pública / privada) + AES-GCM
const oaep = (key: KeyObject) => ({ key, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' as const })

/** Bytes del módulo RSA (256 para RSA-2048). */
export function bytesRsa(k: KeyObject): number {
  const bits = k.asymmetricKeyDetails?.modulusLength
  if (k.asymmetricKeyType !== 'rsa' || !bits) throw new Error('la clave no es RSA')
  return bits / 8
}

/**
 * Lado del NODO (lo usa el simulador de pruebas): cifra con la clave PÚBLICA de la Pi.
 * Devuelve el payload y la clave de sesión K (con ella se lee la respuesta de la pasarela).
 */
export function cifrarRsa(texto: string, tema: string, publica: KeyObject | string, sesion: Buffer = randomBytes(SESION_BYTES), nonce: Buffer = randomBytes(NONCE)): { payload: string; sesion: Buffer } {
  const pub = typeof publica === 'string' ? createPublicKey(publica) : publica
  const envuelta = publicEncrypt(oaep(pub), sesion)
  return { payload: sellar(PREFIJO_RSA, texto, tema, sesion, nonce, envuelta), sesion }
}

/** Lado de la PASARELA: descifra K con la clave PRIVADA y abre el mensaje. null si algo no coincide. */
export function descifrarRsa(payload: string, tema: string, privada: KeyObject): { texto: string; sesion: Buffer } | null {
  if (!payload.startsWith(PREFIJO_RSA)) return null
  const raw = Buffer.from(payload.slice(PREFIJO_RSA.length).trim(), 'base64')
  let n: number
  try { n = bytesRsa(privada) } catch { return null }
  if (raw.length < n + NONCE + TAG) return null
  let sesion: Buffer
  try {
    sesion = privateDecrypt(oaep(privada), raw.subarray(0, n))
  } catch {
    return null // clave envuelta alterada o cifrada para otra clave pública
  }
  if (!SESIONES_VALIDAS.includes(sesion.length)) return null
  const texto = abrir(raw.subarray(n), tema, sesion)
  return texto === null ? null : { texto, sesion }
}

export type Decodificado =
  | { ok: true; modo: Modo; texto: string; /** solo modo rsa: la clave de sesión con que hay que cifrar la respuesta */ sesion?: Buffer }
  | { ok: false; motivo: 'cifrado_requerido' | 'sin_clave' | 'descifrado_fallido' | 'b64_invalido' }

/**
 * Convierte el payload recibido en el texto del protocolo. `tema` es el tema donde llegó (AAD del AES).
 * Política «permitir»: los cuatro formatos · «exigir»: solo aes o rsa · «exigir-rsa»: solo rsa.
 */
export function decodificar(payload: Buffer | string, tema: string, clave: Buffer | null, politica: Politica, rsaPrivada: KeyObject | null = null): Decodificado {
  const crudo = typeof payload === 'string' ? payload : payload.toString('utf8')
  const modo = detectarModo(crudo)
  if (politica === 'exigir' && modo !== 'aes' && modo !== 'rsa') return { ok: false, motivo: 'cifrado_requerido' }
  if (politica === 'exigir-rsa' && modo !== 'rsa') return { ok: false, motivo: 'cifrado_requerido' }
  if (modo === 'claro') return { ok: true, modo, texto: crudo }
  if (modo === 'b64') {
    const b = crudo.slice(PREFIJO_B64.length).trim()
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(b) || b.length === 0) return { ok: false, motivo: 'b64_invalido' }
    return { ok: true, modo, texto: Buffer.from(b, 'base64').toString('utf8') }
  }
  if (modo === 'rsa') {
    if (!rsaPrivada) return { ok: false, motivo: 'sin_clave' }
    const r = descifrarRsa(crudo, tema, rsaPrivada)
    return r === null ? { ok: false, motivo: 'descifrado_fallido' } : { ok: true, modo, texto: r.texto, sesion: r.sesion }
  }
  if (!clave) return { ok: false, motivo: 'sin_clave' }
  const texto = descifrarAes(crudo, tema, clave)
  return texto === null ? { ok: false, motivo: 'descifrado_fallido' } : { ok: true, modo, texto }
}

/**
 * Codifica el texto de respuesta en el mismo formato en que llegó la solicitud.
 * En modo rsa se cifra con la clave de sesión K de ESA solicitud (`sesion`): payload «rsa1:» + base64(nonce ‖ cifrado ‖ etiqueta).
 */
export function codificar(texto: string, tema: string, modo: Modo, clave: Buffer | null, sesion: Buffer | null = null): string {
  if (modo === 'claro') return texto
  if (modo === 'b64') return PREFIJO_B64 + Buffer.from(texto, 'utf8').toString('base64')
  if (modo === 'rsa') {
    if (!sesion) throw new Error('sin clave de sesión para cifrar la respuesta')
    return sellar(PREFIJO_RSA, texto, tema, sesion, randomBytes(NONCE))
  }
  if (!clave) throw new Error('sin clave AES para cifrar la respuesta')
  return cifrarAes(texto, tema, clave)
}

/**
 * Lado del NODO: abre una RESPUESTA (tema «…/rx») en cualquier formato. Para «rsa1:» hace falta la clave de sesión K que el
 * nodo usó al enviar esa petición.
 */
export function abrirRespuesta(payload: Buffer | string, tema: string, clave: Buffer | null, sesion: Buffer | null): Decodificado {
  const crudo = typeof payload === 'string' ? payload : payload.toString('utf8')
  if (detectarModo(crudo) !== 'rsa') return decodificar(crudo, tema, clave, 'permitir')
  if (!sesion) return { ok: false, motivo: 'sin_clave' }
  const texto = abrir(Buffer.from(crudo.slice(PREFIJO_RSA.length).trim(), 'base64'), tema, sesion)
  return texto === null ? { ok: false, motivo: 'descifrado_fallido' } : { ok: true, modo: 'rsa', texto }
}
