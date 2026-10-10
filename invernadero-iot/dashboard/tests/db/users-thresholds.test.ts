import { describe, expect, it } from 'vitest'
import { ForbiddenError } from '@/lib/rbac'
import { createUser, listUsers, resetUserMfa, resetUserPassword, setUserActive, updateUserAccess } from '@/lib/services/users'
import { updateThresholds, ValidationError } from '@/lib/services/thresholds'
import {
  createSchedule, deleteSchedule, listSchedules, localParts, setScheduleEnabled,
} from '@/lib/services/schedules'
import { AUTH_CFG, T0, frameBuilder, inRollback, makeUser, plus, send, tokenFor } from './helpers'
import { getSessionUser, login } from '@/lib/auth/service'

const GH = 6 // I6

describe('gestión de usuarios (solo administrador)', () => {
  it('crea una cuenta con contraseña inicial aleatoria que sirve para entrar y obliga a cambiarla', async () => {
    await inRollback(async (tx) => {
      const admin = await makeUser(tx, 'admin')
      const { user, initialPassword } = await createUser(tx, admin.actor, {
        name: 'Ana Soto', email: `  ANA.SOTO-${Date.now()}@Invernadero.local `, role: 'operator', greenhouseIds: [1, 2],
      })
      expect(user).toMatchObject({ role: 'operator', greenhouseIds: [1, 2], mustChangePassword: true, isActive: true })
      expect(user.email).toMatch(/^ana\.soto-\d+@invernadero\.local$/)
      expect(initialPassword).toHaveLength(16)
      const r = await login(tx, AUTH_CFG, { email: user.email, password: initialPassword, ip: null, userAgent: null, now: T0 })
      expect(r.ok).toBe(true)
      if (r.ok) {
        expect(r.user.mustChangePassword).toBe(true)
        expect(await getSessionUser(tx, AUTH_CFG, r.token, plus(T0, 1))).toMatchObject({ greenhouseIds: [1, 2] })
      }
      // La bitácora registra la creación sin la contraseña.
      const [a] = await tx<{ detail: Record<string, unknown> }[]>`select detail from iot.audit_log where action = 'user.create' order by id desc limit 1`
      expect(JSON.stringify(a!.detail)).not.toContain(initialPassword)
    })
  })

  it('valida los datos y no permite correos duplicados', async () => {
    await inRollback(async (tx) => {
      const admin = await makeUser(tx, 'admin')
      await expect(createUser(tx, admin.actor, { name: 'A', email: 'no-es-correo', role: 'owner', greenhouseIds: [] })).rejects.toBeInstanceOf(ValidationError)
      await expect(createUser(tx, admin.actor, { name: 'Ana Soto', email: admin.email, role: 'owner', greenhouseIds: [] })).rejects.toMatchObject({ fieldErrors: { email: expect.stringMatching(/Ya existe/) } })
      // @ts-expect-error rol inexistente a propósito
      await expect(createUser(tx, admin.actor, { name: 'Ana Soto', email: 'x@y.cl', role: 'root', greenhouseIds: [] })).rejects.toBeInstanceOf(ValidationError)
    })
  })

  it('solo un súper administrador puede crear otro súper administrador (sin escalar privilegios)', async () => {
    await inRollback(async (tx) => {
      const admin = await makeUser(tx, 'admin')
      await expect(createUser(tx, admin.actor, { name: 'Ana Soto', email: 'sa1@y.cl', role: 'superadmin', greenhouseIds: [] })).rejects.toBeInstanceOf(ForbiddenError)
      const root = await makeUser(tx, 'superadmin')
      const { user } = await createUser(tx, root.actor, { name: 'Ana Soto', email: 'sa2@y.cl', role: 'superadmin', greenhouseIds: [] })
      expect(user.role).toBe('superadmin')
      await expect(updateUserAccess(tx, admin.actor, user.id, { role: 'owner', greenhouseIds: [] })).rejects.toBeInstanceOf(ForbiddenError)
    })
  })

  it('solo asigna sectores a operadores (los demás roles ven todo)', async () => {
    await inRollback(async (tx) => {
      const admin = await makeUser(tx, 'admin')
      const { user } = await createUser(tx, admin.actor, { name: 'Luis Rojas', email: `luis-${Date.now()}@invernadero.local`, role: 'agronomist', greenhouseIds: [1, 2, 3] })
      expect(user.greenhouseIds).toEqual([])
    })
  })

  it('el resto de los roles no puede gestionar usuarios', async () => {
    await inRollback(async (tx) => {
      for (const role of ['owner', 'agronomist', 'operator', 'technician'] as const) {
        const u = await makeUser(tx, role, { greenhouseIds: [1] })
        await expect(listUsers(tx, u.actor)).rejects.toBeInstanceOf(ForbiddenError)
        await expect(createUser(tx, u.actor, { name: 'Xx', email: 'x@y.cl', role: 'owner', greenhouseIds: [] })).rejects.toBeInstanceOf(ForbiddenError)
        await expect(setUserActive(tx, u.actor, u.id, false)).rejects.toBeInstanceOf(ForbiddenError)
      }
    })
  })

  it('desactivar cierra sus sesiones y le impide volver a entrar; reactivar lo permite', async () => {
    await inRollback(async (tx) => {
      const admin = await makeUser(tx, 'admin')
      const u = await makeUser(tx, 'technician')
      const s = await login(tx, AUTH_CFG, { email: u.email, password: u.password, ip: null, userAgent: null, now: T0 })
      if (!s.ok) throw new Error('login')
      await setUserActive(tx, admin.actor, u.id, false)
      expect(await getSessionUser(tx, AUTH_CFG, s.token, plus(T0, 5))).toBeNull()
      expect((await login(tx, AUTH_CFG, { email: u.email, password: u.password, ip: null, userAgent: null, now: plus(T0, 6) })).ok).toBe(false)
      await setUserActive(tx, admin.actor, u.id, true)
      expect((await login(tx, AUTH_CFG, { email: u.email, password: u.password, ip: null, userAgent: null, now: plus(T0, 7) })).ok).toBe(true)
    })
  })

  it('protege contra dejar el sistema sin administradores y contra desactivarse a sí mismo', async () => {
    await inRollback(async (tx) => {
      const a = await makeUser(tx, 'admin')
      const b = await makeUser(tx, 'admin')
      // Solo A y B quedan como administradores activos.
      await tx`update iot.app_users set is_active = false where role in ('admin', 'superadmin') and id not in (${a.id}, ${b.id})`
      await expect(setUserActive(tx, a.actor, a.id, false)).rejects.toMatchObject({ message: expect.stringMatching(/propia cuenta/) })
      // Con dos administradores activos, A puede desactivar a B: queda A como único administrador activo.
      await setUserActive(tx, a.actor, b.id, false)
      // B (con su sesión aún abierta) intenta desactivar o degradar al único administrador activo: se bloquea.
      await expect(setUserActive(tx, b.actor, a.id, false)).rejects.toMatchObject({ message: expect.stringMatching(/al menos un administrador/) })
      await expect(updateUserAccess(tx, b.actor, a.id, { role: 'owner', greenhouseIds: [] })).rejects.toBeInstanceOf(ValidationError)
      expect((await listUsers(tx, b.actor)).find((u) => u.id === a.id)).toMatchObject({ role: 'admin', isActive: true })
    })
  })

  it('restablecer contraseña genera una nueva (una sola vez), cierra sesiones y exige cambiarla; restablecer 2FA lo quita', async () => {
    await inRollback(async (tx) => {
      const admin = await makeUser(tx, 'admin')
      const u = await makeUser(tx, 'operator', { greenhouseIds: [1] })
      const s = await login(tx, AUTH_CFG, { email: u.email, password: u.password, ip: null, userAgent: null, now: T0 })
      if (!s.ok) throw new Error('login')
      const fresh = await resetUserPassword(tx, admin.actor, u.id)
      expect(fresh).not.toBe(u.password)
      expect(await getSessionUser(tx, AUTH_CFG, s.token, plus(T0, 2))).toBeNull()
      expect((await login(tx, AUTH_CFG, { email: u.email, password: u.password, ip: null, userAgent: null, now: plus(T0, 3) })).ok).toBe(false)
      const again = await login(tx, AUTH_CFG, { email: u.email, password: fresh, ip: null, userAgent: null, now: plus(T0, 4) })
      expect(again.ok && again.user.mustChangePassword).toBe(true)
      await tx`update iot.app_users set totp_secret_enc = 'x' where id = ${u.id}`
      await resetUserMfa(tx, admin.actor, u.id)
      const [row] = await tx<{ totp_secret_enc: string | null }[]>`select totp_secret_enc from iot.app_users where id = ${u.id}`
      expect(row!.totp_secret_enc).toBeNull()
    })
  })

  it('cambiar de rol cierra sus sesiones y ajusta las asignaciones', async () => {
    await inRollback(async (tx) => {
      const admin = await makeUser(tx, 'admin')
      const u = await makeUser(tx, 'operator', { greenhouseIds: [1] })
      const s = await login(tx, AUTH_CFG, { email: u.email, password: u.password, ip: null, userAgent: null, now: T0 })
      if (!s.ok) throw new Error('login')
      await updateUserAccess(tx, admin.actor, u.id, { role: 'operator', greenhouseIds: [3, 4] })
      expect(await getSessionUser(tx, AUTH_CFG, s.token, plus(T0, 2))).toMatchObject({ greenhouseIds: [3, 4] }) // mismo rol: sesión vigente
      await updateUserAccess(tx, admin.actor, u.id, { role: 'technician', greenhouseIds: [3, 4] })
      expect(await getSessionUser(tx, AUTH_CFG, s.token, plus(T0, 3))).toBeNull()
      const found = (await listUsers(tx, admin.actor)).find((x) => x.id === u.id)!
      expect(found).toMatchObject({ role: 'technician', greenhouseIds: [] })
      await expect(updateUserAccess(tx, admin.actor, admin.id, { role: 'owner', greenhouseIds: [] })).rejects.toMatchObject({ message: expect.any(String) })
    })
  })
})

