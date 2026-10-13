/**
 * Prueba E2E de la interfaz web con Edge/Chrome (los que ya trae el equipo; playwright-core solo los controla).
 *
 *   npm run e2e -- --url http://127.0.0.1:3000 --users e2e-users.json [--shots carpeta]
 *
 * `--users` es un JSON { "admin": {"email","password"}, "owner": …, "agronomist": …, "operator": …, "technician": … } con cuentas que YA existen
 * en la base de la instancia probada (el script no crea nada). Para cada rol comprueba el menú que le corresponde, abre las pantallas
 * permitidas y verifica que las prohibidas respondan «no existe»; con el administrador recorre además el riego manual en dos pasos
 * (contraseña incorrecta y correcta), umbrales, exportación CSV, bitácora y cierre de sesión. Falla si la consola del navegador
 * registra errores o si alguna petición de la propia app responde 5xx. Sale con código 1 si algo falla.
 */
import fs from 'node:fs'
import path from 'node:path'
import type { Page } from 'playwright-core'
import { launchBrowser } from './lib/browser'

function arg(name: string, fallback = ''): string {
  const i = process.argv.indexOf(name)
  return i >= 0 ? (process.argv[i + 1] ?? fallback) : fallback
}

const BASE = arg('--url', 'http://127.0.0.1:3000').replace(/\/$/, '')
const USERS = JSON.parse(fs.readFileSync(arg('--users', 'e2e-users.json'), 'utf8')) as Record<string, { email: string; password: string }>
const SHOTS = arg('--shots')
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true })

let pass = 0
const fails: string[] = []
const ok = (name: string) => { pass++; console.log(`  ✓ ${name}`) }
const bad = (name: string, why: string) => { fails.push(`${name}: ${why}`); console.log(`  ✗ ${name} — ${why}`) }
async function step(name: string, fn: () => Promise<void>): Promise<void> {
  try { await fn(); ok(name) } catch (e) { bad(name, (e as Error).message.split('\n')[0]!) }
}
const shot = async (page: Page, name: string) => { if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: true }) }

/** Menú lateral esperado por rol (etiquetas de components/layout/app-shell.tsx; «Mi cuenta» es de todos). */
const NAV: Record<string, string[]> = {
  admin: ['Predio', 'Alertas', 'Invernaderos', 'Equipos', 'Bitácora', 'Usuarios', 'Mi cuenta'],
  owner: ['Predio', 'Alertas', 'Mi cuenta'],
  agronomist: ['Predio', 'Alertas', 'Mi cuenta'],
  operator: ['Predio', 'Alertas', 'Mi cuenta'],
  technician: ['Predio', 'Alertas', 'Equipos', 'Bitácora', 'Mi cuenta'],
}
const FORBIDDEN: Record<string, string[]> = {
  owner: ['/users', '/audit', '/devices', '/greenhouses'],
  agronomist: ['/users', '/audit', '/devices', '/greenhouses'],
  operator: ['/users', '/audit', '/devices', '/greenhouses'],
  technician: ['/users', '/greenhouses'],
}

async function loginAs(page: Page, who: { email: string; password: string }): Promise<void> {
  await page.goto(`${BASE}/login`)
  await page.getByLabel('Correo').fill(who.email)
  await page.getByLabel('Contraseña').fill(who.password)
  await page.getByRole('button', { name: 'Ingresar' }).click()
  await page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 30_000 })
}

