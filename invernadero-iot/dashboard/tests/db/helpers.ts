import { afterAll } from 'vitest'
import { appDb } from '../../scripts/lib/scriptenv'
import type { Db } from '../../src/lib/db/types'
import type { Actor, Role } from '../../src/lib/rbac'
import { hashPassword } from '../../src/lib/auth/password'
import { generateToken, hashToken } from '../../src/lib/auth/tokens'
import type { AuthConfig } from '../../src/lib/auth/service'
import { handleIngest, type IngestResult, type RouteInfo } from '../../src/lib/services/ingest'

/** Conexión con el rol de la aplicación (iot_app), igual que el dashboard. */
export const app: Db = appDb(4)
afterAll(async () => { await app.end({ timeout: 5 }) })

export const AUTH_CFG: AuthConfig = {
  appSecret: 'clave-maestra-de-pruebas-con-mas-de-32-caracteres',
  mfaRequiredRoles: new Set<string>(),
}

const ROLLBACK = Symbol('rollback')

/**
 * Ejecuta `fn` dentro de una transacción que SIEMPRE se revierte: la prueba puede insertar, actualizar
 * y crear usuarios, nodos o alertas sin dejar rastro en la base compartida.
 */
export async function inRollback<T>(fn: (tx: Db) => Promise<T>): Promise<T> {
  let out: T | undefined
  try {
    await app.begin(async (tx) => {
      out = await fn(tx as unknown as Db)
      throw ROLLBACK
    })
  } catch (e) {
    if (e !== ROLLBACK) throw e
  }
  return out as T
}

export interface TestUser { id: string; email: string; password: string; actor: Actor }

let seq = 0

/** Crea (dentro de la transacción) un usuario con contraseña conocida. */
export async function makeUser(tx: Db, role: Role, opts: { greenhouseIds?: number[]; password?: string; name?: string } = {}): Promise<TestUser> {
  const password = opts.password ?? `Prueba-${role}-Clave-2026`
  const email = `test-${role}-${Date.now()}-${++seq}@invernadero.local`
  const name = opts.name ?? `Usuario ${role} de prueba`
  const [row] = await tx<{ id: string }[]>`
    insert into iot.app_users (email, name, role, password_hash)
    values (${email}, ${name}, ${role}, ${await hashPassword(password)}) returning id`
  for (const gid of opts.greenhouseIds ?? []) {
    await tx`insert into iot.user_greenhouses (user_id, greenhouse_id) values (${row!.id}, ${gid})`
  }
  return { id: row!.id, email, password, actor: { id: row!.id, email, name, role, greenhouseIds: opts.greenhouseIds ?? [] } }
}

/** Asigna un token conocido a un nodo existente (dentro de la transacción) y lo devuelve. */
export async function tokenFor(tx: Db, greenhouseId: number | 'mast'): Promise<string> {
  const token = generateToken()
  const rows = greenhouseId === 'mast'
    ? await tx`update iot.nodes set token_hash = ${hashToken(token)}, enabled = true where kind = 'mast' returning id`
    : await tx`update iot.nodes set token_hash = ${hashToken(token)}, enabled = true where greenhouse_id = ${greenhouseId} returning id`
  if (rows.length === 0) throw new Error('El nodo no existe: ¿ejecutaste npm run db:seed?')
  return token
}

/** Instante base de las pruebas: en el FUTURO respecto de lo sembrado, así los datos del seed no interfieren. */
export const T0 = new Date(Math.ceil((Date.now() + 48 * 3600_000) / 60_000) * 60_000)

let boot = 1000
/** Trama válida por defecto; `over` la modifica. Cada llamada a `frameBuilder` usa un `boot` nuevo. */
export function frameBuilder() {
  const bootId = ++boot
  let s = 0
  return (over: Record<string, unknown> = {}) => ({
    v: 1, fw: 'test-1.0', boot: bootId, seq: ++s, up: s * 10, temp: 24.3, hum_aire: 61.2, suelo_raw: 512, bomba: 0,
    est: 'idle', rssi: -61, ...over,
  })
}

export function send(tx: Db, token: string | null, body: unknown, now: Date, extra: { raw?: string; skipSweep?: boolean; route?: RouteInfo } = {}): Promise<IngestResult> {
  return handleIngest(tx, {
    authorization: token ? `Bearer ${token}` : null,
    rawBody: extra.raw ?? JSON.stringify(body),
    ip: '203.0.113.9',
    now,
    skipSweep: extra.skipSweep ?? true,
    route: extra.route,
  })
}

export const plus = (d: Date, seconds: number) => new Date(d.getTime() + seconds * 1000)