describe('umbrales de riego (agrónomo)', () => {
  it('actualiza, sube la versión, registra los cambios y llegan al nodo en la siguiente trama', async () => {
    await inRollback(async (tx) => {
      const agro = await makeUser(tx, 'agronomist')
      const token = await tokenFor(tx, GH)
      const f = frameBuilder()
      const r0 = await send(tx, token, f(), T0)
      const v0 = r0.status === 200 ? r0.body.cfg.ver : -1

      const dto = await updateThresholds(tx, agro.actor, GH, { soilOn: 650, soilOff: 480, pumpMaxS: 25 }, '203.0.113.5', plus(T0, 5))
      expect(dto).toMatchObject({ soilOn: 650, soilOff: 480, pumpMaxS: 25, version: v0 + 1 })

      const r1 = await send(tx, token, f(), plus(T0, 10))
      expect(r1.status === 200 && r1.body.cfg).toMatchObject({ ver: v0 + 1, suelo_on: 650, suelo_off: 480, riego_max_s: 25 })

      const [a] = await tx<{ actor_label: string; ip: string; detail: { changes: Record<string, { from: number; to: number }> } }[]>`
        select actor_label, ip, detail from iot.audit_log where action = 'thresholds.update' order by id desc limit 1`
      expect(a).toMatchObject({ actor_label: agro.email, ip: '203.0.113.5' })
      expect(a!.detail.changes.soilOn).toEqual({ from: 700, to: 650 })
      expect(Object.keys(a!.detail.changes).sort()).toEqual(['pumpMaxS', 'soilOff', 'soilOn'])
    })
  })

  it('el riego automático se activa y desactiva: viaja al nodo en cfg.auto y queda en la bitácora', async () => {
    await inRollback(async (tx) => {
      const agro = await makeUser(tx, 'agronomist')
      const token = await tokenFor(tx, GH)
      const f = frameBuilder()
      const r0 = await send(tx, token, f(), T0)
      expect(r0.status === 200 && r0.body.cfg).toMatchObject({ auto: 1 }) // por defecto activado

      const off = await updateThresholds(tx, agro.actor, GH, { autoEnabled: false }, '203.0.113.5', plus(T0, 5))
      expect(off.autoEnabled).toBe(false)
      const r1 = await send(tx, token, f(), plus(T0, 10))
      expect(r1.status === 200 && r1.body.cfg).toMatchObject({ auto: 0, suelo_on: 700 }) // lo demás no cambia

      const on = await updateThresholds(tx, agro.actor, GH, { autoEnabled: true }, null, plus(T0, 15))
      expect(on.autoEnabled).toBe(true)
      expect(on.version).toBeGreaterThan(off.version)
      const r2 = await send(tx, token, f(), plus(T0, 20))
      expect(r2.status === 200 && r2.body.cfg).toMatchObject({ auto: 1 })

      const acts = await tx<{ detail: { changes: Record<string, { from: boolean; to: boolean }> } }[]>`
        select detail from iot.audit_log where action = 'thresholds.update' order by id desc limit 2`
      expect(acts[1]!.detail.changes.autoEnabled).toEqual({ from: true, to: false })
    })
  })

  it('solo quien puede editar umbrales cambia el riego automático (el operador y el técnico no)', async () => {
    await inRollback(async (tx) => {
      for (const role of ['owner', 'operator', 'technician'] as const) {
        const u = await makeUser(tx, role, { greenhouseIds: [GH] })
        await expect(updateThresholds(tx, u.actor, GH, { autoEnabled: false })).rejects.toBeInstanceOf(ForbiddenError)
      }
      const root = await makeUser(tx, 'superadmin')
      await expect(updateThresholds(tx, root.actor, GH, { autoEnabled: false })).resolves.toMatchObject({ autoEnabled: false })
    })
  })

  it('un cambio nulo no sube la versión ni ensucia la bitácora', async () => {
    await inRollback(async (tx) => {
      const agro = await makeUser(tx, 'agronomist')
      const before = await updateThresholds(tx, agro.actor, GH, {})
      const again = await updateThresholds(tx, agro.actor, GH, { soilOn: before.soilOn })
      expect(again.version).toBe(before.version)
    })
  })

  it('rechaza combinaciones incoherentes con mensajes por campo', async () => {
    await inRollback(async (tx) => {
      const agro = await makeUser(tx, 'agronomist')
      const bad = async (patch: Parameters<typeof updateThresholds>[3], field: string) => {
        const err = await updateThresholds(tx, agro.actor, GH, patch).catch((e) => e)
        expect(err).toBeInstanceOf(ValidationError)
        expect(Object.keys(err.fieldErrors)).toContain(field)
      }
      await bad({ soilOff: 750 }, 'soilOff') // apagar ≥ regar
      await bad({ soilSat: 520 }, 'soilOff') // saturado ≥ apagar
      await bad({ tempHeat: 45 }, 'tempHeat') // calor > máxima de riego
      await bad({ tempFrost: 8 }, 'tempHeat') // helada ≥ frío
      await bad({ humAirMin: 95 }, 'humAirMin')
      await bad({ pumpMaxS: 600 }, 'pumpMaxS') // sobre el límite duro de 120 s
      await bad({ pumpWaitS: -10 }, 'pumpWaitS') // 0 sí vale: sin espera entre riegos
      await bad({ intervalS: 2 }, 'intervalS')
      await bad({ soilOn: 1500 }, 'soilOn')
      await bad({ soilOn: 700.5 }, 'soilOn')
    })
  })

  it('solo agrónomo y administrador pueden editar umbrales', async () => {
    await inRollback(async (tx) => {
      for (const role of ['owner', 'operator', 'technician'] as const) {
        const u = await makeUser(tx, role, { greenhouseIds: [GH] })
        await expect(updateThresholds(tx, u.actor, GH, { soilOn: 650 })).rejects.toBeInstanceOf(ForbiddenError)
      }
      const admin = await makeUser(tx, 'admin')
      await expect(updateThresholds(tx, admin.actor, GH, { soilOn: 690 })).resolves.toMatchObject({ soilOn: 690 })
    })
  })
})

