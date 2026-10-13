/**
 * Aplica las migraciones de supabase/migrations/*.sql (en orden, una sola vez cada una) y deja
 * lista la contraseña del rol de la aplicación (iot_app).
 *
 *   npm run db:migrate
 *
 * Usa el rol administrador (.env.admin.local). Es idempotente.
 */
import fs from 'node:fs'
import path from 'node:path'
import { REPO_DIR, adminDb, appDb, loadEnvFiles, requireEnv, sqlLiteral } from './lib/scriptenv'

/** ¿Puede la aplicación iniciar sesión hoy con la contraseña de .env.local? */
async function appLoginWorks(): Promise<boolean> {
  const app = appDb(1)
  try {
    await app`select 1`
    return true
  } catch {
    return false
  } finally {
    await app.end({ timeout: 5 }).catch(() => undefined)
  }
}

async function main(): Promise<void> {
  loadEnvFiles('.env.local', '.env.admin.local')
  const sql = adminDb()
  try {
    const [who] = await sql<{ user: string; version: string }[]>`select current_user as user, split_part(version(), ' ', 2) as version`
    console.log(`Conectado como ${who!.user} · PostgreSQL ${who!.version}`)

    // Supabase ya trae estos roles y el esquema «extensions»; en un PostgreSQL común (la base local de la Raspberry Pi) las
    // migraciones los necesitan (revoke … from anon, authenticated; pgcrypto en «extensions»), así que se crean si faltan.
    await sql.unsafe(`do $$ begin
      if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
      if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
    end $$`)
    await sql`create schema if not exists extensions`
    await sql`create schema if not exists iot`
    await sql`create table if not exists iot.schema_migrations (
                name text primary key, applied_at timestamptz not null default now())`
    await sql`alter table iot.schema_migrations enable row level security`

    const dir = path.join(REPO_DIR, 'supabase', 'migrations')
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()
    const applied = new Set((await sql<{ name: string }[]>`select name from iot.schema_migrations`).map((r) => r.name))

    for (const f of files) {
      if (applied.has(f)) {
        console.log(`= ${f} (ya aplicada)`)
        continue
      }
      console.log(`> aplicando ${f} …`)
      const text = fs.readFileSync(path.join(dir, f), 'utf8')
      await sql.begin(async (tx) => {
        await tx.unsafe(text)
        await tx`insert into iot.schema_migrations (name) values (${f})`
      })
      console.log(`✓ ${f}`)
    }

    // Habilita el login del rol de la aplicación con la clave de .env.local. Solo si hace falta: cada ALTER ROLE
    // genera un verificador nuevo y el pooler de Supabase tarda unos segundos en olvidar el anterior (mientras
    // tanto la aplicación puede fallar al conectar), así que no se repite si el rol ya funciona.
    const password = requireEnv('DATABASE_PASSWORD')
    if (await appLoginWorks()) {
      console.log('= rol iot_app: ya inicia sesión con la contraseña de .env.local (no se modifica)')
    } else {
      await sql.unsafe(`alter role iot_app with login password ${sqlLiteral(password)}`)
      console.log('✓ rol iot_app habilitado con la contraseña de .env.local')
    }
  } finally {
    await sql.end({ timeout: 5 })
  }

  // Comprobación de extremo a extremo: entrar como la aplicación y ejercer un permiso.
  const app = appDb(1)
  try {
    const [r] = await app<{ user: string; n: number }[]>`select current_user as user, (select count(*)::int from iot.greenhouses) as n`
    console.log(`✓ la aplicación conecta como ${r!.user} (greenhouses: ${r!.n})`)
  } finally {
    await app.end({ timeout: 5 })
  }
}

main().catch((e: Error) => {
  console.error(`✗ ${e.message}`)
  process.exit(1)
})
