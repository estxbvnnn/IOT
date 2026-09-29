'use server'

import { refresh } from 'next/cache'
import QRCode from 'qrcode'
import { z } from 'zod'
import { beginTotpEnrollment, changePassword, confirmTotpEnrollment, disableTotp } from '@/lib/auth/service'
import { readSessionToken } from '@/lib/auth/session'
import { getDb } from '@/lib/db'
import { authConfig, getRequestMeta, requireUser } from '@/lib/dal'
import { type ActionResult, fail, ok, run } from '@/lib/actions/result'

/** Cuenta propia: contraseña y segundo factor (TOTP). Disponible incluso si falta cumplir la política. */

const passwordForm = z.object({
  current: z.string().min(1, 'Ingresa tu contraseña actual.').max(256),
  next: z.string().min(1, 'Ingresa la nueva contraseña.').max(256),
  confirm: z.string().max(256),
})

export async function changePasswordAction(_prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  const user = await requireUser({ allowRestricted: true })
  const parsed = passwordForm.safeParse(Object.fromEntries(formData))
  if (!parsed.success) return fail('Revisa los datos.', Object.fromEntries(parsed.error.issues.map((i) => [String(i.path[0]), i.message])))
  if (parsed.data.next !== parsed.data.confirm) return fail('Las contraseñas no coinciden.', { confirm: 'No coincide con la nueva contraseña.' })
  const meta = await getRequestMeta()
  const keepToken = await readSessionToken() // se conserva esta sesión; las demás se cierran
  const res = await run(() => changePassword(getDb(), user, {
    current: parsed.data.current, next: parsed.data.next, keepToken, ip: meta.ip,
  }))
  if (res.ok) refresh()
  return res.ok ? ok(undefined, 'Contraseña actualizada. Las demás sesiones se cerraron.') : res
}

export interface EnrollmentView {
  secret: string
  /** Imagen PNG (data URL) con el código QR para la app autenticadora. */
  qr: string
  enrollToken: string
}

/** Paso 1 del registro del segundo factor: genera la semilla y el QR (aún no queda activo). */
export async function beginTotpAction(): Promise<ActionResult<EnrollmentView>> {
  const user = await requireUser({ allowRestricted: true })
  return run(async () => {
    const e = beginTotpEnrollment(authConfig(), user)
    const qr = await QRCode.toDataURL(e.uri, { margin: 1, width: 200, errorCorrectionLevel: 'M' })
    return { secret: e.secret, qr, enrollToken: e.enrollToken }
  })
}

const confirmForm = z.object({ enrollToken: z.string().min(20).max(600), code: z.string().trim().min(6).max(8) })

/** Paso 2: el usuario escribe el código que muestra su app; recién entonces se activa. */
export async function confirmTotpAction(_prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  const user = await requireUser({ allowRestricted: true })
  const parsed = confirmForm.safeParse(Object.fromEntries(formData))
  if (!parsed.success) return fail('Escribe el código de 6 dígitos.', { code: 'Escribe el código de 6 dígitos.' })
  const meta = await getRequestMeta()
  const res = await run(async () => {
    await confirmTotpEnrollment(getDb(), authConfig(), user, {
      enrollToken: parsed.data.enrollToken, code: parsed.data.code, sessionToken: await readSessionToken(), ip: meta.ip,
    })
  })
  if (res.ok) refresh()
  return res.ok ? ok(undefined, 'Segundo factor activado.') : res
}

export async function disableTotpAction(_prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  const user = await requireUser({ allowRestricted: true })
  const password = String(formData.get('password') ?? '')
  const meta = await getRequestMeta()
  const res = await run(() => disableTotp(getDb(), authConfig(), user, { password, ip: meta.ip }))
  if (res.ok) refresh()
  return res.ok ? ok(undefined, 'Segundo factor desactivado.') : res
}
