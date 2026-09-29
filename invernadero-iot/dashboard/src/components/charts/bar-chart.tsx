'use client'

import { useEffect, useId, useRef, useState } from 'react'
import { fmtNum } from '@/lib/format'
import { ChartFrame } from './chart-frame'
import { niceDomain, niceTicks } from './scales'

/**
 * Gráfico de columnas: barras de ≤ 24 px con extremo superior redondeado de 4 px y base recta, brecha de
 * 2 px de la superficie entre barras, una sola escala. Cada barra es su propio blanco de hover/foco.
 */
export interface BarDatum {
  key: string
  label: string
  value: number
  /** Texto adicional del tooltip (p. ej. «3 riegos»). */
  detail?: string
}

interface BarChartProps {
  title: string
  subtitle?: React.ReactNode
  data: readonly BarDatum[]
  unit: string
  digits?: number
  color?: string
  height?: number
  className?: string
  emptyText?: string
  valueLabel?: string
}

const M = { top: 12, bottom: 26, left: 46, right: 10 }

export function BarChart({ title, subtitle, data, unit, digits = 1, color = 'var(--s1)', height = 190, className, emptyText = 'Sin datos en este rango', valueLabel = 'Valor' }: BarChartProps) {
  const ref = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(520)
  const [active, setActive] = useState<number | null>(null)
  const id = useId()

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const ro = new ResizeObserver(([e]) => e && setWidth(Math.max(240, Math.floor(e.contentRect.width))))
    ro.observe(el)
    setWidth(Math.max(240, Math.floor(el.clientWidth)))
    return () => ro.disconnect()
  }, [])

  const innerW = width - M.left - M.right
  const innerH = height - M.top - M.bottom
  const [y0, y1] = niceDomain(data.map((d) => d.value), { min: 0, pad: 0.08 })
  const y = (v: number) => M.top + (1 - (v - y0) / (y1 - y0 || 1)) * innerH
  const slot = data.length > 0 ? innerW / data.length : innerW
  const barW = Math.min(24, Math.max(4, slot - 2)) // ≤ 24 px, con 2 px de aire
  const ticks = niceTicks(y0, y1, 4)
  const dec = ticks.length > 1 && Math.abs(ticks[1]! - ticks[0]!) < 1 ? 1 : 0
  const every = Math.max(1, Math.ceil(data.length / Math.max(2, Math.floor(innerW / 54))))

  const rounded = (x: number, top: number, w: number, h: number) => {
    const r = Math.min(4, w / 2, h)
    return `M${x} ${top + h} V${top + r} Q${x} ${top} ${x + r} ${top} H${x + w - r} Q${x + w} ${top} ${x + w} ${top + r} V${top + h} Z`
  }

  const a = active !== null ? data[active] : undefined
  const table = {
    columns: ['Categoría', unit ? `${valueLabel} (${unit})` : valueLabel, 'Detalle'],
    rows: data.map((d) => [d.label, fmtNum(d.value, digits), d.detail ?? null]),
  }

  return (
    <ChartFrame title={title} subtitle={subtitle} table={table} className={className}>
      <div
        ref={ref}
        className="relative select-none"
        style={{ height }}
        role="group"
        aria-label={`${title}. ${data.length} barras.`}
        onPointerLeave={() => setActive(null)}
      >
        <svg width={width} height={height} aria-hidden="true" className="block">
          {ticks.map((t) => (
            <g key={t}>
              <line x1={M.left} x2={M.left + innerW} y1={y(t)} y2={y(t)} stroke="var(--grid)" strokeWidth={1} />
              <text x={M.left - 8} y={y(t) + 4} textAnchor="end" fontSize={11} fill="var(--muted)">{fmtNum(t, dec)}</text>
            </g>
          ))}
          <line x1={M.left} x2={M.left + innerW} y1={M.top + innerH} y2={M.top + innerH} stroke="var(--baseline)" strokeWidth={1} />
          {data.map((d, i) => {
            const cx = M.left + slot * i + slot / 2
            const top = y(d.value)
            const h = Math.max(M.top + innerH - top, d.value > 0 ? 2 : 0)
            const hot = active === i
            return (
              <g key={d.key}>
                {d.value > 0 && <path d={rounded(cx - barW / 2, M.top + innerH - h, barW, h)} fill={color} opacity={hot ? 1 : 0.88} />}
                {i % every === 0 && (
                  <text x={cx} y={height - 8} textAnchor="middle" fontSize={11} fill="var(--muted)">{d.label}</text>
                )}
                {/* Blanco de hover/foco más grande que la marca */}
                <rect
                  x={M.left + slot * i}
                  y={M.top}
                  width={slot}
                  height={innerH}
                  fill="transparent"
                  tabIndex={0}
                  aria-label={`${d.label}: ${fmtNum(d.value, digits)} ${unit}${d.detail ? `, ${d.detail}` : ''}`}
                  onPointerEnter={() => setActive(i)}
                  onFocus={() => setActive(i)}
                  onBlur={() => setActive(null)}
                  className="outline-none focus-visible:stroke-[var(--focus)]"
                  strokeWidth={2}
                />
              </g>
            )
          })}
        </svg>
        {data.length === 0 && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-[13px] text-ink-3">{emptyText}</div>
        )}
        {a && active !== null && (
          <div
            id={`${id}-tip`}
            className="pointer-events-none absolute z-10 rounded-lg border border-line-strong bg-surface px-3 py-2 text-[12px] shadow-[0_8px_24px_rgb(0_0_0/0.18)]"
            style={{ top: 4, ...(M.left + slot * active > width * 0.6 ? { right: width - (M.left + slot * active) + 6 } : { left: M.left + slot * (active + 1) + 6 }) }}
          >
            <div className="text-[11.5px] text-ink-3">{a.label}</div>
            <div><strong className="text-[13px] font-semibold text-ink">{fmtNum(a.value, digits)} {unit}</strong></div>
            {a.detail && <div className="text-ink-2">{a.detail}</div>}
          </div>
        )}
      </div>
    </ChartFrame>
  )
}
