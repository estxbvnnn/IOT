import { z } from 'zod'

const ROLES = ['owner', 'admin', 'agronomist', 'operator', 'technician'] as const

const schema = z.object({
  DATABASE_HOST: z.string().min(1, 'falta DATABASE_HOST'),
  DATABASE_PORT: z.coerce.number().int().positive().default(5432),
  DATABASE_NAME: z.string().min(1).default('postgres'),
  DATABASE_USER: z.string().min(1, 'falta DATABASE_USER'),
  DATABASE_PASSWORD: z.string().min(1, 'falta DATABASE_PASSWORD'),
  DATABASE_SSL_MODE: z.enum(['verify', 'no-verify', 'disable']).default('verify'),
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(30).default(6),
  APP_SECRET: z.string().min(32, 'APP_SECRET debe tener al menos 32 caracteres'),
  MFA_REQUIRED_ROLES: z.string().default(''),
  FORCE_HTTPS: z.enum(['true', 'false']).default('false'),
})

export interface AppEnv {
  database: { host: string; port: number; name: string; user: string; password: string; sslMode: 'verify' | 'no-verify' | 'disable'; poolMax: number }
  appSecret: string
  mfaRequiredRoles: ReadonlySet<string>
  forceHttps: boolean
}

let cached: AppEnv | null = null

/** Valida y devuelve la configuración. Falla con un mensaje claro si falta algo. */
export function getEnv(source: NodeJS.ProcessEnv = process.env): AppEnv {
  if (cached && source === process.env) return cached
  const parsed = schema.safeParse(source)
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `  - ${i.path.join('.') || 'env'}: ${i.message}`).join('\n')
    throw new Error(`Configuración de entorno inválida (revisa .env.local, ver .env.example):\n${problems}`)
  }
  const e = parsed.data
  const roles = new Set(
    e.MFA_REQUIRED_ROLES.split(',').map((r) => r.trim()).filter(Boolean),
  )
  for (const r of roles) {
    if (!(ROLES as readonly string[]).includes(r)) throw new Error(`MFA_REQUIRED_ROLES contiene un rol desconocido: «${r}»`)
  }
  const env: AppEnv = {
    database: {
      host: e.DATABASE_HOST, port: e.DATABASE_PORT, name: e.DATABASE_NAME, user: e.DATABASE_USER,
      password: e.DATABASE_PASSWORD, sslMode: e.DATABASE_SSL_MODE, poolMax: e.DATABASE_POOL_MAX,
    },
    appSecret: e.APP_SECRET,
    mfaRequiredRoles: roles,
    forceHttps: e.FORCE_HTTPS === 'true',
  }
  if (source === process.env) cached = env
  return env
}
