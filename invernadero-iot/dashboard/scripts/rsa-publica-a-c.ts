/**
 * Convierte la clave PÚBLICA RSA de la Pi (PEM) en los arreglos de C que usa el sketch de la NodeMCU para cifrar.
 *
 *   npx tsx scripts/rsa-publica-a-c.ts ../secrets/mqtt-rsa-public.pem                       # imprime el bloque
 *   npx tsx scripts/rsa-publica-a-c.ts ../secrets/mqtt-rsa-public.pem --sketch ../firmware/nodo_simulado/nodo_simulado.ino
 *                                                                                              # y lo pega entre los marcadores
 *   npx tsx scripts/rsa-publica-a-c.ts clave-del-companero.pem --sketch ../firmware/nododefinitivo/nododefinitivo.ino --prefijo SOCIO
 *                                                                                              # la clave del COMPAÑERO (arreglos RSA_SOCIO_N/E, marcadores «// RSA_SOCIO_PUBLICA_…»)
 *
 * El sketch debe tener las líneas «// RSA_PUBLICA_INICIO» y «// RSA_PUBLICA_FIN»: lo que haya entre ellas se reemplaza.
 * Acepta también la clave privada (solo se usa para sacar la pública; la privada NUNCA se escribe en el sketch).
 * Imprime la HUELLA (SHA-256 de la clave pública): debe coincidir con la que muestra la pasarela al arrancar.
 */
import fs from 'node:fs'
import { createHash, createPrivateKey, createPublicKey } from 'node:crypto'

const arg = (n: string): string | undefined => {
  const i = process.argv.indexOf(n)
  return i >= 0 ? process.argv[i + 1] : undefined
}
const archivo = process.argv.slice(2).find((a, i, all) => !a.startsWith('--') && all[i - 1] !== '--sketch' && all[i - 1] !== '--prefijo')
if (!archivo) {
  console.error('Uso: npx tsx scripts/rsa-publica-a-c.ts <clave.pem> [--sketch <archivo.ino>] [--prefijo SOCIO]')
  process.exit(2)
}

const pem = fs.readFileSync(archivo)
const publica = pem.includes(Buffer.from('PRIVATE KEY')) ? createPublicKey(createPrivateKey(pem)) : createPublicKey(pem)
if (publica.asymmetricKeyType !== 'rsa') throw new Error('la clave no es RSA')
const jwk = publica.export({ format: 'jwk' })
const n = Buffer.from(jwk.n!, 'base64url')
const e = Buffer.from(jwk.e!, 'base64url')
const bits = (publica.asymmetricKeyDetails?.modulusLength ?? 0)
if (bits < 2048) throw new Error(`la clave RSA debe ser de 2048 bits o más (esta tiene ${bits})`)

const filas = (b: Buffer): string => {
  const out: string[] = []
  for (let i = 0; i < b.length; i += 12) out.push('  ' + [...b.subarray(i, i + 12)].map((x) => '0x' + x.toString(16).padStart(2, '0')).join(', '))
  return out.join(',\n')
}
const huella = createHash('sha256').update(publica.export({ type: 'spki', format: 'der' })).digest('hex')

// Con --prefijo SOCIO los nombres pasan a RSA_SOCIO_N / RSA_SOCIO_E y los marcadores a «// RSA_SOCIO_PUBLICA_INICIO / FIN».
const prefijo = arg('--prefijo')
if (prefijo !== undefined && !/^[A-Z][A-Z0-9_]*$/.test(prefijo)) throw new Error('--prefijo debe ir en mayúsculas (A-Z, 0-9, _), p. ej. SOCIO')
const nombre = prefijo ? `RSA_${prefijo}` : 'RSA'
const MARCA_INI = `// ${nombre}_PUBLICA_INICIO`
const MARCA_FIN = `// ${nombre}_PUBLICA_FIN`

const bloque = `${MARCA_INI}  (generado por scripts/rsa-publica-a-c.ts · huella SHA-256 de la clave pública: ${huella.slice(0, 16)})
static const uint8_t ${nombre}_N[${n.length}] = {
${filas(n)}
};
static const uint8_t ${nombre}_E[${e.length}] = { ${[...e].map((x) => '0x' + x.toString(16).padStart(2, '0')).join(', ')} };
${MARCA_FIN}`

const sketch = arg('--sketch')
if (!sketch) {
  console.log(bloque)
} else {
  const s = fs.readFileSync(sketch, 'utf8')
  const crlf = s.includes('\r\n')
  const t = s.replace(/\r\n/g, '\n')
  const a = t.indexOf(MARCA_INI)
  const b = t.indexOf(MARCA_FIN)
  if (a < 0 || b < a) throw new Error(`el sketch no tiene los marcadores «${MARCA_INI}» y «${MARCA_FIN}»`)
  const nuevo = t.slice(0, a) + bloque + t.slice(b + MARCA_FIN.length)
  fs.writeFileSync(sketch, crlf ? nuevo.replace(/\n/g, '\r\n') : nuevo)
  console.log(`✓ clave pública RSA-${bits} (${n.length} bytes) escrita en ${sketch}`)
}
console.log(`  huella de la clave pública (SHA-256): ${huella}`)
