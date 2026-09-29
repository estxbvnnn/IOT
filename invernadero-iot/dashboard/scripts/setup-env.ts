/**
 * Prepara los archivos de entorno a partir del env.txt que entrega Supabase.
 *
 *   npm run setup:env -- --from ../../env.txt   (o simplemente `npm run setup`, que además migra y siembra)
 *
 * Qué hace:
 *  1. Lee host / usuario / clave del env.txt (formato «Connect → Direct connection» de Supabase).
 *  2. La conexión directa (db.<ref>.supabase.co) solo tiene IPv6: descubre el pooler IPv4 del
 *     proyecto probando las regiones de Supabase (solo ejecuta «select 1»).
 *  3. Escribe .env.admin.local (credenciales de postgres, solo para scripts) y .env.local
 *     (rol de mínimo privilegio de la app + claves aleatorias). Nunca imprime secretos.
 */
import fs from 'node:fs'
import path from 'node:path'
import postgres from 'postgres'
import { DASHBOARD_DIR, randomSecret } from './lib/scriptenv'

const REGIONS = [
  'us-west-2', 'sa-east-1', 'us-east-1', 'us-east-2', 'us-west-1', 'ca-central-1',
  'eu-west-1', 'eu-west-2', 'eu-west-3', 'eu-central-1', 'eu-central-2', 'eu-north-1',
  'ap-south-1', 'ap-southeast-1', 'ap-southeast-2', 'ap-northeast-1', 'ap-northeast-2',
]

interface ParsedEnvTxt { ref: string; database: string; adminUser: string; password: string }

