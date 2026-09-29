import {
  AlertOctagon, AlertTriangle, CheckCircle2, CircleDashed, Info, Sprout, Sun, Waves, WifiOff, Droplets, Timer,
  Thermometer, CircleSlash, Power,
} from 'lucide-react'
import type { GreenhouseStatus, PumpState, Severity } from '@/lib/domain/types'
import type { SoilBand } from '@/lib/domain/soil'
import { cn } from '@/lib/cn'

/**
 * Chips de estado. Regla de la guía de visualización: el color de estado NUNCA va solo:
 * siempre lleva ícono + texto, y el texto usa tinta (no el color del estado) para asegurar el contraste.
 */

type Tone = 'good' | 'warn' | 'serious' | 'crit' | 'off' | 'info'

const TONE: Record<Tone, { bg: string; icon: string }> = {
  good: { bg: 'bg-good-wash', icon: 'text-good' },
  warn: { bg: 'bg-warn-wash', icon: 'text-warn-ink' },
  serious: { bg: 'bg-serious-wash', icon: 'text-serious' },
  crit: { bg: 'bg-crit-wash', icon: 'text-crit' },
  off: { bg: 'bg-off-wash', icon: 'text-ink-3' },
  info: { bg: 'bg-accent-wash', icon: 'text-accent' },
}

interface ChipProps {
  tone: Tone
  icon: React.ComponentType<{ className?: string; size?: number; 'aria-hidden'?: boolean }>
  children: React.ReactNode
  className?: string
  title?: string
}

export function Chip({ tone, icon: Icon, children, className, title }: ChipProps) {
  const t = TONE[tone]
  return (
    <span className={cn('chip text-ink', t.bg, className)} title={title}>
      <Icon size={14} className={cn('shrink-0', t.icon)} aria-hidden />
      {children}
    </span>
  )
}

export const STATUS_META: Record<GreenhouseStatus, { label: string; tone: Tone; icon: ChipProps['icon']; rank: number }> = {
  critical: { label: 'Crítico', tone: 'crit', icon: AlertOctagon, rank: 0 },
  warning: { label: 'Atención', tone: 'warn', icon: AlertTriangle, rank: 1 },
  offline: { label: 'Sin conexión', tone: 'off', icon: WifiOff, rank: 2 },
  nodata: { label: 'Sin datos', tone: 'off', icon: CircleDashed, rank: 3 },
  ok: { label: 'Normal', tone: 'good', icon: CheckCircle2, rank: 4 },
}

export function StatusChip({ status, className }: { status: GreenhouseStatus; className?: string }) {
  const m = STATUS_META[status]
  return <Chip tone={m.tone} icon={m.icon} className={className}>{m.label}</Chip>
}

export const SEVERITY_META: Record<Severity, { label: string; tone: Tone; icon: ChipProps['icon'] }> = {
  critical: { label: 'Crítica', tone: 'crit', icon: AlertOctagon },
  warning: { label: 'Aviso', tone: 'warn', icon: AlertTriangle },
  info: { label: 'Info', tone: 'info', icon: Info },
}

export function SeverityChip({ severity, className }: { severity: Severity; className?: string }) {
  const m = SEVERITY_META[severity]
  return <Chip tone={m.tone} icon={m.icon} className={className}>{m.label}</Chip>
}

export const BAND_META: Record<SoilBand, { label: string; tone: Tone; icon: ChipProps['icon'] }> = {
  saturado: { label: 'Saturado', tone: 'info', icon: Waves },
  optimo: { label: 'Óptimo', tone: 'good', icon: Sprout },
  seco: { label: 'Seco', tone: 'serious', icon: Sun },
}

export function BandChip({ band, className }: { band: SoilBand | null; className?: string }) {
  if (!band) return <Chip tone="off" icon={CircleDashed} className={className}>Sin dato</Chip>
  const m = BAND_META[band]
  return <Chip tone={m.tone} icon={m.icon} className={className}>{m.label}</Chip>
}

export const PUMP_META: Record<PumpState, { label: string; tone: Tone; icon: ChipProps['icon'] }> = {
  riego: { label: 'Regando', tone: 'info', icon: Droplets },
  espera: { label: 'En espera', tone: 'off', icon: Timer },
  bloq_temp: { label: 'Bloqueada: calor', tone: 'warn', icon: Thermometer },
  bloq_sensor: { label: 'Bloqueada: sensor', tone: 'warn', icon: CircleSlash },
  saturado: { label: 'Suelo saturado', tone: 'info', icon: Waves },
  idle: { label: 'Apagada', tone: 'off', icon: Power },
}

export function PumpChip({ state, on, className }: { state: PumpState | null; on: boolean | null; className?: string }) {
  const key: PumpState = on ? 'riego' : (state ?? 'idle')
  const m = PUMP_META[key]
  return <Chip tone={m.tone} icon={m.icon} className={className}>{m.label}</Chip>
}
