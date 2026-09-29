/**
 * Utilidades comunes de los scripts (se ejecutan desde la carpeta dashboard/ con `npm run …`).
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { connect, parseSslMode } from '../../src/lib/db/config'
import type { Db } from '../../src/lib/db/types'

export const DASHBOARD_DIR = process.cwd()
export const REPO_DIR = path.resolve(DASHBOARD_DIR, '..')

/** Carga archivos .env sin pisar variables ya definidas (Node ≥ 20.12). */
export function loadEnvFiles(...files: string[]): void {
  for (const f of files) {
    const p = path.resolve(DASHBOARD_DIR, f)
    if (fs.existsSync(p)) process.loadEnvFile(p)
  }
}

export function requireEnv(name: string): string {
  const v = process.env[name]
  if (!v) throw new Error(`Falta la variable ${name}. Ejecuta «npm run setup» o revisa .env.local / .env.admin.local`)
  return v
}

function baseCreds() {
  return {
    host: requireEnv('DATABASE_HOST'),
    port: Number(process.env.DATABASE_PORT ?? 5432),
    database: process.env.DATABASE_NAME ?? 'postgres',
  }
}

/** Conexión con el rol administrador (postgres): solo para migraciones y seed. */
export function adminDb(max = 3): Db {
  loadEnvFiles('.env.local', '.env.admin.local')
  return connect(
    { ...baseCreds(), user: requireEnv('DATABASE_ADMIN_USER'), password: requireEnv('DATABASE_ADMIN_PASSWORD') },
    { max, sslMode: parseSslMode(process.env.DATABASE_SSL_MODE), applicationName: 'invernadero-iot-admin' },
  )
}

/** Conexión con el rol de la aplicación (iot_app), igual que la usa el dashboard. */
export function appDb(max = 3): Db {
  loadEnvFiles('.env.local')
  return connect(
    { ...baseCreds(), user: requireEnv('DATABASE_USER'), password: requireEnv('DATABASE_PASSWORD') },
    { max, sslMode: parseSslMode(process.env.DATABASE_SSL_MODE), applicationName: 'invernadero-iot-script' },
  )
}

export function randomSecret(bytes = 32): string {
  return crypto.randomBytes(bytes).toString('base64url')
}

/** Literal SQL seguro para sentencias DDL que no admiten parámetros (p. ej. ALTER ROLE … PASSWORD). */
export function sqlLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}
