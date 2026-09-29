/**
 * Control de acceso por rol (RBAC) según la matriz de autenticación y autorización del informe
 * (tabla 11, sección 12.3), aplicando el principio de mínimo privilegio.
 *
 * Este módulo es PURO (sin acceso a base de datos ni a cookies): se usa en el servidor para
 * autorizar cada página, acción y consulta, y en la interfaz para mostrar u ocultar controles.
 * Ocultar un botón NUNCA reemplaza la verificación del servidor.
 */

export const ROLES = ['owner', 'admin', 'agronomist', 'operator', 'technician'] as const
export type Role = (typeof ROLES)[number]

export const ROLE_LABELS: Record<Role, string> = {
  owner: 'Dueño de la empresa',
  admin: 'Administrador de sistemas',
  agronomist: 'Ingeniero agrónomo',
  operator: 'Operador de campo',
  technician: 'Técnico de mantenimiento',
}

export function isRole(value: unknown): value is Role {
  return typeof value === 'string' && (ROLES as readonly string[]).includes(value)
}

export const PERMISSIONS = [
  'site:view',            // ver el resumen del predio
  'greenhouse:view',      // ver el detalle de un invernadero
  'history:view',         // ver gráficos e historial
  'alerts:view',
  'alerts:ack',           // reconocer alertas
  'thresholds:edit',      // ajustar umbrales de humedad y temperatura
  'schedules:edit',       // programar calendarios de riego
  'irrigation:command',   // accionar el riego manualmente
  'devices:view',         // calidad de enlace (RSSI/SNR) y estado de los equipos
  'devices:manage',       // alta/baja de nodos y rotación de llaves
  'greenhouses:manage',   // alta, edición y baja de invernaderos; ajustes del predio (cantidad NO fija)
  'audit:view',           // leer la bitácora
  'users:manage',         // crear usuarios y asignar permisos
  'export:csv',           // exportar historial
] as const
export type Permission = (typeof PERMISSIONS)[number]

const READ_ONLY_BASE: Permission[] = ['site:view', 'greenhouse:view', 'history:view', 'alerts:view']

const MATRIX: Record<Role, ReadonlySet<Permission>> = {
  // Dueño: solo lectura del dashboard ejecutivo; sin configuración técnica ni actuadores.
  owner: new Set<Permission>([...READ_ONLY_BASE, 'export:csv']),
  // Administrador: control total de la infraestructura.
  admin: new Set<Permission>(PERMISSIONS),
  // Agrónomo: analiza el historial, ajusta umbrales y programa riego; sin acceso a llaves ni red.
  agronomist: new Set<Permission>([...READ_ONLY_BASE, 'alerts:ack', 'thresholds:edit', 'schedules:edit', 'export:csv']),
  // Operador: ve alertas y acciona el riego, solo en los sectores que tiene asignados.
  operator: new Set<Permission>([...READ_ONLY_BASE, 'alerts:ack', 'irrigation:command']),
  // Técnico: solo lectura de bitácoras, calidad de enlace y estado de equipos.
  technician: new Set<Permission>([...READ_ONLY_BASE, 'devices:view', 'audit:view']),
}

export function can(role: Role, permission: Permission): boolean {
  return MATRIX[role].has(permission)
}

export function permissionsOf(role: Role): readonly Permission[] {
  return PERMISSIONS.filter((p) => MATRIX[role].has(p))
}

/** Roles cuyo alcance se limita a los invernaderos que se les asignan explícitamente. */
const SCOPED_ROLES: ReadonlySet<Role> = new Set<Role>(['operator'])

export interface Actor {
  id: string
  email: string
  name: string
  role: Role
  /** Solo relevante para roles con alcance limitado (operador). */
  greenhouseIds: readonly number[]
}

export type GreenhouseScope = { all: true } | { all: false; ids: readonly number[] }

export function scopeOf(actor: Pick<Actor, 'role' | 'greenhouseIds'>): GreenhouseScope {
  return SCOPED_ROLES.has(actor.role) ? { all: false, ids: actor.greenhouseIds } : { all: true }
}

export function canAccessGreenhouse(actor: Pick<Actor, 'role' | 'greenhouseIds'>, greenhouseId: number): boolean {
  const scope = scopeOf(actor)
  return scope.all || scope.ids.includes(greenhouseId)
}

/** ¿Tiene el permiso Y alcance sobre ese invernadero? Es la comprobación para acciones sobre un sector. */
export function canOnGreenhouse(actor: Actor, permission: Permission, greenhouseId: number): boolean {
  return can(actor.role, permission) && canAccessGreenhouse(actor, greenhouseId)
}

export class ForbiddenError extends Error {
  constructor(message = 'No tienes permiso para realizar esta acción.') {
    super(message)
    this.name = 'ForbiddenError'
  }
}

export function assertCan(actor: Actor, permission: Permission): void {
  if (!can(actor.role, permission)) throw new ForbiddenError()
}

export function assertCanOnGreenhouse(actor: Actor, permission: Permission, greenhouseId: number): void {
  if (!canOnGreenhouse(actor, permission, greenhouseId)) throw new ForbiddenError()
}
