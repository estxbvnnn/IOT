import { Ban, CheckCircle2, CircleSlash, Clock, Hourglass, Send, TimerOff } from 'lucide-react'
import { Chip } from '@/components/ui/status'
import type { CommandStatus } from '@/lib/services/commands'

/**
 * Estados de una orden de riego, en español y con ícono + texto (el color nunca va solo).
 * Módulo compartido por la tabla de órdenes (servidor) y el panel de riego (cliente): no usa hooks.
 * Solo se importa el TIPO desde el servicio: los servicios no deben entrar al bundle del navegador.
 */

type ChipTone = React.ComponentProps<typeof Chip>['tone']
type ChipIcon = React.ComponentProps<typeof Chip>['icon']

export interface CommandStatusMeta {
  label: string
  tone: ChipTone
  icon: ChipIcon
  /** Estado terminal: ya no cambia. */
  final: boolean
  /** Explicación breve (tooltip). */
  hint: string
}

export const commandStatusMeta: Record<CommandStatus, CommandStatusMeta> = {
  awaiting_confirmation: {
    label: 'Pendiente de confirmar', tone: 'warn', icon: Hourglass, final: false,
    hint: 'Falta que quien la solicitó confirme con su contraseña.',
  },
  queued: {
    label: 'En cola', tone: 'info', icon: Clock, final: false,
    hint: 'Confirmada; espera el próximo reporte del nodo para ser entregada.',
  },
  delivered: {
    label: 'Entregada al nodo', tone: 'info', icon: Send, final: false,
    hint: 'El nodo la recibió; falta su acuse de recibo.',
  },
  executed: {
    label: 'Ejecutada', tone: 'good', icon: CheckCircle2, final: true,
    hint: 'El nodo la ejecutó y lo confirmó.',
  },
  rejected: {
    label: 'Rechazada', tone: 'warn', icon: Ban, final: true,
    hint: 'El nodo la rechazó por una de sus reglas de seguridad (ver el detalle).',
  },
  expired: {
    label: 'Vencida', tone: 'off', icon: TimerOff, final: true,
    hint: 'Nadie la confirmó a tiempo, o el nodo no la retiró antes de que venciera.',
  },
  cancelled: {
    label: 'Cancelada', tone: 'off', icon: CircleSlash, final: true,
    hint: 'Se canceló antes de llegar al nodo.',
  },
}

export function isFinalStatus(status: CommandStatus): boolean {
  return commandStatusMeta[status].final
}

export function CommandStatusChip({ status, className }: { status: CommandStatus; className?: string }) {
  const m = commandStatusMeta[status]
  return <Chip tone={m.tone} icon={m.icon} className={className} title={m.hint}>{m.label}</Chip>
}

/** «Riego 20 s» / «Detener bomba». */
export function commandTypeLabel(c: { type: 'irrigate' | 'stop'; durationS: number | null }): string {
  return c.type === 'stop' ? 'Detener bomba' : `Riego ${c.durationS ?? '?'} s`
}

export function commandSourceLabel(source: 'manual' | 'schedule'): string {
  return source === 'schedule' ? 'Calendario' : 'Manual'
}
