import postgres from 'postgres'
import { SUPABASE_CA } from './supabase-ca'
import type { Db } from './types'

export interface DbCredentials {
  host: string
  port: number
  database: string
  user: string
  password: string
}

/** verify = TLS con la CA de Supabase (por defecto) · no-verify = cifrado sin validar · disable = sin TLS (solo local). */
export type SslMode = 'verify' | 'no-verify' | 'disable'

export interface ConnectOptions {
  sslMode?: SslMode
  /** Máximo de conexiones del pool. Supabase (plan gratuito) tiene un tope bajo: mantenerlo pequeño. */
  max?: number
  applicationName?: string
  /**
   * Sentencias preparadas. Activas por defecto: tras el primer uso el servidor ya conoce los tipos de los
   * parámetros y postgres.js puede encadenar (pipeline) varias sentencias en una sola ida y vuelta.
   * Sin ellas cada consulta con parámetros cuesta DOS idas y vueltas (~400 ms hasta Supabase en Oregón).
   * Deben desactivarse con el pooler en modo TRANSACCIÓN (puerto 6543), que no las soporta.
   */
  prepare?: boolean
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1'])

/**
 * Construye las opciones de postgres.js.
 *
 * Notas:
 *  - Se usan campos separados (host, user, password…) y NO una URL `postgresql://…`: si la clave
 *    contiene caracteres como «@», «#» o «/» la URL se rompe salvo que se codifique.
 *  - Sentencias preparadas activas salvo con el pooler en modo transacción (6543): ver ConnectOptions.prepare.
 *  - int8 y numeric se devuelven como `number` (los ids y medidas de este sistema caben de sobra).
 */
export function buildOptions(creds: DbCredentials, opts: ConnectOptions = {}): postgres.Options<{}> {
  const mode: SslMode = opts.sslMode ?? (LOCAL_HOSTS.has(creds.host) ? 'disable' : 'verify')
  const ssl =
    mode === 'disable' ? false
    : mode === 'no-verify' ? ({ rejectUnauthorized: false } as const)
    : ({ ca: SUPABASE_CA, rejectUnauthorized: true } as const)

  return {
    host: creds.host,
    port: creds.port,
    database: creds.database,
    username: creds.user,
    password: creds.password,
    ssl,
    max: opts.max ?? 5,
    idle_timeout: 900, // conexiones tibias: con sentencias preparadas la primera ejecución de cada consulta es lenta
    max_lifetime: 60 * 30,
    connect_timeout: 15,
    prepare: opts.prepare ?? creds.port !== 6543,
    onnotice: () => {},
    connection: { application_name: opts.applicationName ?? 'invernadero-iot' },
    types: {
      bigint: { to: 20, from: [20], parse: (x: string) => Number(x), serialize: (x: number) => String(x) },
      numeric: { to: 1700, from: [1700], parse: (x: string) => Number(x), serialize: (x: number) => String(x) },
    },
  } as postgres.Options<{}>
}

/** Crea el pool (la conexión real se abre en la primera consulta). */
export function connect(creds: DbCredentials, opts: ConnectOptions = {}): Db {
  return postgres(buildOptions(creds, opts)) as unknown as Db
}

export function parseSslMode(value: string | undefined): SslMode | undefined {
  return value === 'verify' || value === 'no-verify' || value === 'disable' ? value : undefined
}
