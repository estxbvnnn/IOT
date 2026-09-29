import type { AuditAction } from '@/lib/services/audit'

/** Etiqueta humana de cada acción de la bitácora. `Record<AuditAction, …>` obliga a etiquetar las que se agreguen. */
export const AUDIT_LABEL: Record<AuditAction, string> = {
  'auth.login': 'Inicio de sesión',
  'auth.login_failed': 'Intento de ingreso fallido',
  'auth.logout': 'Cierre de sesión',
  'auth.password_changed': 'Cambio de contraseña',
  'auth.mfa_enabled': 'Segundo factor activado',
  'auth.mfa_disabled': 'Segundo factor desactivado',
  'command.request': 'Riego manual solicitado',
  'command.confirm': 'Riego manual confirmado',
  'command.confirm_failed': 'Confirmación de riego fallida',
  'command.cancel': 'Orden cancelada',
  'command.stop': 'Orden de detener la bomba',
  'command.delivered': 'Orden entregada al nodo',
  'command.ack': 'Acuse del nodo',
  'command.expired': 'Orden vencida',
  'thresholds.update': 'Umbrales modificados',
  'schedule.create': 'Calendario de riego creado',
  'schedule.update': 'Calendario de riego modificado',
  'schedule.delete': 'Calendario de riego eliminado',
  'schedule.trigger': 'Calendario ejecutado',
  'alert.ack': 'Alerta reconocida',
  'data.export': 'Exportación de datos',
  'user.create': 'Usuario creado',
  'user.update': 'Rol o sectores modificados',
  'user.deactivate': 'Usuario desactivado',
  'user.activate': 'Usuario activado',
  'user.password_reset': 'Contraseña restablecida',
  'user.mfa_reset': 'Segundo factor restablecido',
  'user.greenhouses': 'Sectores asignados',
  'device.create': 'Nodo creado',
  'device.rotate_token': 'Token de nodo rotado',
  'device.enable': 'Nodo habilitado',
  'device.disable': 'Nodo deshabilitado',
  'device.auth_failed': 'Credencial de nodo rechazada',
  'device.first_seen': 'Primera trama de un nodo',
  'greenhouse.create': 'Invernadero creado',
  'greenhouse.update': 'Invernadero modificado',
  'greenhouse.archive': 'Invernadero dado de baja',
  'greenhouse.restore': 'Invernadero reactivado',
  'site.update': 'Ajustes del predio modificados',
  'audit.verify': 'Verificación de la cadena',
  'system.seed': 'Carga inicial de datos',
}

export function auditLabel(action: string): string {
  return (AUDIT_LABEL as Record<string, string>)[action] ?? action
}

/** Familias de acciones para el filtro (prefijo del código de la acción). */
export const AUDIT_GROUPS: readonly { prefix: string; label: string }[] = [
  { prefix: '', label: 'Todas' },
  { prefix: 'auth.', label: 'Acceso y sesiones' },
  { prefix: 'command.', label: 'Órdenes de riego' },
  { prefix: 'thresholds.', label: 'Umbrales' },
  { prefix: 'schedule.', label: 'Calendarios' },
  { prefix: 'alert.', label: 'Alertas' },
  { prefix: 'user.', label: 'Usuarios' },
  { prefix: 'device.', label: 'Equipos y nodos' },
  { prefix: 'greenhouse.', label: 'Invernaderos' },
  { prefix: 'site.', label: 'Predio' },
  { prefix: 'data.', label: 'Exportaciones' },
  { prefix: 'audit.', label: 'Auditoría' },
]

/**
 * «greenhouse:3» → su código (I3, Tomates-Norte…); «node:7» → «Nodo 7»; «user:…» → «Usuario …a1b2c3d4».
 * `code` es el código real del invernadero (la bitácora guarda solo el id). Texto siempre inerte.
 */
export function fmtTarget(target: string | null, code?: string | null): string {
  if (!target) return '—'
  const [kind, id = ''] = target.split(':')
  if (kind === 'greenhouse') return code ?? `Invernadero #${id}`
  if (kind === 'node') return `Nodo ${id}`
  if (kind === 'user') return `Usuario …${id.slice(-8)}`
  if (kind === 'site') return 'Predio'
  return target.slice(0, 60)
}
