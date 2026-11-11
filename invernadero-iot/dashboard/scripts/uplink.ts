/**
 * ENVÍO Raspberry Pi → nube (AWS). Cada UPLINK_INTERVAL_S (por defecto 5 s) manda por HTTPS las lecturas nuevas de la base local.
 * Es el último tramo del diagrama del proyecto: nodos → malla → concentrador → Pi (guarda en local) → AWS.
 *
 *   npm run uplink
 *
 * Variables:
 *   DATABASE_*                la base LOCAL (rol «iot_app»)
 *   AWS_UPLINK_URL            URL a la que se hace el POST (p. ej. la de API Gateway). Sin ella el servicio queda inactivo.
 *   AWS_UPLINK_API_KEY        opcional: se manda en la cabecera `x-api-key`
 *   AWS_PUBLIC_KEY_FILE       clave PÚBLICA RSA de AWS (PEM). Con ella cada lote viaja cifrado (RSA-2048 + AES-256-GCM).
 *                             Sin ella el servicio NO envía, salvo que UPLINK_SIN_CIFRAR=1 (solo pruebas).
 *   UPLINK_INTERVAL_S         segundos entre envíos (por defecto 5, mínimo 1)
 *   UPLINK_BATCH              lecturas por lote (por defecto 200)
 *   UPLINK_ORIGEN             nombre de esta Pi dentro del lote (por defecto «pi-invernadero»)
 *   UPLINK_ONCE=1             un solo ciclo y termina (pruebas)
 */
import fs from 'node:fs'
import { createPublicKey, type KeyObject } from 'node:crypto'
import { uplinkOnce, type UplinkConfig } from './lib/uplink-core'
import { appDb, loadEnvFiles } from './lib/scriptenv'

const stamp = () => new Date().toISOString().replace('T', ' ').slice(0, 19)
const log = (m: string) => console.log(`[${stamp()}] ${m}`)
const idle = (): void => {
  setInterval(() => undefined, 3_600_000)
  process.on('SIGTERM', () => process.exit(0))
  process.on('SIGINT', () => process.exit(0))
}

async function main(): Promise<void> {
  loadEnvFiles('.env.local')
  const url = process.env.AWS_UPLINK_URL?.trim()
  if (!url) {
    log('Envío a la nube DESACTIVADO: falta AWS_UPLINK_URL en .env. La Pi funciona igual en local.')
    return idle()
  }
  let publicKey: KeyObject | null = null
  const pem = process.env.AWS_PUBLIC_KEY_FILE?.trim()
  if (pem) {
    if (!fs.existsSync(pem)) {
      log(`Envío a la nube DESACTIVADO: no existe AWS_PUBLIC_KEY_FILE (${pem}).`)
      return idle()
    }
    publicKey = createPublicKey(fs.readFileSync(pem))
  } else if (process.env.UPLINK_SIN_CIFRAR !== '1') {
    log('Envío a la nube DESACTIVADO: falta AWS_PUBLIC_KEY_FILE (los datos deben viajar cifrados). Para una prueba sin cifrar: UPLINK_SIN_CIFRAR=1.')
    return idle()
  }

  const everyS = Math.max(1, Number(process.env.UPLINK_INTERVAL_S ?? 5))
  const cfg: UplinkConfig = {
    url, apiKey: process.env.AWS_UPLINK_API_KEY?.trim() || undefined, publicKey,
    batch: Math.max(1, Number(process.env.UPLINK_BATCH ?? 200)), origen: process.env.UPLINK_ORIGEN?.trim() || 'pi-invernadero',
  }
  const db = appDb(2)
  let running = false
  let lastOk = true

  async function cycle(): Promise<void> {
    if (running) return
    running = true
    try {
      // Mientras haya más lecturas pendientes se envían lotes seguidos, sin esperar al siguiente intervalo.
      for (let i = 0; i < 50; i++) {
        const r = await uplinkOnce(db, cfg)
        if (!r.ok) {
          if (lastOk) log(`SIN conexión con la nube (${r.error}); se reintenta cada ${everyS} s. La Pi sigue funcionando normalmente.`)
          lastOk = false
          return
        }
        if (r.sent > 0) log(`Enviadas ${r.sent} lecturas a la nube (hasta el id ${r.lastId}, ${r.ms} ms${publicKey ? ', cifradas' : ', SIN cifrar'})`)
        else if (!lastOk) log('Conexión con la nube restablecida.')
        lastOk = true
        if (r.sent < cfg.batch) return
      }
    } catch (e) {
      log(`Error inesperado en el envío: ${(e as Error).message}`)
      lastOk = false
    } finally {
      running = false
    }
  }

  log(`Envío a la nube cada ${everyS} s → ${new URL(url).host} (${publicKey ? 'cifrado con la clave pública de AWS' : 'SIN cifrar (prueba)'})`)
  if (process.env.UPLINK_ONCE === '1') {
    await cycle()
    await db.end({ timeout: 3 })
    process.exit(lastOk ? 0 : 1)
  }
  void cycle()
  const timer = setInterval(() => void cycle(), everyS * 1000)
  const shutdown = async (): Promise<void> => {
    clearInterval(timer)
    log('Cerrando…')
    await db.end({ timeout: 3 }).catch(() => undefined)
    process.exit(0)
  }
  process.on('SIGINT', () => void shutdown())
  process.on('SIGTERM', () => void shutdown())
}

main().catch((e: Error) => {
  console.error(`✗ ${e.message}`)
  process.exit(1)
})
