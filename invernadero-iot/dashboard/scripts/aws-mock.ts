/**
 * «AWS de mentira» para probar el envío de la Pi sin tener cuenta en AWS. Hace lo que haría la nube real:
 * recibe el POST, abre el lote con SU clave privada y guarda las lecturas (aquí en un archivo .jsonl).
 *
 *   npm run aws:mock              (puerto 4010; crea secrets/aws-mock-{private,public}.pem si no existen)
 *
 * Después, en el .env de la Pi:  AWS_UPLINK_URL=http://IP_DE_ESTE_PC:4010/ingest   AWS_PUBLIC_KEY_FILE=/run/secrets/aws-mock-public.pem
 * Las claves viven en ../secrets (fuera de git). NO es un servidor de producción.
 */
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { createPrivateKey, generateKeyPairSync } from 'node:crypto'
import { descifrarRsa } from './lib/mqtt-crypto'
import { UPLINK_AAD } from './lib/uplink-core'

const PORT = Number(process.env.AWS_MOCK_PORT ?? 4010)
const SECRETS = path.resolve(process.cwd(), '..', 'secrets')
const PRIV = path.join(SECRETS, 'aws-mock-private.pem')
const PUB = path.join(SECRETS, 'aws-mock-public.pem')
const OUT = path.join(SECRETS, 'aws-mock-recibido.jsonl')
const API_KEY = process.env.AWS_MOCK_API_KEY ?? ''

fs.mkdirSync(SECRETS, { recursive: true })
if (!fs.existsSync(PRIV) || !fs.existsSync(PUB)) {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  fs.writeFileSync(PRIV, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 })
  fs.writeFileSync(PUB, publicKey.export({ type: 'spki', format: 'pem' }))
  console.log(`Claves nuevas en ${SECRETS} (aws-mock-private.pem / aws-mock-public.pem)`)
}
const priv = createPrivateKey(fs.readFileSync(PRIV))
let total = 0

http.createServer((req, res) => {
  const chunks: Buffer[] = []
  req.on('data', (c: Buffer) => chunks.push(c))
  req.on('end', () => {
    const reply = (code: number, msg: string): void => { res.writeHead(code, { 'content-type': 'text/plain' }); res.end(msg) }
    if (req.method !== 'POST' || req.url !== '/ingest') return reply(404, 'no existe')
    if (API_KEY && req.headers['x-api-key'] !== API_KEY) return reply(403, 'api key')
    const body = Buffer.concat(chunks).toString('utf8')
    let json = body
    let cifrado = false
    if (body.startsWith('rsa1:')) {
      const abierto = descifrarRsa(body, UPLINK_AAD, priv)
      if (!abierto) { console.log('✗ lote rechazado: no se pudo descifrar (clave distinta o dato alterado)'); return reply(400, 'no descifra') }
      json = abierto.texto
      cifrado = true
    }
    try {
      const lote = JSON.parse(json) as { origen: string; lecturas: unknown[] }
      for (const l of lote.lecturas) fs.appendFileSync(OUT, JSON.stringify(l) + '\n')
      total += lote.lecturas.length
      console.log(`✓ ${lote.lecturas.length} lecturas de «${lote.origen}» (${cifrado ? 'cifrado AES-256 + RSA' : 'EN CLARO'}) · total ${total}`)
      reply(200, 'ok')
    } catch {
      reply(400, 'json')
    }
  })
}).listen(PORT, '0.0.0.0', () => console.log(`AWS de prueba escuchando en :${PORT}/ingest · guarda en ${OUT}`))
