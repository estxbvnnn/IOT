import { describe, expect, it } from 'vitest'
import {
  type Actor, PERMISSIONS, ROLES, type Permission, type Role, assertCan, assertCanOnGreenhouse, can,
  bypassesSafeguards, canAccessGreenhouse, canOnGreenhouse, ForbiddenError, isAdminRole, permissionsOf, scopeOf,
} from '@/lib/rbac'

const actor = (role: Role, greenhouseIds: number[] = []): Actor => ({ id: 'u', email: 'u@x.cl', name: 'U', role, greenhouseIds })

/** La matriz del informe (tabla 11, sección 12.3), expresada como tabla de verdad. */
const EXPECTED: Record<Role, Permission[]> = {
  owner: ['site:view', 'greenhouse:view', 'history:view', 'alerts:view', 'export:csv'],
  admin: [...PERMISSIONS],
  superadmin: [...PERMISSIONS],
  agronomist: ['site:view', 'greenhouse:view', 'history:view', 'alerts:view', 'alerts:ack', 'thresholds:edit', 'schedules:edit', 'export:csv'],
  operator: ['site:view', 'greenhouse:view', 'history:view', 'alerts:view', 'alerts:ack', 'irrigation:command'],
  technician: ['site:view', 'greenhouse:view', 'history:view', 'alerts:view', 'devices:view', 'audit:view'],
}

describe('matriz de permisos por rol (informe, tabla 11)', () => {
  for (const role of ROLES) {
    it(`${role}: exactamente los permisos esperados`, () => {
      expect([...permissionsOf(role)].sort()).toEqual([...EXPECTED[role]].sort())
    })
  }

  it('el dueño es de solo lectura: ninguna escritura ni actuador', () => {
    for (const p of ['alerts:ack', 'thresholds:edit', 'schedules:edit', 'irrigation:command', 'devices:manage', 'greenhouses:manage', 'users:manage'] as const) {
      expect(can('owner', p)).toBe(false)
    }
  })

  it('el técnico tiene acceso de solo lectura y NUNCA puede accionar actuadores', () => {
    expect(can('technician', 'irrigation:command')).toBe(false)
    expect(can('technician', 'thresholds:edit')).toBe(false)
    expect(can('technician', 'devices:manage')).toBe(false)
    expect(can('technician', 'devices:view')).toBe(true)
    expect(can('technician', 'audit:view')).toBe(true)
  })

  it('solo el administrador (y el súper administrador) gestiona usuarios, llaves de dispositivos e invernaderos, y ve todo', () => {
    for (const role of ROLES) {
      expect(can(role, 'users:manage')).toBe(isAdminRole(role))
      expect(can(role, 'devices:manage')).toBe(isAdminRole(role))
      expect(can(role, 'greenhouses:manage')).toBe(isAdminRole(role))
    }
  })

  it('solo el súper administrador se salta las salvaguardas de proceso', () => {
    for (const role of ROLES) expect(bypassesSafeguards(role)).toBe(role === 'superadmin')
  })

  it('el agrónomo ajusta umbrales pero no ve llaves ni equipos', () => {
    expect(can('agronomist', 'thresholds:edit')).toBe(true)
    expect(can('agronomist', 'devices:view')).toBe(false)
    expect(can('agronomist', 'devices:manage')).toBe(false)
  })

  it('accionar el riego a mano solo lo hacen el operador y los administradores', () => {
    for (const role of ROLES) expect(can(role, 'irrigation:command')).toBe(role === 'operator' || isAdminRole(role))
  })
})

describe('alcance por sector (el operador «no accede a sectores ajenos»)', () => {
  it('el operador solo alcanza los invernaderos asignados', () => {
    const op = actor('operator', [1, 2, 3])
    expect(scopeOf(op)).toEqual({ all: false, ids: [1, 2, 3] })
    expect(canAccessGreenhouse(op, 2)).toBe(true)
    expect(canAccessGreenhouse(op, 7)).toBe(false)
  })

  it('un operador sin asignaciones no ve ninguno', () => {
    expect(canAccessGreenhouse(actor('operator', []), 1)).toBe(false)
  })

  it('los demás roles alcanzan todos los sectores', () => {
    for (const role of ROLES.filter((r) => r !== 'operator')) {
      expect(scopeOf(actor(role))).toEqual({ all: true })
      expect(canAccessGreenhouse(actor(role), 10)).toBe(true)
    }
  })

  it('exige permiso Y alcance a la vez', () => {
    const op = actor('operator', [4])
    expect(canOnGreenhouse(op, 'irrigation:command', 4)).toBe(true)
    expect(canOnGreenhouse(op, 'irrigation:command', 5)).toBe(false) // sector ajeno
    expect(canOnGreenhouse(op, 'thresholds:edit', 4)).toBe(false) // sin permiso
    expect(canOnGreenhouse(actor('technician'), 'irrigation:command', 4)).toBe(false)
  })

  it('assertCan / assertCanOnGreenhouse lanzan ForbiddenError', () => {
    expect(() => assertCan(actor('owner'), 'users:manage')).toThrow(ForbiddenError)
    expect(() => assertCanOnGreenhouse(actor('operator', [1]), 'irrigation:command', 2)).toThrow(ForbiddenError)
    expect(() => assertCanOnGreenhouse(actor('operator', [1]), 'irrigation:command', 1)).not.toThrow()
  })
})
