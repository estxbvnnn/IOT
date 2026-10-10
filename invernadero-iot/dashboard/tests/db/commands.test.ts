import { describe, expect, it } from 'vitest'
import {
  CONFIRM_WINDOW_S, CommandError, cancelCommand, confirmIrrigation, getCommand, listCommands, requestIrrigation, requestStop,
} from '@/lib/services/commands'
import { ForbiddenError } from '@/lib/rbac'
import { frameBuilder, inRollback, makeUser, plus, send, T0, tokenFor } from './helpers'

const GH = 4 // I4
const OTHER_GH = 8

const expectCode = async (p: Promise<unknown>, code: string) => {
  await expect(p).rejects.toMatchObject({ name: 'CommandError', code })
}

describe('órdenes de riego manual (confirmación en dos pasos)', () => {
  it('flujo completo: solicitud → confirmación con contraseña → entrega al nodo → acuse → evento de riego', async () => {
    await inRollback(async (tx) => {
      const op = await makeUser(tx, 'operator', { greenhouseIds: [GH] })
      const token = await tokenFor(tx, GH)
      const f = frameBuilder()
      await send(tx, token, f(), T0) // el nodo está en línea

      // Paso 1: solo queda registrada la solicitud; la bomba NO se acciona todavía.
      const req = await requestIrrigation(tx, op.actor, { greenhouseId: GH, durationS: 20 }, plus(T0, 5))
      expect(req).toMatchObject({ status: 'awaiting_confirmation', type: 'irrigate', durationS: 20, greenhouseCode: 'I4' })
      const r1 = await send(tx, token, f(), plus(T0, 10))
      expect(r1.status === 200 && r1.body.ordenes).toEqual([])

      // Paso 2 con contraseña equivocada: se rechaza y sigue pendiente.
      await expectCode(confirmIrrigation(tx, op.actor, { commandId: req.id, password: 'incorrecta-123456' }, plus(T0, 12)), 'auth')
      expect((await getCommand(tx, op.actor, req.id)).status).toBe('awaiting_confirmation')

      // Paso 2 correcto.
      const conf = await confirmIrrigation(tx, op.actor, { commandId: req.id, password: op.password }, plus(T0, 15))
      expect(conf).toMatchObject({ status: 'queued', confirmedBy: expect.any(String) })
      // Vence en ≥ 2 intervalos de reporte (2 × 300 s = 600 s).
      expect((new Date(conf.expiresAt!).getTime() - plus(T0, 15).getTime()) / 1000).toBe(600)

      // El nodo la retira en su próxima trama (y queda «delivered»).
      const r2 = await send(tx, token, f(), plus(T0, 20))
      expect(r2.status).toBe(200)
      if (r2.status !== 200) return
      expect(r2.body.ordenes).toEqual([{ id: req.id, tipo: 'riego', dur_s: 20, vence_s: 595 }])
      expect((await getCommand(tx, op.actor, req.id)).status).toBe('delivered')

      // Si el nodo no acusa, el servidor la reentrega (respuesta perdida).
      const r3 = await send(tx, token, f(), plus(T0, 30))
      expect(r3.status === 200 && r3.body.ordenes.map((o) => o.id)).toEqual([req.id])

      // El nodo ejecuta y acusa en una trama inmediata con el evento de la bomba.
      await send(tx, token, f({
        bomba: 1, est: 'riego', riego_s: 1,
        ev: [{ t: 'pump_on', why: 'manual', ago: 1, cmd: req.id }],
        acks: [{ id: req.id, estado: 'ejecutada', detalle: 'regando 20 s' }],
      }), plus(T0, 40))
      const done = await getCommand(tx, op.actor, req.id)
      expect(done).toMatchObject({ status: 'executed', resultDetail: 'regando 20 s' })
      expect(done.ackedAt).not.toBeNull()
      const [ev] = await tx<{ trigger: string; command_id: string }[]>`
        select trigger, command_id from iot.irrigation_events where greenhouse_id = ${GH} and ended_at is null`
      expect(ev).toMatchObject({ trigger: 'manual', command_id: req.id })

      // Ya no se entrega más.
      const r4 = await send(tx, token, f({ bomba: 1, est: 'riego', riego_s: 11 }), plus(T0, 50))
      expect(r4.status === 200 && r4.body.ordenes).toEqual([])

      // Rastro completo en la bitácora, en orden.
      const acts = await tx<{ action: string }[]>`
        select action from iot.audit_log where detail->>'commandId' = ${req.id} order by id`
      expect(acts.map((a) => a.action)).toEqual(['command.request', 'command.confirm_failed', 'command.confirm', 'command.delivered', 'command.ack'])
    })
  })

  it('el nodo puede rechazar la orden (p. ej. en espera entre riegos) y el motivo queda visible', async () => {
    await inRollback(async (tx) => {
      const op = await makeUser(tx, 'operator', { greenhouseIds: [GH] })
      const token = await tokenFor(tx, GH)
      const f = frameBuilder()
      await send(tx, token, f(), T0)
      const req = await requestIrrigation(tx, op.actor, { greenhouseId: GH, durationS: 10 }, plus(T0, 2))
      await confirmIrrigation(tx, op.actor, { commandId: req.id, password: op.password }, plus(T0, 3))
      await send(tx, token, f(), plus(T0, 10))
      await send(tx, token, f({ acks: [{ id: req.id, estado: 'rechazada', detalle: 'en espera entre riegos (faltan 240 s)' }] }), plus(T0, 20))
      expect(await getCommand(tx, op.actor, req.id)).toMatchObject({ status: 'rejected', resultDetail: 'en espera entre riegos (faltan 240 s)' })
    })
  })

  it('un nodo NO puede acusar órdenes de otro nodo', async () => {
    await inRollback(async (tx) => {
      const op = await makeUser(tx, 'operator', { greenhouseIds: [GH] })
      const tokenA = await tokenFor(tx, GH)
      const tokenB = await tokenFor(tx, OTHER_GH)
      const a = frameBuilder(), b = frameBuilder()
      await send(tx, tokenA, a(), T0)
      const req = await requestIrrigation(tx, op.actor, { greenhouseId: GH, durationS: 10 }, plus(T0, 2))
      await confirmIrrigation(tx, op.actor, { commandId: req.id, password: op.password }, plus(T0, 3))
      await send(tx, tokenA, a(), plus(T0, 10)) // delivered
      await send(tx, tokenB, b({ acks: [{ id: req.id, estado: 'ejecutada', detalle: 'intruso' }] }), plus(T0, 12))
      expect((await getCommand(tx, op.actor, req.id)).status).toBe('delivered')
    })
  })

  it('una orden confirmada que el nodo no retira a tiempo vence y deja de entregarse', async () => {
    await inRollback(async (tx) => {
      const op = await makeUser(tx, 'operator', { greenhouseIds: [GH] })
      const token = await tokenFor(tx, GH)
      const f = frameBuilder()
      await send(tx, token, f(), T0)
      const req = await requestIrrigation(tx, op.actor, { greenhouseId: GH, durationS: 10 }, plus(T0, 2))
      await confirmIrrigation(tx, op.actor, { commandId: req.id, password: op.password }, plus(T0, 3))
      const late = await send(tx, token, f(), plus(T0, 3 + 601)) // pasada la ventana de 600 s
      expect(late.status === 200 && late.body.ordenes).toEqual([])
      expect((await getCommand(tx, op.actor, req.id)).status).toBe('expired')
    })
  })
})

