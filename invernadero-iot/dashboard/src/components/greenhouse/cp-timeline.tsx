import { CheckCircle2, Circle, Loader2, Ban, TimerOff, CircleSlash } from 'lucide-react'
import { fmtDuration, fmtHMS } from '@/lib/format'
import { cn } from '@/lib/cn'
import type { CommandDTO } from '@/lib/services/commands'

/**
 * Línea de tiempo de una orden: solicitud confirmada → en cola → recibida por el nodo → resultado.
 * Cada paso lleva ícono + texto (el color nunca va solo) y el paso «en curso» gira solo si el usuario no
 * pidió reducir el movimiento.
 */

type StepState = 'done' | 'active' | 'pending' | 'failed' | 'skipped'

interface Step {
  key: string
  state: StepState
  label: string
  detail?: string
  time?: string | null
}

function buildSteps(c: CommandDTO): Step[] {
  const isStop = c.type === 'stop'
  const s = c.status
  const confirmed = s !== 'awaiting_confirmation'

  const queued: Step = {
    key: 'queued',
    label: 'En cola: esperando el próximo reporte del nodo',
    state: s === 'queued' ? 'active' : s === 'delivered' || s === 'executed' || s === 'rejected' ? 'done' : s === 'expired' && !c.deliveredAt ? 'failed' : s === 'cancelled' ? 'skipped' : 'pending',
    time: c.confirmedAt,
  }
  const delivered: Step = {
    key: 'delivered',
    label: 'El nodo recibió la orden',
    state: s === 'delivered' ? 'active' : s === 'executed' || s === 'rejected' ? 'done' : s === 'expired' && c.deliveredAt ? 'failed' : s === 'cancelled' || (s === 'expired' && !c.deliveredAt) ? 'skipped' : 'pending',
    time: c.deliveredAt,
  }

  let last: Step
  switch (s) {
    case 'executed':
      last = { key: 'result', state: 'done', label: isStop ? 'Ejecutada: la bomba se detuvo' : 'Ejecutada: el nodo está regando', detail: c.resultDetail ?? undefined, time: c.ackedAt }
      break
    case 'rejected':
      last = { key: 'result', state: 'failed', label: `Rechazada por el nodo${c.resultDetail ? `: ${c.resultDetail}` : ''}`, time: c.ackedAt }
      break
    case 'expired':
      last = { key: 'result', state: 'failed', label: c.deliveredAt ? 'Venció sin recibir el acuse del nodo' : 'Venció sin ser retirada por el nodo' }
      break
    case 'cancelled':
      last = { key: 'result', state: 'failed', label: 'Cancelada antes de llegar al nodo', detail: c.resultDetail ?? undefined }
      break
    default:
      last = { key: 'result', state: 'pending', label: 'Resultado del nodo' }
  }

  return [
    { key: 'confirmed', state: confirmed ? 'done' : 'active', label: confirmed ? 'Solicitud confirmada' : 'Falta confirmar con la contraseña', time: c.confirmedAt },
    queued,
    delivered,
    last,
  ]
}

function StepIcon({ state, final }: { state: StepState; final?: 'expired' | 'cancelled' | 'rejected' | null }) {
  const base = 'shrink-0'
  if (state === 'done') return <CheckCircle2 size={18} className={cn(base, 'text-good')} aria-hidden />
  if (state === 'active') return <Loader2 size={18} className={cn(base, 'text-accent motion-safe:animate-spin')} aria-hidden />
  if (state === 'failed') {
    const I = final === 'expired' ? TimerOff : final === 'cancelled' ? CircleSlash : Ban
    return <I size={18} className={cn(base, final === 'rejected' ? 'text-warn-ink' : 'text-ink-3')} aria-hidden />
  }
  if (state === 'skipped') return <Circle size={18} className={cn(base, 'text-ink-3 opacity-50')} aria-hidden />
  return <Circle size={18} className={cn(base, 'text-ink-3')} aria-hidden />
}

const STATE_TEXT: Record<StepState, string> = {
  done: 'completado', active: 'en curso', pending: 'pendiente', failed: 'no se completó', skipped: 'omitido',
}

export function CommandTimeline({ command, intervalS, className }: { command: CommandDTO; intervalS: number; className?: string }) {
  const steps = buildSteps(command)
  const final = command.status === 'expired' || command.status === 'cancelled' || command.status === 'rejected' ? command.status : null
  const open = command.status === 'queued' || command.status === 'delivered'
  return (
    <div className={className}>
      <ol className="flex flex-col gap-2.5">
        {steps.map((st, i) => {
          const isLast = i === steps.length - 1
          return (
            <li key={st.key} className="flex items-start gap-2.5" aria-current={st.state === 'active' ? 'step' : undefined}>
              <StepIcon state={st.state} final={isLast ? final : null} />
              <div className="min-w-0 flex-1 leading-snug">
                <div className={cn('text-[13.5px]', st.state === 'pending' || st.state === 'skipped' ? 'text-ink-3' : 'font-medium text-ink')}>
                  {st.label}
                  <span className="sr-only"> ({STATE_TEXT[st.state]})</span>
                </div>
                {st.detail && <div className="text-[12.5px] text-ink-2">Detalle del nodo: {st.detail}</div>}
                {st.time && st.state !== 'pending' && <div className="text-[11.5px] text-ink-3">{fmtHMS(st.time)}</div>}
              </div>
            </li>
          )
        })}
      </ol>
      {open && (
        <p className="mt-3 rounded-lg bg-surface-2 px-3 py-2 text-[12.5px] leading-snug text-ink-2">
          El nodo reporta cada <strong className="font-semibold text-ink">{fmtDuration(intervalS)}</strong>: la entrega puede demorar hasta ese tiempo.
          {command.expiresAt && <> Si no la retira antes de las <strong className="font-semibold text-ink">{fmtHMS(command.expiresAt)}</strong>, la orden vence.</>}
        </p>
      )}
    </div>
  )
}
