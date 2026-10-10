/**
 * Crea (o restablece) la cuenta de SÚPER ADMINISTRADOR para pruebas.
 *
 *   npm run db:superadmin               → la crea si no existe
 *   npm run db:superadmin -- --reset    → si ya existe, le genera una contraseña nueva
 *   npm run db:superadmin -- --email otro@invernadero.local
 *
 * Requiere la migración 0004 (npm run db:migrate). La contraseña se muestra y se guarda en
 * .demo-credentials.md; no se pide cambiarla al entrar (es una cuenta de pruebas: no la dejes en producción).
 */
import fs from 'node:fs'
import path from 'node:path'
import { adminDb, DASHBOARD_DIR } from './lib/scriptenv'
import { hashPassword } from '../src/lib/auth/password'
import { generatePassword } from '../src/lib/auth/tokens'
import { audit } from '../src/lib/services/audit'
import { ROLE_LABELS } from '../src/lib/rbac'

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(name)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback
}

const email = arg('--email', 'superadmin@invernadero.local').trim().toLowerCase()
const reset = process.argv.includes('--reset')
const credentialsFile = path.join(DASHBOARD_DIR, '.demo-credentials.md')

async function main(): Promise<void> {
  const sql = adminDb(2)
  try {
    const [existing] = await sql<{ id: string; role: string }[]>`select id, role from iot.app_users where email = ${email}`
    if (existing && !reset) {
      console.log(`= ${email} ya existe (rol ${existing.role}). Para generarle otra contraseña: npm run db:superadmin -- --reset`)
      return
    }
    const password = generatePassword(16)
    const hash = await hashPassword(password)
    if (existing) {
      await sql`
        update iot.app_users
           set role = 'superadmin', password_hash = ${hash}, must_change_password = false, is_active = true,
               failed_logins = 0, locked_until = null, updated_at = now()
         where id = ${existing.id}`
      await sql`delete from iot.sessions where user_id = ${existing.id}`
    } else {
      await sql`
        insert into iot.app_users (email, name, role, password_hash, must_change_password)
        values (${email}, 'Súper administrador (pruebas)', 'superadmin', ${hash}, false)`
    }
    await audit(sql, { actorLabel: 'sistema', action: existing ? 'user.password_reset' : 'user.create', detail: { email, role: 'superadmin', via: 'db:superadmin' } })

    const old = fs.existsSync(credentialsFile) ? fs.readFileSync(credentialsFile, 'utf8') : ''
    const header = old.includes('| Rol |') ? '' : '# Cuentas demo\n\n| Rol | Correo | Contraseña |\n|---|---|---|\n'
    // Si ya había una fila de este correo (restablecimiento), se reemplaza para no dejar una contraseña vieja.
    const kept = old.split('\n').filter((l) => !l.includes(`\`${email}\``)).join('\n').replace(/\n*$/, '\n')
    fs.writeFileSync(credentialsFile, `${kept === '\n' ? '' : kept}${header}| ${ROLE_LABELS.superadmin} | \`${email}\` | \`${password}\` |\n`, { mode: 0o600 })

    console.log(`✓ ${existing ? 'contraseña restablecida' : 'cuenta creada'}: ${email}`)
    console.log(`  contraseña: ${password}`)
    console.log(`  (también en ${path.relative(process.cwd(), credentialsFile)})`)
  } finally {
    await sql.end({ timeout: 5 })
  }
}

main().catch((e: Error) => {
  console.error(`✗ ${e.message}`)
  process.exit(1)
})
