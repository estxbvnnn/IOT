'use server'

import { refresh } from 'next/cache'
import { z } from 'zod'
import { type ActionResult, fail, run } from '@/lib/actions/result'
import { getDb } from '@/lib/db'
import { getRequestMeta, requireUser } from '@/lib/dal'
import type { ThresholdsDTO } from '@/lib/domain/types'
import { acknowledgeAlert } from '@/lib/services/alerts'
import {
  type CommandDTO, MANUAL_MAX_S, MANUAL_MIN_S, cancelCommand, confirmIrrigation, requestIrrigation, requestStop,
} from '@/lib/services/commands'
import {
  type ScheduleDTO, createSchedule, deleteSchedule, scheduleInputSchema, setScheduleEnabled,
} from '@/lib/services/schedules'
import { thresholdsPatchSchema, updateThresholds } from '@/lib/services/thresholds'

/**
 * Operación diaria: riego manual (2 pasos), umbrales, calendarios y alertas.
 * Cada acción vuelve a verificar la sesión y el permiso: las acciones del servidor se pueden invocar
 * directamente con un POST, aunque la interfaz no muestre el botón.
 */

const ghId = z.number().int().min(1).max(32767) // smallint: la cantidad de invernaderos ya no tiene un tope fijo
const uuid = z.uuid()

export async function requestIrrigationAction(input: { greenhouseId: number; durationS: number }): Promise<ActionResult<CommandDTO>> {
  const user = await requireUser()
  const p = z.object({ greenhouseId: ghId, durationS: z.number().int().min(MANUAL_MIN_S).max(MANUAL_MAX_S) }).safeParse(input)
  if (!p.success) return fail('Datos inválidos.')
  const meta = await getRequestMeta()
  const res = await run(() => requestIrrigation(getDb(), user, { ...p.data, ip: meta.ip }))
  if (res.ok) refresh()
  return res
}

export async function confirmIrrigationAction(input: { commandId: string; password: string }): Promise<ActionResult<CommandDTO>> {
  const user = await requireUser()
  const p = z.object({ commandId: uuid, password: z.string().min(1).max(256) }).safeParse(input)
  if (!p.success) return fail('Ingresa tu contraseña para confirmar.')
  const meta = await getRequestMeta()
  const res = await run(() => confirmIrrigation(getDb(), user, { ...p.data, ip: meta.ip }))
  if (res.ok) refresh()
  return res
}

export async function cancelCommandAction(commandId: string): Promise<ActionResult<CommandDTO>> {
  const user = await requireUser()
  if (!uuid.safeParse(commandId).success) return fail('Orden inválida.')
  const meta = await getRequestMeta()
  const res = await run(() => cancelCommand(getDb(), user, commandId, meta.ip))
  if (res.ok) refresh()
  return res
}

export async function stopPumpAction(greenhouseId: number): Promise<ActionResult<CommandDTO>> {
  const user = await requireUser()
  if (!ghId.safeParse(greenhouseId).success) return fail('Invernadero inválido.')
  const meta = await getRequestMeta()
  const res = await run(() => requestStop(getDb(), user, { greenhouseId, ip: meta.ip }))
  if (res.ok) refresh()
  return res
}

export async function updateThresholdsAction(greenhouseId: number, patch: unknown): Promise<ActionResult<ThresholdsDTO>> {
  const user = await requireUser()
  const g = ghId.safeParse(greenhouseId)
  const p = thresholdsPatchSchema.safeParse(patch)
  if (!g.success || !p.success) return fail('Datos inválidos.')
  const meta = await getRequestMeta()
  const res = await run(() => updateThresholds(getDb(), user, g.data, p.data, meta.ip))
  if (res.ok) refresh()
  return res
}

/** Activa o desactiva el riego AUTOMÁTICO del invernadero (permiso thresholds:edit). Lo manual no se toca. */
export async function setAutoIrrigationAction(greenhouseId: number, enabled: boolean): Promise<ActionResult<boolean>> {
  const user = await requireUser()
  const g = ghId.safeParse(greenhouseId)
  if (!g.success || typeof enabled !== 'boolean') return fail('Datos inválidos.')
  const meta = await getRequestMeta()
  const res = await run(async () => (await updateThresholds(getDb(), user, g.data, { autoEnabled: enabled }, meta.ip)).autoEnabled)
  if (res.ok) refresh()
  return res
}

export async function createScheduleAction(greenhouseId: number, input: unknown): Promise<ActionResult<ScheduleDTO>> {
  const user = await requireUser()
  const g = ghId.safeParse(greenhouseId)
  const p = scheduleInputSchema.safeParse(input)
  if (!g.success) return fail('Invernadero inválido.')
  if (!p.success) return fail('Revisa el calendario.', Object.fromEntries(p.error.issues.map((i) => [String(i.path[0]), i.message])))
  const meta = await getRequestMeta()
  const res = await run(() => createSchedule(getDb(), user, g.data, p.data, meta.ip))
  if (res.ok) refresh()
  return res
}

export async function setScheduleEnabledAction(scheduleId: string, enabled: boolean): Promise<ActionResult> {
  const user = await requireUser()
  if (!uuid.safeParse(scheduleId).success) return fail('Calendario inválido.')
  const meta = await getRequestMeta()
  const res = await run(() => setScheduleEnabled(getDb(), user, scheduleId, enabled, meta.ip))
  if (res.ok) refresh()
  return res
}

export async function deleteScheduleAction(scheduleId: string): Promise<ActionResult> {
  const user = await requireUser()
  if (!uuid.safeParse(scheduleId).success) return fail('Calendario inválido.')
  const meta = await getRequestMeta()
  const res = await run(() => deleteSchedule(getDb(), user, scheduleId, meta.ip))
  if (res.ok) refresh()
  return res
}

export async function ackAlertAction(alertId: number): Promise<ActionResult<boolean>> {
  const user = await requireUser()
  if (!Number.isInteger(alertId) || alertId < 1) return fail('Alerta inválida.')
  const meta = await getRequestMeta()
  const res = await run(() => acknowledgeAlert(getDb(), user, alertId, new Date(), meta.ip))
  if (res.ok) refresh()
  return res
}
