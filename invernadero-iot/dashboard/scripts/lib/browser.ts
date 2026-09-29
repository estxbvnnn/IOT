/**
 * Navegador para las pruebas E2E y las capturas: usa Edge o Chrome ya instalados en el equipo
 * (no descarga nada). `playwright-core` solo es el controlador.
 */
import fs from 'node:fs'
import path from 'node:path'
import { type Browser, type Page, chromium } from 'playwright-core'
import { DASHBOARD_DIR } from './scriptenv'

export async function launchBrowser(): Promise<Browser> {
  const attempts: Parameters<typeof chromium.launch>[0][] = [
    { channel: 'msedge', headless: true },
    { channel: 'chrome', headless: true },
  ]
  let last: unknown
  for (const a of attempts) {
    try {
      return await chromium.launch(a)
    } catch (e) {
      last = e
    }
  }
  throw new Error(`No se pudo abrir Edge ni Chrome: ${(last as Error)?.message ?? last}`)
}

export interface DemoAccount { role: string; email: string; password: string }

/** Lee las cuentas demo que dejó `npm run db:seed` en .demo-credentials.md. */
export function readDemoAccounts(): Record<string, DemoAccount> {
  const file = path.join(DASHBOARD_DIR, '.demo-credentials.md')
  if (!fs.existsSync(file)) throw new Error('Falta .demo-credentials.md: ejecuta «npm run db:seed» primero.')
  const out: Record<string, DemoAccount> = {}
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const m = /^\|\s*([^|]+?)\s*\|\s*`([^`]+)`\s*\|\s*`([^`]+)`\s*\|/.exec(line)
    if (!m) continue
    const email = m[2]!
    const key = email.split('@')[0]!
    out[key] = { role: m[1]!, email, password: m[3]! }
  }
  return out
}

export async function login(page: Page, baseUrl: string, account: DemoAccount): Promise<void> {
  await page.goto(`${baseUrl}/login`)
  await page.getByLabel('Correo').fill(account.email)
  await page.getByLabel('Contraseña').fill(account.password)
  await page.getByRole('button', { name: 'Ingresar' }).click()
  await page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 60_000 })
}
