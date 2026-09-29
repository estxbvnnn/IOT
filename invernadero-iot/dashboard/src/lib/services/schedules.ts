import { z } from 'zod'
import type { Db } from '../db/types'
import { type Actor, assertCanOnGreenhouse } from '../rbac'
import { audit } from './audit'
import { ValidationError } from './thresholds'

/**
 * Calendarios de riego que programa el agrónomo (informe, tabla 11: «programar calendarios de riego»).
 * No hay un proceso aparte: cada calendario se evalúa cuando llega una trama del nodo del invernadero
 * (ver ingest), y crea una orden `queued` con origen `schedule`. Por eso no necesita cron ni worker.
 */

export const SITE_TZ = 'America/Santiago'
/** Un calendario vencido hace más de esto ya no se ejecuta (p. ej. el nodo estuvo apagado). */
export const SCHEDULE_GRACE_MIN = 30

export const DAY_LABELS = ['dom', 'lun', 'mar', 'mié', 'jue', 'vie', 'sáb'] as const

export interface ScheduleDTO {
  id: string
  greenhouseId: number
  label: string
  /** 0 = domingo … 6 = sábado */
  days: number[]
  /** HH:MM en hora local del predio */
  timeLocal: string
  durationS: number
  enabled: boolean
  lastRunDate: string | null
}

export interface LocalParts {
  /** YYYY-MM-DD en la zona horaria del predio */
  date: string
  /** 0 = domingo … 6 = sábado */
  dow: number
  /** minutos desde la medianoche local */
  minutes: number
}

const WEEKDAYS: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }

export function localParts(d: Date, tz: string = SITE_TZ): LocalParts {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
    hourCycle: 'h23', weekday: 'short',
  }).formatToParts(d)
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? ''
  return {
    date: `${get('year')}-${get('month')}-${get('day')}`,
    dow: WEEKDAYS[get('weekday')] ?? 0,
    minutes: Number(get('hour')) * 60 + Number(get('minute')),
  }
}

export function parseTimeLocal(t: string): number {
  const m = /^(\d{2}):(\d{2})/.exec(t)
  if (!m) return NaN
  return Number(m[1]) * 60 + Number(m[2])
}

export interface DueCheck {
  enabled: boolean
  days: readonly number[]
  timeLocal: string
  lastRunDate: string | null
}

/** ¿Corresponde ejecutar el calendario ahora? Una vez por día, dentro de la ventana de gracia. */
export function isScheduleDue(s: DueCheck, now: Date, tz: string = SITE_TZ): boolean {
  if (!s.enabled) return false
  const local = localParts(now, tz)
  if (!s.days.includes(local.dow)) return false
  if (s.lastRunDate === local.date) return false
  const at = parseTimeLocal(s.timeLocal)
  if (Number.isNaN(at)) return false
  const late = local.minutes - at
  return late >= 0 && late < SCHEDULE_GRACE_MIN
}

export const scheduleInputSchema = z.object({
  label: z.string().trim().max(60).default(''),
  days: z.array(z.number().int().min(0).max(6)).min(1, 'Elige al menos un día.').max(7)
    .transform((d) => [...new Set(d)].sort((a, b) => a - b)),
  timeLocal: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Hora inválida (usa HH:MM).'),
  durationS: z.number().int().min(5, 'Mínimo 5 segundos.').max(120, 'Máximo 120 segundos.'),
})
export type ScheduleInput = z.infer<typeof scheduleInputSchema>

interface ScheduleRow {
  id: string
  greenhouse_id: number
  label: string
  days: number[]
  time_local: string
  duration_s: number
  enabled: boolean
  last_run_date: Date | string | null
}

const dateStr = (v: Date | string | null): string | null =>
  v === null ? null : typeof v === 'string' ? v.slice(0, 10) : v.toISOString().slice(0, 10)

export const toScheduleDTO = (r: ScheduleRow): ScheduleDTO => ({
  id: r.id, greenhouseId: r.greenhouse_id, label: r.label, days: [...r.days].map(Number),
  timeLocal: r.time_local.slice(0, 5), durationS: r.duration_s, enabled: r.enabled, lastRunDate: dateStr(r.last_run_date),
})

export async function listSchedules(db: Db, actor: Actor, greenhouseId: number): Promise<ScheduleDTO[]> {
  assertCanOnGreenhouse(actor, 'greenhouse:view', greenhouseId)
  const rows = await db<ScheduleRow[]>`
    select id, greenhouse_id, label, days, time_local::text as time_local, duration_s, enabled, last_run_date::text as last_run_date
      from iot.schedules where greenhouse_id = ${greenhouseId} order by time_local, created_at`
  return rows.map(toScheduleDTO)
}

export async function createSchedule(db: Db, actor: Actor, greenhouseId: number, input: ScheduleInput, ip: string | null = null): Promise<ScheduleDTO> {
  assertCanOnGreenhouse(actor, 'schedules:edit', greenhouseId)
  const [t] = await db<{ pump_max_s: number }[]>`select pump_max_s from iot.thresholds where greenhouse_id = ${greenhouseId}`
  if (!t) throw new ValidationError({}, 'Invernadero no encontrado.')
  if (input.durationS > t.pump_max_s) {
    const msg = `La duración máxima configurada para este invernadero es ${t.pump_max_s} s.`
    throw new ValidationError({ durationS: msg }, msg)
  }
  const [row] = await db<ScheduleRow[]>`
    insert into iot.schedules (greenhouse_id, label, days, time_local, duration_s, created_by)
    values (${greenhouseId}, ${input.label}, ${db.array(input.days, 21)}, ${input.timeLocal}::time, ${input.durationS}, ${actor.id})
    returning id, greenhouse_id, label, days, time_local::text as time_local, duration_s, enabled, last_run_date::text as last_run_date`
  await audit(db, {
    actorId: actor.id, actorLabel: actor.email, actorRole: actor.role, action: 'schedule.create',
    target: `greenhouse:${greenhouseId}`, detail: { scheduleId: row!.id, days: input.days, timeLocal: input.timeLocal, durationS: input.durationS }, ip,
  })
  return toScheduleDTO(row!)
}

export async function setScheduleEnabled(db: Db, actor: Actor, scheduleId: string, enabled: boolean, ip: string | null = null): Promise<void> {
  const [s] = await db<{ greenhouse_id: number }[]>`select greenhouse_id from iot.schedules where id = ${scheduleId}`
  if (!s) throw new ValidationError({}, 'Calendario no encontrado.')
  assertCanOnGreenhouse(actor, 'schedules:edit', s.greenhouse_id)
  await db`update iot.schedules set enabled = ${enabled} where id = ${scheduleId}`
  await audit(db, {
    actorId: actor.id, actorLabel: actor.email, actorRole: actor.role, action: 'schedule.update',
    target: `greenhouse:${s.greenhouse_id}`, detail: { scheduleId, enabled }, ip,
  })
}

export async function deleteSchedule(db: Db, actor: Actor, scheduleId: string, ip: string | null = null): Promise<void> {
  const [s] = await db<{ greenhouse_id: number }[]>`select greenhouse_id from iot.schedules where id = ${scheduleId}`
  if (!s) throw new ValidationError({}, 'Calendario no encontrado.')
  assertCanOnGreenhouse(actor, 'schedules:edit', s.greenhouse_id)
  await db`delete from iot.schedules where id = ${scheduleId}`
  await audit(db, {
    actorId: actor.id, actorLabel: actor.email, actorRole: actor.role, action: 'schedule.delete',
    target: `greenhouse:${s.greenhouse_id}`, detail: { scheduleId }, ip,
  })
}

