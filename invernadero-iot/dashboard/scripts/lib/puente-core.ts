/**
 * Núcleo del PUENTE SERIE del concentrador: la Pi (o el PC que la simula) habla por USB con el «Concentrador Principal», un ESP
 * que oye la malla ESP-NOW. Es el tramo «Concentrador ↔ Raspberry Pi» del diagrama.
 *
 *   malla ESP-NOW ──► concentrador (ESP) ──USB──►  @RX …  ──► este puente ──POST /relay/<nodo>──► pasarela (gateway)
 *   malla ESP-NOW ◄── concentrador (ESP) ◄──USB──  @TX …  ◄── este puente ◄──respuesta cifrada──── pasarela
 *
 * Protocolo (una línea de texto por mensaje, 115200 baudios; todo lo que NO empiece con «@» es el registro de depuración del ESP):
 *   ESP → Pi   @HOLA <nombre-del-concentrador>
 *              @RX <origen-hex> <seq> <intento> <saltos> <via> <mensaje rsa1:…>     un mensaje completo ya reensamblado
 *   Pi  → ESP  @TX <origen-hex> <seq> <intento> <respuesta rsa1:…>                  se difunde por la malla hacia el origen
 * El puente NUNCA abre el mensaje: es el texto cifrado que solo la pasarela puede leer.
 */

export interface RxLinea {
  kind: 'rx'
  origen: string
  seq: number
  intento: number
  saltos: number
  via: string
  mensaje: string
}
export type Linea = RxLinea | { kind: 'hola'; nombre: string } | { kind: 'log'; texto: string }

const HEX = /^[0-9a-f]{6,8}$/
const MENSAJE = /^rsa1:[A-Za-z0-9+/]+={0,2}$/
const VIA = /^[A-Za-z0-9_-]{1,40}$/

/** Interpreta una línea del ESP. Una línea «@RX» rota (se corrompió por el cable) se descarta como registro. */
export function parseLinea(raw: string): Linea {
  const line = raw.replace(/[\r\n]+$/, '')
  if (!line.startsWith('@')) return { kind: 'log', texto: line }
  const p = line.split(' ')
  if (p[0] === '@HOLA' && p[1]) return { kind: 'hola', nombre: p[1].slice(0, 40) }
  if (p[0] === '@RX' && p.length === 7) {
    const [, origen, seq, intento, saltos, via, mensaje] = p as [string, string, string, string, string, string, string]
    const nseq = Number(seq), nint = Number(intento), nsal = Number(saltos)
    if (HEX.test(origen) && Number.isInteger(nseq) && nseq > 0 && Number.isInteger(nint) && nint >= 0 && nint <= 15 &&
        Number.isInteger(nsal) && nsal >= 1 && nsal <= 15 && VIA.test(via) && MENSAJE.test(mensaje)) {
      return { kind: 'rx', origen, seq: nseq, intento: nint, saltos: nsal, via, mensaje }
    }
  }
  return { kind: 'log', texto: line }
}

export interface RxResultado {
  /** Línea «@TX …» lista para escribir al ESP (con salto de línea), o null si la pasarela no dio respuesta utilizable. */
  tx: string | null
  estado: string
}

/** Sube el mensaje a la pasarela (`POST /relay/nodo-<origen>`, igual que lo haría un nodo con WiFi) y arma la línea de respuesta. */
export async function procesarRx(rx: RxLinea, gatewayUrl: string, doFetch: typeof fetch = fetch): Promise<RxResultado> {
  const base = gatewayUrl.replace(/\/+$/, '')
  let res: Response
  try {
    res = await doFetch(`${base}/relay/nodo-${rx.origen}`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain', 'x-via': rx.via, 'x-saltos': String(rx.saltos) },
      body: rx.mensaje,
      signal: AbortSignal.timeout(8000),
    })
  } catch (e) {
    return { tx: null, estado: `pasarela inalcanzable (${(e as Error).message})` }
  }
  const texto = (await res.text()).trim()
  if (res.status !== 200) return { tx: null, estado: `la pasarela respondió HTTP ${res.status}` }
  if (!MENSAJE.test(texto)) return { tx: null, estado: 'la pasarela respondió algo que no es una respuesta cifrada' }
  return { tx: `@TX ${rx.origen} ${rx.seq} ${rx.intento} ${texto}\n`, estado: 'ok' }
}