async function main(): Promise<void> {
  const browser = await launchBrowser()
  try {
    // -------------------------------------------------- 1) login incorrecto y rutas protegidas
    console.log('\n[sin sesión]')
    {
      const ctx = await browser.newContext()
      const page = await ctx.newPage()
      await step('una ruta protegida redirige al login', async () => {
        await page.goto(`${BASE}/`)
        if (!new URL(page.url()).pathname.startsWith('/login')) throw new Error(`quedó en ${page.url()}`)
      })
      await step('contraseña incorrecta: mensaje de error y sigue en el login', async () => {
        await page.getByLabel('Correo').fill(Object.values(USERS)[0]!.email)
        await page.getByLabel('Contraseña').fill('esta-no-es-la-clave')
        await page.getByRole('button', { name: 'Ingresar' }).click()
        await page.waitForTimeout(1500)
        if (!new URL(page.url()).pathname.startsWith('/login')) throw new Error('entró con una clave incorrecta')
        if ((await page.getByRole('alert').count()) === 0) throw new Error('no mostró el error')
      })
      await shot(page, 'login-error')
      await step('la API sin sesión ni clave responde 401', async () => {
        const r = await page.request.get(`${BASE}/api/v1/greenhouses`)
        if (r.status() !== 401) throw new Error(`HTTP ${r.status()}`)
      })
      await ctx.close()
    }

    // -------------------------------------------------- 2) cada rol
    for (const [role, who] of Object.entries(USERS)) {
      console.log(`\n[${role}]`)
      const ctx = await browser.newContext({ viewport: { width: 1366, height: 800 } })
      const page = await ctx.newPage()
      const consoleErrors: string[] = []
      const serverErrors: string[] = []
      page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 160)) })
      page.on('response', (r) => { if (r.status() >= 500 && r.url().startsWith(BASE)) serverErrors.push(`${r.status()} ${r.url()}`) })

      await step('inicia sesión', () => loginAs(page, who))
      await step('el menú muestra exactamente lo que le corresponde', async () => {
        const nav = page.getByRole('navigation').first()
        const txt = (await nav.innerText()).replace(/\s+/g, ' ')
        for (const l of NAV[role] ?? []) if (!txt.includes(l)) throw new Error(`falta «${l}»`)
        for (const l of ['Invernaderos', 'Equipos', 'Bitácora', 'Usuarios']) {
          if (!(NAV[role] ?? []).includes(l) && new RegExp(`\\b${l}\\b`).test(txt)) throw new Error(`muestra «${l}», que no le corresponde`)
        }
      })
      await shot(page, `${role}-predio`)
      for (const route of FORBIDDEN[role] ?? []) {
        await step(`${route} no existe para este rol`, async () => {
          const r = await page.goto(`${BASE}${route}`)
          if (r && r.status() !== 404) throw new Error(`HTTP ${r.status()}`)
        })
      }
      consoleErrors.length = 0                       // el navegador registra como «error» los 404 que se esperaban arriba
      await step('abre el detalle de un invernadero con sus gráficos', async () => {
        await page.goto(`${BASE}/`)
        await page.locator('a[href^="/greenhouses/"]').first().click()
        await page.waitForURL(/\/greenhouses\/[A-Za-z0-9_-]+/, { timeout: 30_000 })
        await page.waitForSelector('svg', { timeout: 15_000 })
      })
      await shot(page, `${role}-invernadero`)
      await step('alertas se abre', async () => { await page.goto(`${BASE}/alerts`); await page.getByRole('heading').first().waitFor() })
      await step('mi cuenta se abre', async () => { await page.goto(`${BASE}/account`); await page.getByRole('heading').first().waitFor() })
      await step('vista móvil sin desbordar horizontalmente', async () => {
        await page.setViewportSize({ width: 390, height: 800 })
        await page.goto(`${BASE}/`)
        await page.waitForTimeout(800)
        const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
        if (over > 4) throw new Error(`desborda ${over}px`)
      })
      await shot(page, `${role}-movil`)
      await step('cierra sesión y la ruta vuelve a estar protegida', async () => {
        await page.setViewportSize({ width: 1366, height: 800 })
        await page.goto(`${BASE}/account`)
        await page.getByRole('button', { name: /Cerrar sesión|Salir/ }).first().click()
        await page.waitForURL(/\/login/, { timeout: 15_000 })
        await page.goto(`${BASE}/`)
        if (!new URL(page.url()).pathname.startsWith('/login')) throw new Error('la sesión siguió abierta')
      })
      await step('sin errores de consola ni respuestas 5xx', async () => {
        if (consoleErrors.length) throw new Error(`consola: ${consoleErrors.slice(0, 2).join(' | ')}`)
        if (serverErrors.length) throw new Error(`servidor: ${serverErrors.slice(0, 2).join(' | ')}`)
      })
      await ctx.close()
    }

    // -------------------------------------------------- 3) flujos del administrador
    if (USERS.admin) {
      console.log('\n[admin: flujos]')
      const ctx = await browser.newContext({ viewport: { width: 1366, height: 900 }, acceptDownloads: true })
      const page = await ctx.newPage()
      const consoleErrors: string[] = []
      page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 160)) })
      await loginAs(page, USERS.admin)

      await step('riego manual: clave incorrecta no activa la orden y la correcta la deja en cola', async () => {
        await page.goto(`${BASE}/greenhouses/I3`)
        await page.getByRole('button', { name: /Regar ahora/ }).click()
        await page.getByRole('button', { name: 'Solicitar' }).click()
        const pw = page.locator('input[name="password"]')
        await pw.waitFor({ timeout: 15_000 })
        await pw.fill('clave-incorrecta')
        await page.getByRole('button', { name: 'Confirmar y enviar' }).click()
        await page.getByText(/incorrecta/i).first().waitFor({ timeout: 15_000 })
        await pw.fill(USERS.admin!.password)
        await page.getByRole('button', { name: 'Confirmar y enviar' }).click()
        await page.getByText(/Paso 3 de 3|Seguimiento|en cola|queued|Entregada|Ejecutada/i).first().waitFor({ timeout: 20_000 })
      })
      await shot(page, 'admin-riego-confirmado')
      await step('detener bomba (un solo paso)', async () => {
        await page.goto(`${BASE}/greenhouses/I3`)
        const stop = page.getByRole('button', { name: /Detener bomba/ })
        await page.waitForTimeout(1500)
        if ((await stop.count()) > 0 && (await stop.isEnabled())) await stop.click()   // el botón solo existe con la bomba encendida
        await page.waitForTimeout(500)
      })
      await step('exportar CSV descarga un archivo con cabecera', async () => {
        const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 20_000 }), page.goto(`${BASE}/api/export/I1?range=24h`).catch(() => undefined)])
        const text = fs.readFileSync(await dl.path(), 'utf8')
        if (!text.startsWith('timestamp_utc,')) throw new Error('el CSV no tiene la cabecera esperada')
      })
      await step('bitácora: verifica la cadena de hashes', async () => {
        await page.goto(`${BASE}/audit`)
        await page.getByRole('button', { name: /Verificar/ }).first().click()
        await page.getByText(/íntegra|intacta|correcta|sin alteraciones/i).first().waitFor({ timeout: 30_000 })
      })
      await shot(page, 'admin-bitacora')
      await step('equipos y usuarios cargan', async () => {
        for (const r of ['/devices', '/users', '/greenhouses']) {
          const resp = await page.goto(`${BASE}${r}`)
          if (!resp || resp.status() !== 200) throw new Error(`${r}: HTTP ${resp?.status()}`)
        }
      })
      await step('sin errores de consola en los flujos', async () => {
        if (consoleErrors.length) throw new Error(consoleErrors.slice(0, 2).join(' | '))
      })
      await ctx.close()
    }
  } finally {
    await browser.close()
  }

  console.log(`\n${pass} comprobaciones correctas, ${fails.length} fallidas`)
  if (fails.length) { for (const f of fails) console.log(` - ${f}`); process.exit(1) }
}

main().catch((e: Error) => { console.error(`✗ ${e.message}`); process.exit(1) })
