/**
 * PUENTE SERIE: une el «Concentrador Principal» (un ESP conectado por USB que oye la malla ESP-NOW) con la pasarela de la Pi.
 * Es el tramo «Concentrador ↔ Raspberry Pi» del diagrama del proyecto. Protocolo en scripts/lib/puente-core.ts.
 *
 *   npm run puente                       (busca solo el ESP; si hay varios, indique el puerto)
 *   npm run puente -- COM4               (Windows)      ·      npm run puente -- /dev/ttyUSB0   (Raspberry Pi)
 *
 * Variables:
 *   PUENTE_PUERTO     puerto serie (o el primer argumento)
 *   PUENTE_BAUDIOS    por defecto 115200 (el mismo del sketch)
 *   GATEWAY_URL       pasarela a la que se suben los mensajes (por defecto http://localhost:3100)
 *
 * Si el cable se desconecta, reintenta cada 3 s. No abre ningún mensaje: solo mueve texto cifrado entre el ESP y la pasarela.
 */
import { ReadlineParser, SerialPort } from 'serialport'
import { parseLinea, procesarRx } from './lib/puente-core'

const stamp = () => new Date().toISOString().replace('T', ' ').slice(0, 19)
const log = (m: string) => console.log(`[${stamp()}] ${m}`)

const GATEWAY = process.env.GATEWAY_URL ?? 'http://localhost:3100'
const BAUD = Number(process.env.PUENTE_BAUDIOS ?? 115200)
const VERBOSE = process.env.PUENTE_VERBOSE === '1'

/** Adaptadores USB-serie típicos de las NodeMCU: CH340 (1a86), CP210x (10c4), FTDI (0403). */
const VENDORS = new Set(['1a86', '10c4', '0403'])

async function elegirPuerto(): Promise<string | null> {
  const pedido = process.argv[2] ?? process.env.PUENTE_PUERTO
  if (pedido) return pedido
  const lista = await SerialPort.list()
  const candidatos = lista.filter((p) => p.vendorId && VENDORS.has(p.vendorId.toLowerCase()))
  if (candidatos.length === 1) return candidatos[0]!.path
  if (candidatos.length === 0) log('No encuentro ningún ESP por USB. Conéctelo, o indique el puerto: npm run puente -- COM4')
  else log(`Hay varios puertos posibles (${candidatos.map((c) => c.path).join(', ')}): indique cuál: npm run puente -- <puerto>`)
  return null
}

let cola: Promise<void> = Promise.resolve()   // los mensajes se atienden de a uno: el ESP no puede enviar dos respuestas a la vez

function conectar(path: string): Promise<void> {
  return new Promise((resolve) => {
    const port = new SerialPort({ path, baudRate: BAUD, autoOpen: false })
    const parser = port.pipe(new ReadlineParser({ delimiter: '\n' }))
    let abierto = false

    parser.on('data', (raw: string) => {
      const l = parseLinea(raw)
      if (l.kind === 'hola') { log(`Concentrador conectado: ${l.nombre} (${path})`); return }
      if (l.kind === 'log') { if (VERBOSE && l.texto.trim()) log(`ESP: ${l.texto}`); return }
      log(`<< nodo-${l.origen} seq ${l.seq} (${l.saltos} salto(s) por radio, lo oyó ${l.via}) → pasarela`)
      cola = cola.then(async () => {
        const r = await procesarRx(l, GATEWAY)
        if (r.tx === null) { log(`   sin respuesta para nodo-${l.origen} seq ${l.seq}: ${r.estado}`); return }
        await new Promise<void>((ok) => port.write(r.tx!, () => port.drain(() => ok())))
        log(`>> respuesta de la pasarela hacia nodo-${l.origen} seq ${l.seq} (por la malla)`)
      }).catch((e: Error) => log(`   error: ${e.message}`))
    })

    port.on('close', () => { if (abierto) log('Se perdió el puerto serie; reintento…'); resolve() })
    port.on('error', (e) => { log(`Puerto serie: ${e.message}`); resolve() })
    port.open((err) => {
      if (err) { log(`No pude abrir ${path}: ${err.message}`); resolve(); return }
      abierto = true
      log(`Puerto ${path} abierto a ${BAUD} baudios · pasarela ${GATEWAY}`)
    })
  })
}

async function main(): Promise<void> {
  for (;;) {
    const path = await elegirPuerto()
    if (path) await conectar(path)
    await new Promise((r) => setTimeout(r, 3000))
  }
}

main().catch((e: Error) => { console.error(`✗ ${e.message}`); process.exit(1) })
