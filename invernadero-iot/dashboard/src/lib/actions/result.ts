import { unstable_rethrow } from 'next/navigation'
import { AuthError } from '../auth/service'
import { ForbiddenError } from '../rbac'
import { CommandError } from '../services/commands'
import { ValidationError } from '../services/thresholds'

/** Resultado tipado de una acción del servidor (los mensajes ya están en español, listos para mostrar). */
export type ActionResult<T = void> =
  | { ok: true; data: T; message?: string }
  | { ok: false; error: string; fieldErrors?: Record<string, string>; code?: string }

export const ok = <T>(data: T, message?: string): ActionResult<T> => ({ ok: true, data, ...(message ? { message } : {}) })

export const fail = (error: string, fieldErrors?: Record<string, string>, code?: string): ActionResult<never> => ({
  ok: false, error, ...(fieldErrors ? { fieldErrors } : {}), ...(code ? { code } : {}),
})

/**
 * Ejecuta el cuerpo de una acción traduciendo los errores conocidos a mensajes para la persona usuaria.
 * Los errores inesperados se registran en el servidor y NO se muestran (no filtrar detalles internos).
 */
export async function run<T>(fn: () => Promise<T>): Promise<ActionResult<T>> {
  try {
    return { ok: true, data: await fn() }
  } catch (e) {
    unstable_rethrow(e) // redirect() y notFound() lanzan errores de control que deben propagarse
    if (e instanceof ValidationError) return fail(e.message, e.fieldErrors)
    if (e instanceof CommandError) return fail(e.message, undefined, e.code)
    if (e instanceof AuthError) return fail(e.message, e.field ? { [e.field]: e.message } : undefined)
    if (e instanceof ForbiddenError) return fail(e.message, undefined, 'forbidden')
    console.error('[acción] error inesperado:', e)
    return fail('Ocurrió un error inesperado. Inténtalo de nuevo en unos segundos.')
  }
}
