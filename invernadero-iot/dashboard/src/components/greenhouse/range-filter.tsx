'use client'

import { Check, Loader2 } from 'lucide-react'
import Link, { useLinkStatus } from 'next/link'
import { cn } from '@/lib/cn'
import { RANGE_KEYS, RANGE_SPECS, type RangeKey } from '@/lib/domain/types'
import { fmtDateTime } from '@/lib/format'

/** Indicador de «cargando» dentro de cada enlace: ocupa un lugar fijo y solo cambia su opacidad (sin saltos de diseño). */
function Pending() {
  const { pending } = useLinkStatus()
  return (
    <Loader2
      size={13}
      aria-hidden
      className={cn('pointer-events-none absolute right-1.5 top-1/2 -translate-y-1/2 animate-spin transition-opacity', pending ? 'opacity-70' : 'opacity-0')}
    />
  )
}

interface RangeFilterProps {
  code: string
  current: RangeKey
  /** Ventana efectiva (epoch ms) para mostrar el intervalo exacto. */
  from: number
  to: number
}

/**
 * Filtro de rango: UNA sola fila sobre todo lo que alcanza (gráficos y tabla de riegos), nunca dentro
 * de un gráfico ni por gráfico. La opción elegida se marca con un check de 16 px en negrita; el hover es
 * un lavado suave que no compite con la selección.
 */
export function RangeFilter({ code, current, from, to }: RangeFilterProps) {
  return (
    <div className="card flex flex-wrap items-center justify-between gap-x-4 gap-y-2 px-3 py-2">
      <nav aria-label="Rango de tiempo de los gráficos y la tabla de riegos" className="flex flex-wrap items-center gap-1">
        <span className="eyebrow mr-2 hidden sm:inline">Rango</span>
        {RANGE_KEYS.map((k) => {
          const selected = k === current
          return (
            <Link
              key={k}
              href={`/greenhouses/${code}?range=${k}`}
              scroll={false}
              prefetch={false}
              aria-current={selected ? 'true' : undefined}
              className={cn(
                'relative inline-flex min-h-[32px] items-center gap-1.5 rounded-lg px-3 pr-6 text-[13px] transition-colors',
                selected ? 'bg-surface-2 font-semibold text-ink' : 'font-medium text-ink-2 hover:bg-off-wash hover:text-ink',
              )}
            >
              {selected && <Check size={16} strokeWidth={3} className="shrink-0 text-accent" aria-hidden />}
              {RANGE_SPECS[k].label}
              <Pending />
            </Link>
          )
        })}
      </nav>
      <p className="text-[12px] text-ink-3">
        <span className="hidden md:inline">Mostrando </span>{fmtDateTime(from)} <span aria-hidden>→</span><span className="sr-only">hasta</span> {fmtDateTime(to)}
      </p>
    </div>
  )
}
