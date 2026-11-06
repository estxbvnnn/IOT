/**
 * Decodifica un payload MQTT copiado de Wireshark (campo «Msg» del PUBLISH) para el paso «decodificar en el receptor».
 *
 *   npx tsx scripts/descifrar-trama.ts --tema invernadero/nodo-aa6490/tx "aes1:oaKj..."      # con la clave en MQTT_AES_KEY
 *   npx tsx scripts/descifrar-trama.ts --tema invernadero/nodo-aa6490/tx --clave <hex> "aes1:..."
 *   npx tsx scripts/descifrar-trama.ts "b64:VE9LRU4K..."                                      # Base64: no necesita clave
 *   npx tsx scripts/descifrar-trama.ts --tema invernadero/nodo-aa6490/tx --privada secrets/mqtt-rsa-private.pem "rsa1:..."   # clave pública/privada
 *   echo "aes1:..." | npx tsx scripts/descifrar-trama.ts --tema invernadero/nodo-aa6490/tx     # también por la entrada estándar
 *
 * --tema es el tema MQTT donde viajó el mensaje (es el AAD del AES: con otro tema el descifrado falla a propósito).
 * El token del nodo que viene en la primera línea se enmascara al imprimir; --mostrar-token lo deja visible.
 */
import fs from 'node:fs'
import { createPrivateKey } from 'node:crypto'
import { claveDesdeHex, decodificar } from './lib/mqtt-crypto'

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name)
  return i >= 0 ? process.argv[i + 1] : undefined
}

const flagsConValor = new Set(['--tema', '--clave', '--privada'])
const posicional = process.argv.slice(2).filter((a, i, all) => !a.startsWith('--') && !flagsConValor.has(all[i - 1] ?? ''))
const crudo = (posicional[0] ?? (process.stdin.isTTY ? '' : fs.readFileSync(0, 'utf8'))).trim()
if (!crudo) {
  console.error('Uso: npx tsx scripts/descifrar-trama.ts [--tema invernadero/<id>/tx] [--clave <hex>] [--privada <pem>] "<payload>"')
  process.exit(2)
}

const tema = arg('--tema') ?? 'invernadero/nodo-desconocido/tx'
const claveHex = arg('--clave') ?? process.env.MQTT_AES_KEY
let clave: Buffer | null = null
try {
  clave = claveHex ? claveDesdeHex(claveHex) : null
} catch (e) {
  console.error((e as Error).message)
  process.exit(2)
}

let privada = null
const archivoPrivada = arg('--privada') ?? process.env.MQTT_RSA_PRIVATE_KEY_FILE
if (archivoPrivada && fs.existsSync(archivoPrivada)) privada = createPrivateKey(fs.readFileSync(archivoPrivada))

const r = decodificar(crudo, tema, clave, 'permitir', privada)
if (!r.ok) {
  const msg: Record<typeof r.motivo, string> = {
    cifrado_requerido: 'cifrado requerido',
    sin_clave: 'el mensaje es AES (necesita --clave o MQTT_AES_KEY) o RSA (necesita --privada con la clave privada de la Pi)',
    descifrado_fallido: 'NO se pudo descifrar: clave incorrecta, tema distinto (--tema) o el mensaje fue alterado',
    b64_invalido: 'Base64 inválido',
  }
  console.error(`✗ ${msg[r.motivo]}`)
  process.exit(1)
}

const etiqueta = { claro: 'texto claro (no estaba cifrado)', b64: 'Base64 (solo codificado: se leyó sin clave)', aes: `AES-${(clave?.length ?? 0) * 8}-GCM (descifrado y autenticado)`, rsa: 'RSA + AES-128-GCM (descifrado con la clave PRIVADA y autenticado)' }[r.modo]
let texto = r.texto
if (!process.argv.includes('--mostrar-token') && r.modo !== 'claro') {
  // Primera línea = token del nodo (tx). La respuesta rx empieza con «200 0»: no se toca.
  const nl = texto.indexOf('\n')
  if (nl > 0 && !/^\d{3} \d+$/.test(texto.slice(0, nl))) texto = `${texto.slice(0, 6)}…[token oculto]${texto.slice(nl)}`
}
console.log(`✓ ${etiqueta}\n${texto}`)
