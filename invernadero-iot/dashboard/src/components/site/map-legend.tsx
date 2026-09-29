import { StatusChip } from '@/components/ui/status'
import type { GreenhouseSummary } from '@/lib/domain/types'
import Link from 'next/link'
import { cn } from '@/lib/cn'

/**
 * Leyenda del mapa: estados con ícono + texto (el color nunca va solo) y bandas del sensor de suelo con
 * los límites reales de la tabla del YL-38 (o los que ajustó el agrónomo).
 */
export function MapLegend({ greenhouses, plain }: { greenhouses: readonly GreenhouseSummary[]; /** Sin borde ni margen superior (cuando va en su propia tarjeta). */ plain?: boolean }) {
  const first = greenhouses[0]
  const sat = first?.thresholds.soilSat ?? 300
  const on = first?.thresholds.soilOn ?? 700
  const mixed = greenhouses.some((g) => g.thresholds.soilSat !== sat || g.thresholds.soilOn !== on)
  const hasNoData = greenhouses.some((g) => g.status === 'nodata')

  const zones = [
    { label: `Óptimo ${sat}–${on - 1}`, color: 'var(--good)' },
    { label: `Seco ≥ ${on}`, color: 'var(--serious)' },
    { label: `Saturado < ${sat}`, color: 'var(--accent)' },
  ]

  return (
    <div className={cn('flex flex-col gap-2.5 text-[12px] text-ink-2', !plain && 'mt-3 border-t border-line pt-3')}>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
        <span className="mr-1 font-medium text-ink-3">Estado (borde y símbolo)</span>
        <StatusChip status="ok" />
        <StatusChip status="warning" />
        <StatusChip status="critical" />
        <StatusChip status="offline" />
        {hasNoData && <StatusChip status="nodata" />}
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
        <span className="font-medium text-ink-3">Suelo (barra inferior)</span>
        {zones.map((z) => (
          <span key={z.label} className="inline-flex items-center gap-1.5">
            <span className="inline-block h-2 w-4 rounded-full" style={{ background: z.color, opacity: 0.6 }} aria-hidden />
            {z.label}
          </span>
        ))}
        {mixed && <span className="text-ink-3">(límites propios de cada invernadero)</span>}
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
        <span className="inline-flex items-center gap-1.5">
          <span className="inline-block h-2.5 w-2.5 rounded-full border border-ink-2 bg-surface" aria-hidden /> Nodo
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="inline-block h-2.5 w-2.5 rounded-full bg-accent" aria-hidden /> Nodo azul con pulso: la bomba está regando
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="inline-block h-2.5 w-2.5 rounded-full bg-ink" aria-hidden /> Subestación (gateway + anemómetro)
        </span>
      </div>
    </div>
  )
}

/** Texto que describe el mapa (aria-describedby) y remite a la tabla equivalente. */
export function MapHelp({ describedById, tableId }: { describedById: string; tableId: string }) {
  return (
    <p id={describedById} className="mt-3 text-[12px] text-ink-3">
      Los mismos datos del mapa están, en texto, en la{' '}
      <Link href={`#${tableId}`} className="font-medium text-ink underline underline-offset-2">tabla «Invernaderos»</Link>.
      {' '}Pasa el puntero o el foco por un invernadero para ver su distancia a la subestación.
    </p>
  )
}
