'use server'

import { refresh } from 'next/cache'
import { z } from 'zod'
import { type ActionResult, fail, run } from '@/lib/actions/result'
import { getDb } from '@/lib/db'
import { getRequestMeta, requireUser } from '@/lib/dal'
import { ROLES, type Role, assertCan } from '@/lib/rbac'
import { verifyAuditChain, audit } from '@/lib/services/audit'
import { rotateNodeToken, setNodeEnabled } from '@/lib/services/devices'
import {
  type UserDTO, createUser, createUserSchema, resetUserMfa, resetUserPassword, setUserActive, updateUserAccess,
} from '@/lib/services/users'

/** Administración: usuarios, credenciales de los nodos y verificación de la bitácora. */

const uuid = z.uuid()

export async function createUserAction(input: unknown): Promise<ActionResult<{ user: UserDTO; initialPassword: string }>> {
  const admin = await requireUser()
  const meta = await getRequestMeta()
  const res = await run(() => createUser(getDb(), admin, input as z.input<typeof createUserSchema>, meta.ip))
  if (res.ok) refresh()
  return res
}

export async function setUserActiveAction(userId: string, active: boolean): Promise<ActionResult> {
  const admin = await requireUser()
  if (!uuid.safeParse(userId).success) return fail('Usuario inválido.')
  const meta = await getRequestMeta()
  const res = await run(() => setUserActive(getDb(), admin, userId, active, meta.ip))
  if (res.ok) refresh()
  return res
}

/** Devuelve la contraseña nueva UNA sola vez: no se guarda en claro en ningún lado. */
export async function resetUserPasswordAction(userId: string): Promise<ActionResult<{ password: string }>> {
  const admin = await requireUser()
  if (!uuid.safeParse(userId).success) return fail('Usuario inválido.')
  const meta = await getRequestMeta()
  const res = await run(async () => ({ password: await resetUserPassword(getDb(), admin, userId, meta.ip) }))
  if (res.ok) refresh()
  return res
}

export async function resetUserMfaAction(userId: string): Promise<ActionResult> {
  const admin = await requireUser()
  if (!uuid.safeParse(userId).success) return fail('Usuario inválido.')
  const meta = await getRequestMeta()
  const res = await run(() => resetUserMfa(getDb(), admin, userId, meta.ip))
  if (res.ok) refresh()
  return res
}

export async function updateUserAccessAction(userId: string, input: { role: Role; greenhouseIds: number[] }): Promise<ActionResult> {
  const admin = await requireUser()
  const p = z.object({ role: z.enum(ROLES), greenhouseIds: z.array(z.number().int().min(1).max(99)).max(99) }).safeParse(input)
  if (!uuid.safeParse(userId).success || !p.success) return fail('Datos inválidos.')
  const meta = await getRequestMeta()
  const res = await run(() => updateUserAccess(getDb(), admin, userId, p.data, meta.ip))
  if (res.ok) refresh()
  return res
}

/** Rota la credencial de un nodo. El token nuevo se muestra una sola vez; el anterior deja de funcionar al instante. */
export async function rotateNodeTokenAction(nodeId: number): Promise<ActionResult<{ token: string; prefix: string }>> {
  const admin = await requireUser()
  if (!Number.isInteger(nodeId) || nodeId < 1) return fail('Nodo inválido.')
  const meta = await getRequestMeta()
  const res = await run(() => rotateNodeToken(getDb(), admin, nodeId, meta.ip))
  if (res.ok) refresh()
  return res
}

export async function setNodeEnabledAction(nodeId: number, enabled: boolean): Promise<ActionResult> {
  const admin = await requireUser()
  if (!Number.isInteger(nodeId) || nodeId < 1) return fail('Nodo inválido.')
  const meta = await getRequestMeta()
  const res = await run(() => setNodeEnabled(getDb(), admin, nodeId, enabled, meta.ip))
  if (res.ok) refresh()
  return res
}

/** Recorre la cadena de hashes de la bitácora y avisa si algún registro fue alterado. Lo pueden ejecutar quienes leen la bitácora. */
export async function verifyAuditAction(): Promise<ActionResult<{ checked: number; firstBrokenId: number | null }>> {
  const user = await requireUser()
  const meta = await getRequestMeta()
  return run(async () => {
    assertCan(user, 'audit:view')
    const result = await verifyAuditChain(getDb())
    await audit(getDb(), {
      actorId: user.id, actorLabel: user.email, actorRole: user.role, action: 'audit.verify',
      detail: { checked: result.checked, ok: result.firstBrokenId === null, firstBrokenId: result.firstBrokenId }, ip: meta.ip,
    })
    return result
  })
}