describe('órdenes: permisos, alcance y reglas', () => {
  it('solo el operador (en sus sectores) y el administrador pueden accionar el riego', async () => {
    await inRollback(async (tx) => {
      for (const role of ['owner', 'agronomist', 'technician'] as const) {
        const u = await makeUser(tx, role)
        await expect(requestIrrigation(tx, u.actor, { greenhouseId: GH, durationS: 10 })).rejects.toBeInstanceOf(ForbiddenError)
      }
      const opAjeno = await makeUser(tx, 'operator', { greenhouseIds: [OTHER_GH] })
      await expect(requestIrrigation(tx, opAjeno.actor, { greenhouseId: GH, durationS: 10 })).rejects.toBeInstanceOf(ForbiddenError)
      const sinSectores = await makeUser(tx, 'operator')
      await expect(requestIrrigation(tx, sinSectores.actor, { greenhouseId: GH, durationS: 10 })).rejects.toBeInstanceOf(ForbiddenError)
      const admin = await makeUser(tx, 'admin')
      await expect(requestIrrigation(tx, admin.actor, { greenhouseId: GH, durationS: 10 })).resolves.toMatchObject({ status: 'awaiting_confirmation' })
    })
  })

  it('valida la duración (5–120 s y no más que el máximo del invernadero, 30 s)', async () => {
    await inRollback(async (tx) => {
      const op = await makeUser(tx, 'operator', { greenhouseIds: [GH] })
      for (const bad of [0, 4, 121, 10.5, -3]) await expectCode(requestIrrigation(tx, op.actor, { greenhouseId: GH, durationS: bad }), 'invalid')
      await expect(requestIrrigation(tx, op.actor, { greenhouseId: GH, durationS: 45 })).rejects.toMatchObject({ code: 'invalid', message: expect.stringMatching(/máximo.*30 s/) })
      await expect(requestIrrigation(tx, op.actor, { greenhouseId: GH, durationS: 30 })).resolves.toBeDefined()
    })
  })

  it('el súper administrador riega sin confirmar, sin tope del invernadero y reemplazando órdenes pendientes', async () => {
    await inRollback(async (tx) => {
      const op = await makeUser(tx, 'operator', { greenhouseIds: [GH] })
      const root = await makeUser(tx, 'superadmin')
      const pending = await requestIrrigation(tx, op.actor, { greenhouseId: GH, durationS: 10 }, T0)
      // 45 s supera el máximo del invernadero (30 s) y hay una orden pendiente: al súper admin no le afecta.
      const req = await requestIrrigation(tx, root.actor, { greenhouseId: GH, durationS: 45 }, plus(T0, 1))
      expect(req).toMatchObject({ status: 'queued', durationS: 45, confirmedBy: expect.any(String) })
      expect((await getCommand(tx, op.actor, pending.id)).status).toBe('cancelled')
      // Y todo sigue quedando en la bitácora.
      const [a] = await tx<{ action: string; detail: { bypass?: boolean } }[]>`
        select action, detail from iot.audit_log where detail->>'commandId' = ${req.id}`
      expect(a).toMatchObject({ action: 'command.request', detail: { sinConfirmacion: true } })
    })
  })

  it('una sola orden activa por invernadero; cancelar libera; el otro usuario no puede confirmar', async () => {
    await inRollback(async (tx) => {
      const op = await makeUser(tx, 'operator', { greenhouseIds: [GH] })
      const otro = await makeUser(tx, 'operator', { greenhouseIds: [GH] })
      const first = await requestIrrigation(tx, op.actor, { greenhouseId: GH, durationS: 10 }, T0)
      await expectCode(requestIrrigation(tx, otro.actor, { greenhouseId: GH, durationS: 10 }, plus(T0, 1)), 'busy')
      await expectCode(confirmIrrigation(tx, otro.actor, { commandId: first.id, password: otro.password }, plus(T0, 2)), 'forbidden')
      await expect(cancelCommand(tx, op.actor, first.id)).resolves.toMatchObject({ status: 'cancelled' })
      await expectCode(cancelCommand(tx, op.actor, first.id), 'invalid') // ya cancelada
      await expect(requestIrrigation(tx, otro.actor, { greenhouseId: GH, durationS: 10 }, plus(T0, 3))).resolves.toBeDefined()
    })
  })

  it('la confirmación vence a los 60 s: hay que solicitar de nuevo', async () => {
    await inRollback(async (tx) => {
      const op = await makeUser(tx, 'operator', { greenhouseIds: [GH] })
      const req = await requestIrrigation(tx, op.actor, { greenhouseId: GH, durationS: 10 }, T0)
      expect(req.confirmExpiresAt).toBe(plus(T0, CONFIRM_WINDOW_S).toISOString())
      await expectCode(confirmIrrigation(tx, op.actor, { commandId: req.id, password: op.password }, plus(T0, CONFIRM_WINDOW_S + 1)), 'expired')
      expect((await getCommand(tx, op.actor, req.id)).status).toBe('expired')
    })
  })

  it('tras 5 contraseñas erróneas al confirmar, la cuenta se bloquea temporalmente', async () => {
    await inRollback(async (tx) => {
      const op = await makeUser(tx, 'operator', { greenhouseIds: [GH] })
      const req = await requestIrrigation(tx, op.actor, { greenhouseId: GH, durationS: 10 }, T0)
      for (let i = 0; i < 5; i++) await expectCode(confirmIrrigation(tx, op.actor, { commandId: req.id, password: `mala-clave-${i}-xxxx` }, plus(T0, 1 + i)), 'auth')
      await expectCode(confirmIrrigation(tx, op.actor, { commandId: req.id, password: op.password }, plus(T0, 10)), 'locked')
    })
  })

  it('«detener» es de un solo paso, reemplaza órdenes de riego pendientes y llega al nodo como «parar»', async () => {
    await inRollback(async (tx) => {
      const op = await makeUser(tx, 'operator', { greenhouseIds: [GH] })
      const token = await tokenFor(tx, GH)
      const f = frameBuilder()
      await send(tx, token, f({ bomba: 1, est: 'riego' }), T0)
      const pending = await requestIrrigation(tx, op.actor, { greenhouseId: GH, durationS: 20 }, plus(T0, 2))
      const stop = await requestStop(tx, op.actor, { greenhouseId: GH }, plus(T0, 5))
      expect(stop).toMatchObject({ type: 'stop', status: 'queued', durationS: null })
      expect((await getCommand(tx, op.actor, pending.id)).status).toBe('cancelled')
      const r = await send(tx, token, f({ bomba: 1, est: 'riego' }), plus(T0, 10))
      expect(r.status === 200 && r.body.ordenes).toEqual([{ id: stop.id, tipo: 'parar', vence_s: 595 }])
    })
  })

  it('el historial de órdenes respeta el alcance del usuario', async () => {
    await inRollback(async (tx) => {
      const op = await makeUser(tx, 'operator', { greenhouseIds: [GH] })
      await requestIrrigation(tx, op.actor, { greenhouseId: GH, durationS: 10 }, T0)
      expect((await listCommands(tx, op.actor, GH)).length).toBeGreaterThanOrEqual(1)
      await expect(listCommands(tx, op.actor, OTHER_GH)).rejects.toBeInstanceOf(ForbiddenError)
      const owner = await makeUser(tx, 'owner')
      await expect(listCommands(tx, owner.actor, GH)).resolves.toBeDefined() // ver el historial es solo lectura
    })
  })

  it('es un CommandError tipado (la interfaz distingue el motivo)', async () => {
    await inRollback(async (tx) => {
      const op = await makeUser(tx, 'operator', { greenhouseIds: [GH] })
      const err = await confirmIrrigation(tx, op.actor, { commandId: '00000000-0000-4000-8000-000000000000', password: 'x' }).catch((e) => e)
      expect(err).toBeInstanceOf(CommandError)
      expect(err.code).toBe('not_found')
    })
  })
})
