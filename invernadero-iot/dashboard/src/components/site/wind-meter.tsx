import { STATUS_META } from '@/components/ui/status'
import type { GreenhouseStatus, WindSummary } from '@/lib/domain/types'
import { fmtNum } from '@/lib/format'
import { cn } from '@/lib/cn'

const LEVEL_TO_STATUS: Record<WindSummary['level'], GreenhouseStatus> = { ok: 'ok', warning: 'warning', critical: 'critical', nodata: 'nodata' }

/** Color del relleno: acento → aviso → crítico. La pista es un lavado del mismo tono (medidor de una sola razón). */
const FILL: Record<WindSummary['level'], string> = {
  ok: 'var(--accent)',
  warning: 'var(--warn)',
  critical: 'var(--crit)',
  nodata: 'var(--muted)',
}

/**
 * Medidor de UNA razón: velocidad del viento del mástil contra sus dos límites (aviso y crítico).
 * El nivel siempre se dice con ícono + texto; los límites se marcan con ticks numerados.
 */
export function WindMeter({ wind }: { wind: WindSummary }) {
  const max = Math.max(wind.crit * 1.2, (wind.ms ?? 0) * 1.08, 1)
  const pos = (v: number) => `${Math.min(Math.max(v / max, 0), 1) * 100}%`
  const meta = STATUS_META[LEVEL_TO_STATUS[wind.level]]
  const Icon = meta.icon
  const toneClass = wind.level === 'ok' ? 'text-good' : wind.level === 'warning' ? 'text-warn-ink' : wind.level === 'critical' ? 'text-crit' : 'text-ink-3'
  const label = wind.level === 'nodata' ? 'Sin datos del mástil' : meta.label
  return (
    <div
      className="w-full"
      role="img"
      aria-label={wind.ms === null ? 'Viento: sin datos del mástil' : `Viento ${fmtNum(wind.ms)} metros por segundo, nivel ${meta.label}. Aviso desde ${fmtNum(wind.warn, 0)} y crítico desde ${fmtNum(wind.crit, 0)}.`}
    >
      <div className="relative mt-1 h-2 w-full rounded-full" style={{ background: 'var(--accent-wash)' }}>
        {wind.ms !== null && (
          <div className="absolute inset-y-0 left-0 rounded-full" style={{ width: pos(wind.ms), background: FILL[wind.level], minWidth: wind.ms > 0 ? 6 : 0 }} />
        )}
        {[wind.warn, wind.crit].map((v) => (
          <div key={v} className="absolute -top-[2px] h-3 w-[2px] -translate-x-1/2 rounded-full bg-ink-3" style={{ left: pos(v) }} aria-hidden />
        ))}
      </div>
      <div className="relative mt-1 h-3 text-[10.5px] text-ink-3" aria-hidden>
        {[wind.warn, wind.crit].map((v) => (
          <span key={v} className="absolute -translate-x-1/2" style={{ left: pos(v) }}>{fmtNum(v, 0)}</span>
        ))}
      </div>
      <div className={cn('mt-1 flex items-center gap-1.5 text-[12px] text-ink-2')}>
        <Icon size={13} className={cn('shrink-0', toneClass)} aria-hidden />
        <span>{label}</span>
      </div>
    </div>
  )
}