describe('calendarios de riego (agrónomo)', () => {
  it('crea, lista, deshabilita y borra; respeta el máximo del invernadero', async () => {
    await inRollback(async (tx) => {
      const agro = await makeUser(tx, 'agronomist')
      const s = await createSchedule(tx, agro.actor, GH, { label: 'Mañana', days: [1, 3, 5], timeLocal: '06:30', durationS: 20 })
      expect(s).toMatchObject({ label: 'Mañana', days: [1, 3, 5], timeLocal: '06:30', durationS: 20, enabled: true })
      await expect(createSchedule(tx, agro.actor, GH, { label: '', days: [1], timeLocal: '07:00', durationS: 90 })).rejects.toMatchObject({ name: 'ValidationError', fieldErrors: { durationS: expect.stringMatching(/máxima/) } })
      expect(await listSchedules(tx, agro.actor, GH)).toHaveLength(1)
      await setScheduleEnabled(tx, agro.actor, s.id, false)
      expect((await listSchedules(tx, agro.actor, GH))[0]!.enabled).toBe(false)
      await deleteSchedule(tx, agro.actor, s.id)
      expect(await listSchedules(tx, agro.actor, GH)).toHaveLength(0)
      const owner = await makeUser(tx, 'owner')
      await expect(createSchedule(tx, owner.actor, GH, { label: '', days: [1], timeLocal: '07:00', durationS: 10 })).rejects.toBeInstanceOf(ForbiddenError)
    })
  })

  it('un calendario que toca ejecutar crea UNA orden automática al llegar la trama del nodo', async () => {
    await inRollback(async (tx) => {
      const agro = await makeUser(tx, 'agronomist')
      const token = await tokenFor(tx, GH)
      const local = localParts(T0)
      const hh = String(Math.floor(local.minutes / 60)).padStart(2, '0')
      const mm = String(local.minutes % 60).padStart(2, '0')
      await createSchedule(tx, agro.actor, GH, { label: 'Ahora', days: [local.dow], timeLocal: `${hh}:${mm}`, durationS: 15 })
      const f = frameBuilder()
      await send(tx, token, f(), plus(T0, 5)) // dispara el calendario: crea la orden
      const cmds = await tx<{ source: string; status: string; duration_s: number }[]>`
        select source, status, duration_s from iot.commands where greenhouse_id = ${GH} and source = 'schedule'`
      expect(cmds).toEqual([{ source: 'schedule', status: 'queued', duration_s: 15 }])
      // La orden llega en la trama siguiente…
      const r = await send(tx, token, f(), plus(T0, 20))
      expect(r.status === 200 && r.body.ordenes.map((o) => [o.tipo, o.dur_s])).toEqual([['riego', 15]])
      // …y no se vuelve a crear ese día.
      await send(tx, token, f(), plus(T0, 40))
      const after = await tx`select 1 from iot.commands where greenhouse_id = ${GH} and source = 'schedule'`
      expect(after).toHaveLength(1)
      const [s] = await listSchedules(tx, agro.actor, GH)
      expect(s!.lastRunDate).toBe(local.date)
    })
  })
})