function parseEnvTxt(text: string): ParsedEnvTxt {
  const lines = text.split(/\r?\n/).map((l) => l.trim())
  const kv: Record<string, string> = {}
  for (const l of lines) {
    const m = /^(host|port|database|user)\s*=\s*(.+)$/i.exec(l)
    if (m) kv[m[1]!.toLowerCase()] = m[2]!.trim()
  }
  // La clave puede venir en la línea siguiente a «password:» o como «password=…».
  let password = ''
  const i = lines.findIndex((l) => /^password\s*[:=]?\s*$/i.test(l))
  if (i >= 0) password = lines[i + 1] ?? ''
  else {
    for (const l of lines) {
      const m = /^password\s*[:=]\s*(.+)$/i.exec(l)
      if (m) { password = m[1]!.trim(); break }
    }
  }
  const host = kv.host ?? ''
  const ref = /^db\.([a-z0-9]+)\.supabase\.co$/.exec(host)?.[1]
  if (!ref) throw new Error('No se reconoce el host (se esperaba db.<ref>.supabase.co) en el archivo indicado')
  if (!password) throw new Error('No se encontró la contraseña en el archivo indicado')
  if (/["\r\n]/.test(password)) throw new Error('La contraseña contiene comillas o saltos de línea: escríbela a mano en .env.admin.local')
  return { ref, database: kv.database ?? 'postgres', adminUser: kv.user ?? 'postgres', password }
}

async function tryRegion(host: string, p: ParsedEnvTxt): Promise<'ok' | 'wrong-region' | 'bad-password' | 'error'> {
  const sql = postgres({
    host, port: 5432, database: p.database, username: `${p.adminUser}.${p.ref}`, password: p.password,
    ssl: { rejectUnauthorized: false }, max: 1, connect_timeout: 8, idle_timeout: 2, onnotice: () => {},
  })
  try {
    await sql`select 1`
    return 'ok'
  } catch (e) {
    const msg = String((e as Error).message)
    if (/tenant or user not found/i.test(msg)) return 'wrong-region'
    if (/password authentication failed|28P01/i.test(msg) || (e as { code?: string }).code === '28P01') return 'bad-password'
    return 'error'
  } finally {
    await sql.end({ timeout: 2 }).catch(() => {})
  }
}

async function findPooler(p: ParsedEnvTxt): Promise<string> {
  const hosts = REGIONS.flatMap((r) => [`aws-0-${r}.pooler.supabase.com`, `aws-1-${r}.pooler.supabase.com`])
  const queue = [...hosts]
  let found: string | null = null
  let badPassword: string | null = null
  await Promise.all(
    Array.from({ length: 6 }, async () => {
      while (queue.length && !found && !badPassword) {
        const host = queue.shift()!
        const r = await tryRegion(host, p)
        if (r === 'ok') found = host
        else if (r === 'bad-password') badPassword = host
      }
    }),
  )
  if (badPassword) throw new Error(`El proyecto está en ${badPassword} pero la contraseña fue rechazada. Revisa la clave de postgres en Supabase.`)
  if (!found) throw new Error('No se encontró el pooler del proyecto en las regiones conocidas. Cópialo desde Supabase → Connect → Session pooler y escríbelo en DATABASE_HOST.')
  return found
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name)
  return i >= 0 ? process.argv[i + 1] : undefined
}

async function main(): Promise<void> {
  const adminFile = path.join(DASHBOARD_DIR, '.env.admin.local')
  const localFile = path.join(DASHBOARD_DIR, '.env.local')

  if (fs.existsSync(adminFile) && fs.existsSync(localFile)) {
    console.log('✓ .env.local y .env.admin.local ya existen: no se toca nada.')
    return
  }
  // Sin --from se busca el env.txt de Supabase junto al proyecto (carpeta del repositorio o la de arriba).
  const candidates = [arg('--from'), '../env.txt', '../../env.txt', 'env.txt'].filter((c): c is string => !!c).map((c) => path.resolve(DASHBOARD_DIR, c))
  const from = candidates.find((c) => fs.existsSync(c))
  if (!from) throw new Error('No encuentro el archivo de Supabase (env.txt). Indícalo: npm run setup:env -- --from <ruta/al/env.txt>')
  console.log(`Leyendo credenciales de: ${from}`)
  const parsed = parseEnvTxt(fs.readFileSync(from, 'utf8'))
  console.log(`Proyecto Supabase: ${parsed.ref}`)
  console.log('Buscando el pooler IPv4 del proyecto (solo «select 1»)…')
  const host = await findPooler(parsed)
  console.log(`✓ Pooler encontrado: ${host}`)

  if (!fs.existsSync(adminFile)) {
    fs.writeFileSync(
      adminFile,
      [
        '# Credenciales de ADMINISTRACIÓN (rol postgres). Solo las usan los scripts db:migrate y db:seed.',
        '# La aplicación web NO carga este archivo. No lo subas al repositorio.',
        `DATABASE_HOST=${host}`,
        'DATABASE_PORT=5432',
        `DATABASE_NAME=${parsed.database}`,
        `DATABASE_ADMIN_USER=${parsed.adminUser}.${parsed.ref}`,
        `DATABASE_ADMIN_PASSWORD="${parsed.password}"`,
        '',
      ].join('\n'),
      { mode: 0o600 },
    )
    console.log('✓ .env.admin.local creado')
  }
  if (!fs.existsSync(localFile)) {
    fs.writeFileSync(
      localFile,
      [
        '# Generado por `npm run setup`. No lo subas al repositorio.',
        `DATABASE_HOST=${host}`,
        'DATABASE_PORT=5432',
        `DATABASE_NAME=${parsed.database}`,
        `DATABASE_USER=iot_app.${parsed.ref}`,
        `DATABASE_PASSWORD=${randomSecret(24)}`,
        'DATABASE_SSL_MODE=verify',
        `APP_SECRET=${randomSecret(32)}`,
        'MFA_REQUIRED_ROLES=',
        'FORCE_HTTPS=false',
        '',
      ].join('\n'),
      { mode: 0o600 },
    )
    console.log('✓ .env.local creado (rol iot_app + claves aleatorias)')
  }
  console.log('\nSiguiente paso: npm run db:migrate && npm run db:seed')
}

main().catch((e: Error) => {
  console.error(`✗ ${e.message}`)
  process.exit(1)
})
