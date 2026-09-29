'use client'

import { CalendarClock, Loader2, Pause, Play, Plus, Trash2 } from 'lucide-react'
import { useId, useState } from 'react'
import { createScheduleAction, deleteScheduleAction, setScheduleEnabledAction } from '@/app/actions/operations'
import { Card, EmptyState } from '@/components/ui/card'
import { Chip } from '@/components/ui/status'
import { cn } from '@/lib/cn'
import type { ScheduleDTO } from '@/lib/services/schedules'

/**
 * Calendarios de riego (informe, tabla 11: el agrónomo «programa calendarios de riego»). No hay un proceso
 * aparte: cada calendario se evalúa cuando llega una trama del nodo y crea una orden con origen «calendario».
 * (Los nombres de los días se repiten aquí y no se importan del servicio para no llevar código de servidor al navegador.)
 */

export interface SchedulesPanelProps {
  greenhouseId: number
  schedules: ScheduleDTO[]
  /** El usuario tiene permiso schedules:edit. */
  canEdit: boolean
  /** Duración máxima de riego configurada para el invernadero (s). */
  pumpMaxS: number
}

const DAY_SHORT = ['dom', 'lun', 'mar', 'mié', 'jue', 'vie', 'sáb'] as const
const DAY_LONG = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'] as const
/** Semana que empieza en lunes (0 = domingo en los datos). */
const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0] as const

const dmy = (iso: string) => {
  const [y, m, d] = iso.split('-')
  return y && m && d ? `${d}-${m}-${y}` : iso
}

type FieldKey = 'label' | 'days' | 'timeLocal' | 'durationS'

function DayChips({ days }: { days: readonly number[] }) {
  return (
    <ul className="flex flex-wrap gap-1" aria-label={`Días: ${days.map((d) => DAY_LONG[d]).join(', ')}`}>
      {WEEK_ORDER.map((d) => {
        const on = days.includes(d)
        return (
          <li
            key={d}
            className={cn('inline-flex h-6 min-w-[34px] items-center justify-center rounded-md px-1.5 text-[11.5px] font-semibold',
              on ? 'bg-accent-wash text-ink ring-1 ring-inset ring-accent' : 'bg-surface-2 text-ink-3')}
            aria-hidden
          >
            {DAY_SHORT[d]}
          </li>
        )
      })}
    </ul>
  )
}

