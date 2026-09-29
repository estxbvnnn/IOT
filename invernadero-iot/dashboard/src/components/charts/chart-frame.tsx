'use client'

import { Table2, LineChart as LineIcon } from 'lucide-react'
import { useId, useState } from 'react'
import { cn } from '@/lib/cn'

export interface LegendItem {
  label: string
  color: string
  /** line = línea de 2 px · area = relleno · span = ventana (neutral) */
  kind?: 'line' | 'area' | 'span'
}

export interface TableData {
  columns: string[]
  rows: (string | number | null)[][]
}

interface ChartFrameProps {
  title: string
  subtitle?: React.ReactNode
  /** Leyenda: obligatoria con 2 o más elementos; con una sola serie el título ya la nombra. */
  legend?: LegendItem[]
  table: TableData
  children: React.ReactNode
  className?: string
  actions?: React.ReactNode
}

/**
 * Marco de un gráfico: título, leyenda y el «gemelo accesible» — una tabla con exactamente los mismos
 * datos. Los tooltips nunca son la única forma de leer un valor.
 */
export function ChartFrame({ title, subtitle, legend, table, children, className, actions }: ChartFrameProps) {
  const [showTable, setShowTable] = useState(false)
  const id = useId()
  return (
    <figure className={cn('card px-[18px] pb-4 pt-3.5', className)} aria-labelledby={`${id}-cap`}>
      <figcaption className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div id={`${id}-cap`} className="text-[14px] font-semibold leading-snug text-ink">{title}</div>
          {subtitle && <div className="mt-0.5 text-[12px] text-ink-3">{subtitle}</div>}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {actions}
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => setShowTable((v) => !v)}
            aria-pressed={showTable}
            title={showTable ? 'Ver gráfico' : 'Ver los datos en tabla'}
          >
            {showTable ? <LineIcon size={15} aria-hidden /> : <Table2 size={15} aria-hidden />}
            <span className="hidden sm:inline">{showTable ? 'Gráfico' : 'Tabla'}</span>
          </button>
        </div>
      </figcaption>

      {legend && legend.length > 0 && (
        <ul className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[12px] text-ink-2" aria-label="Leyenda">
          {legend.map((l) => (
            <li key={l.label} className="flex items-center gap-1.5">
              <LegendKey item={l} />
              {l.label}
            </li>
          ))}
        </ul>
      )}

      <div className="mt-2">
        {showTable ? (
          <div className="max-h-[300px] overflow-auto rounded-lg border border-line" tabIndex={0} role="region" aria-label={`Datos de ${title}`}>
            <table className="tbl">
              <thead>
                <tr>
                  {table.columns.map((c) => (
                    <th key={c} scope="col">{c}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {table.rows.map((r, i) => (
                  <tr key={i}>
                    {r.map((cell, j) => (
                      <td key={j} className={j === 0 ? 'whitespace-nowrap text-ink-2' : 'text-ink'}>{cell ?? '—'}</td>
                    ))}
                  </tr>
                ))}
                {table.rows.length === 0 && (
                  <tr><td colSpan={table.columns.length} className="text-center text-ink-3">Sin datos en este rango</td></tr>
                )}
              </tbody>
            </table>
          </div>
        ) : (
          children
        )}
      </div>
    </figure>
  )
}

function LegendKey({ item }: { item: LegendItem }) {
  if (item.kind === 'span') {
    return <span className="inline-block h-3 w-3 rounded-[3px]" style={{ background: item.color, opacity: 0.22, borderTop: `2px solid ${item.color}` }} aria-hidden />
  }
  if (item.kind === 'area') {
    return <span className="inline-block h-3 w-3 rounded-[3px]" style={{ background: item.color, opacity: 0.35 }} aria-hidden />
  }
  return <span className="inline-block h-[2px] w-4 rounded-full" style={{ background: item.color }} aria-hidden />
}
