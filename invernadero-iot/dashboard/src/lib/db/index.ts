import 'server-only'
import { getEnv } from '../env'
import { connect } from './config'
import type { Db } from './types'

/**
 * Pool único por proceso. En desarrollo Next recarga módulos en caliente y cada recarga crearía
 * un pool nuevo (agotando las conexiones de Supabase), por eso se guarda en `globalThis`.
 */
const g = globalThis as unknown as { __invernaderoDb?: Db }

export function getDb(): Db {
  if (!g.__invernaderoDb) {
    const { database: d } = getEnv()
    g.__invernaderoDb = connect(
      { host: d.host, port: d.port, database: d.name, user: d.user, password: d.password },
      { sslMode: d.sslMode, max: d.poolMax, applicationName: 'invernadero-iot-dashboard' },
    )
  }
  return g.__invernaderoDb
}

export type { Db } from './types'
export { inTransaction } from './types'