export function SchedulesPanel({ greenhouseId, schedules, canEdit, pumpMaxS }: SchedulesPanelProps) {
  const uid = useId()
  const [pendingId, setPendingId] = useState<string | null>(null)
  const [confirmId, setConfirmId] = useState<string | null>(null)
  const [rowError, setRowError] = useState<string | null>(null)

  const [label, setLabel] = useState('')
  const [days, setDays] = useState<number[]>([])
  const [time, setTime] = useState('06:00')
  const [duration, setDuration] = useState(String(Math.min(20, pumpMaxS)))
  const [errors, setErrors] = useState<Partial<Record<FieldKey, string>>>({})
  const [formError, setFormError] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const sorted = [...schedules].sort((a, b) => a.timeLocal.localeCompare(b.timeLocal))

  const toggleEnabled = async (s: ScheduleDTO) => {
    setPendingId(s.id)
    setRowError(null)
    const res = await setScheduleEnabledAction(s.id, !s.enabled)
    setPendingId(null)
    if (!res.ok) setRowError(res.error)
  }

  const remove = async (s: ScheduleDTO) => {
    setPendingId(s.id)
    setRowError(null)
    const res = await deleteScheduleAction(s.id)
    setPendingId(null)
    setConfirmId(null)
    if (!res.ok) setRowError(res.error)
  }

  const toggleDay = (d: number) => {
    setDays((cur) => (cur.includes(d) ? cur.filter((x) => x !== d) : [...cur, d]))
    setErrors((e) => ({ ...e, days: undefined }))
    setMessage(null)
  }

  const onAdd = async (e: React.FormEvent) => {
    e.preventDefault()
    if (busy) return
    setMessage(null)
    setFormError(null)
    const errs: Partial<Record<FieldKey, string>> = {}
    const dur = Number(duration.trim())
    if (days.length === 0) errs.days = 'Elige al menos un día.'
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) errs.timeLocal = 'Hora inválida (usa HH:MM).'
    if (!/^\d+$/.test(duration.trim()) || dur < 5 || dur > pumpMaxS) errs.durationS = `Ingresa un entero entre 5 y ${pumpMaxS} s.`
    setErrors(errs)
    if (Object.keys(errs).length > 0) return

    setBusy(true)
    const res = await createScheduleAction(greenhouseId, { label: label.trim(), days, timeLocal: time, durationS: dur })
    setBusy(false)
    if (res.ok) {
      setLabel('')
      setDays([])
      setErrors({})
      setMessage('Calendario agregado.')
      return
    }
    const fe: Partial<Record<FieldKey, string>> = {}
    for (const [k, v] of Object.entries(res.fieldErrors ?? {})) if (['label', 'days', 'timeLocal', 'durationS'].includes(k)) fe[k as FieldKey] = v
    setErrors(fe)
    setFormError(res.error)
  }

  return (
    <Card
      id="calendarios"
      title="Calendarios de riego"
      description="Riego programado por el agrónomo, en hora del predio (America/Santiago)."
    >
      <div className="flex flex-col gap-4">
        {sorted.length === 0 ? (
          <EmptyState icon={CalendarClock} title="Sin calendarios programados">
            {canEdit ? 'Agrega uno abajo para regar a una hora fija, además del riego automático por humedad.' : 'El agrónomo aún no programó riegos para este invernadero.'}
          </EmptyState>
        ) : (
          <ul className="flex flex-col gap-2.5">
            {sorted.map((s) => {
              const pending = pendingId === s.id
              return (
                <li key={s.id} className="rounded-xl border border-line p-3">
                  <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-[14px] font-semibold text-ink">{s.timeLocal}</span>
                        <span className="text-[13px] text-ink-2">· {s.durationS} s</span>
                        {s.label && <span className="truncate text-[13px] text-ink-2">· {s.label}</span>}
                      </div>
                      <div className="mt-1.5"><DayChips days={s.days} /></div>
                      <div className="mt-1.5 text-[12px] text-ink-3">{s.lastRunDate ? `Última ejecución: ${dmy(s.lastRunDate)}` : 'Aún no se ha ejecutado'}</div>
                    </div>
                    <div className="flex items-center gap-2">
                      {s.enabled ? <Chip tone="good" icon={Play}>Activo</Chip> : <Chip tone="off" icon={Pause}>Pausado</Chip>}
                      {canEdit && (
                        <>
                          <button
                            type="button" role="switch" aria-checked={s.enabled} disabled={pending}
                            aria-label={`Calendario de las ${s.timeLocal}: ${s.enabled ? 'activo, pulsa para pausar' : 'pausado, pulsa para activar'}`}
                            onClick={() => void toggleEnabled(s)}
                            className={cn('relative inline-flex h-6 w-11 shrink-0 items-center rounded-full border transition-colors disabled:opacity-50',
                              s.enabled ? 'border-transparent bg-accent-btn' : 'border-line-strong bg-surface-2')}
                          >
                            <span className={cn('inline-block h-[18px] w-[18px] rounded-full bg-white shadow transition-transform', s.enabled ? 'translate-x-[22px]' : 'translate-x-[3px]')} />
                          </button>
                          {confirmId === s.id ? (
                            <span className="flex items-center gap-1.5 text-[12.5px] text-ink">
                              ¿Borrar?
                              <button type="button" className="btn btn-danger btn-sm" disabled={pending} onClick={() => void remove(s)}>
                                {pending && <Loader2 size={13} className="motion-safe:animate-spin" aria-hidden />}
                                Sí, borrar
                              </button>
                              <button type="button" className="btn btn-ghost btn-sm" disabled={pending} onClick={() => setConfirmId(null)}>No</button>
                            </span>
                          ) : (
                            <button type="button" className="btn btn-ghost btn-sm" disabled={pending} onClick={() => setConfirmId(s.id)} aria-label={`Borrar el calendario de las ${s.timeLocal}`}>
                              <Trash2 size={15} aria-hidden />
                            </button>
                          )}
                        </>
                      )}
                    </div>
                  </div>
                </li>
              )
            })}
          </ul>
        )}
        {rowError && <p role="alert" className="rounded-lg bg-crit-wash px-3 py-2 text-[13px] text-ink">{rowError}</p>}

        {canEdit ? (
          <form onSubmit={(e) => void onAdd(e)} className="flex flex-col gap-3 rounded-xl border border-line bg-surface-2 p-3.5" noValidate>
            <h3 className="text-[13.5px] font-semibold text-ink">Agregar calendario</h3>
            <fieldset disabled={busy} className="min-w-0">
              <legend className="label">Días de la semana</legend>
              <div className="flex flex-wrap gap-1.5" aria-describedby={errors.days ? `${uid}-days-err` : undefined}>
                {WEEK_ORDER.map((d) => {
                  const on = days.includes(d)
                  return (
                    <button
                      key={d} type="button" aria-pressed={on} aria-label={DAY_LONG[d]} onClick={() => toggleDay(d)}
                      className={cn('inline-flex h-9 min-w-[46px] items-center justify-center rounded-lg border px-2 text-[12.5px] font-semibold transition-colors',
                        on ? 'border-transparent bg-accent-btn text-white' : 'border-line-strong bg-surface text-ink hover:bg-surface-2')}
                    >
                      {DAY_SHORT[d]}
                    </button>
                  )
                })}
              </div>
              {errors.days && <p id={`${uid}-days-err`} className="field-error" role="alert">{errors.days}</p>}
            </fieldset>

            <div className="grid gap-3 sm:grid-cols-3">
              <div>
                <label htmlFor={`${uid}-time`} className="label">Hora</label>
                <input id={`${uid}-time`} type="time" className="input" value={time} onChange={(e) => { setTime(e.target.value); setErrors((x) => ({ ...x, timeLocal: undefined })) }} aria-invalid={!!errors.timeLocal} aria-describedby={`${uid}-time-msg`} disabled={busy} />
                <p id={`${uid}-time-msg`} className={errors.timeLocal ? 'field-error' : 'hint'} role={errors.timeLocal ? 'alert' : undefined}>{errors.timeLocal ?? 'Hora del predio.'}</p>
              </div>
              <div>
                <label htmlFor={`${uid}-dur`} className="label">Duración (s)</label>
                <input id={`${uid}-dur`} type="text" inputMode="numeric" className="input" value={duration} onChange={(e) => { setDuration(e.target.value); setErrors((x) => ({ ...x, durationS: undefined })) }} aria-invalid={!!errors.durationS} aria-describedby={`${uid}-dur-msg`} disabled={busy} />
                <p id={`${uid}-dur-msg`} className={errors.durationS ? 'field-error' : 'hint'} role={errors.durationS ? 'alert' : undefined}>{errors.durationS ?? `5 a ${pumpMaxS} s.`}</p>
              </div>
              <div>
                <label htmlFor={`${uid}-label`} className="label">Nombre (opcional)</label>
                <input id={`${uid}-label`} type="text" maxLength={60} className="input" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Riego de la mañana" aria-invalid={!!errors.label} disabled={busy} />
                {errors.label && <p className="field-error" role="alert">{errors.label}</p>}
              </div>
            </div>

            {formError && <p role="alert" className="rounded-lg bg-crit-wash px-3 py-2 text-[13px] text-ink">{formError}</p>}
            {message && <p role="status" className="rounded-lg bg-good-wash px-3 py-2 text-[13px] text-ink">{message}</p>}
            <div>
              <button type="submit" className="btn btn-primary" disabled={busy}>
                {busy ? <Loader2 size={16} className="motion-safe:animate-spin" aria-hidden /> : <Plus size={16} aria-hidden />}
                Agregar calendario
              </button>
            </div>
          </form>
        ) : (
          <p className="rounded-lg bg-surface-2 px-3 py-2.5 text-[13px] leading-snug text-ink-2">Solo lectura: los calendarios los programa el ingeniero agrónomo o el administrador.</p>
        )}

        <p className="text-[12px] leading-snug text-ink-3">
          Un calendario se ejecuta cuando el nodo reporta dentro de los 30 min siguientes a la hora programada (una vez por día); si el nodo estaba apagado más tiempo, ese día se omite. El nodo puede rechazar la orden si está en espera entre riegos o el suelo está saturado.
        </p>
      </div>
    </Card>
  )
}
