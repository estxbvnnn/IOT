/** Constantes de sesión compartidas por el proxy, las acciones y las páginas (sin dependencias). */

export const SESSION_COOKIE = 'iot_session'

/** Solo se aceptan rutas internas como destino de «volver a»: evita redirecciones abiertas a otros sitios. */
export function safeNextPath(value: string | null | undefined): string {
  if (!value || !value.startsWith('/') || value.startsWith('//') || value.startsWith('/\\') || value.includes('\n') || value.includes('\r')) return '/'
  if (value.startsWith('/login') || value.startsWith('/api')) return '/'
  return value.length > 200 ? '/' : value
}
