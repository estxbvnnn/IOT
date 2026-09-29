'use client'

import { useEffect, useId, useMemo, useRef, useState } from 'react'
import type { Point } from '@/lib/domain/types'
import { fmtDM, fmtDay, fmtHM, fmtHMS, fmtNum } from '@/lib/format'
import { ChartFrame, type LegendItem } from './chart-frame'
import { mergeTimes, nearestIndex, niceDomain, niceTicks, splitSegments, timeTicks } from './scales'

/**
 * Gráfico de serie temporal en SVG propio, siguiendo la guía de visualización:
 * líneas de 2 px con unión redonda · relleno al 10 % · rejilla de 1 px sólida y recesiva · punto de
 * 8 px con anillo de 2 px del color de la superficie · una sola escala Y (nunca doble eje) ·
 * cruceta + tooltip que lista cada serie (valor primero, nombre después) · teclado · tabla equivalente.
 */

export interface ChartSeries {
  id: string
  label: string
  unit: string
  /** Color de la marca (variable CSS). El texto NUNCA usa este color. */
  color: string
  points: readonly Point[]
  digits?: number
}

/** Banda horizontal en el eje Y (p. ej. las tres zonas del YL-38). */
export interface ChartBand { from: number; to: number; label: string; fill: string }
export interface ChartRef { value: number; label: string }
/** Ventana de tiempo sombreada en neutro (p. ej. un riego). */
export interface ChartSpan { start: number; end: number | null; label: string }

export interface TimeSeriesChartProps {
  title: string
  subtitle?: React.ReactNode
  series: readonly ChartSeries[]
  from: number
  to: number
  yDomain?: readonly [number, number]
  /** Ancla el mínimo del eje Y (p. ej. 0 para lux). */
  yMin?: number
  bands?: readonly ChartBand[]
  refLines?: readonly ChartRef[]
  spans?: readonly ChartSpan[]
  spanLegend?: string
  /** Un hueco mayor a esto (ms) interrumpe la línea (nodo sin reportar). */
  gapMs?: number
  height?: number
  area?: boolean
  /** Valor final escrito junto a la línea (solo con una serie). */
  endLabel?: boolean
  className?: string
  emptyText?: string
}

const M = { top: 10, bottom: 26, left: 46 }

function fmtAxisTime(t: number, day: boolean): string {
  return day ? fmtDay(t) : fmtHM(t)
}

export function TimeSeriesChart({
  title, subtitle, series, from, to, yDomain, yMin, bands, refLines, spans, spanLegend = 'Riego', gapMs = Infinity,
  height = 230, area, endLabel, className, emptyText = 'Sin datos en este rango',
}: TimeSeriesChartProps) {
  const wrapRef = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(640)
  const [active, setActive] = useState<number | null>(null)
  const live = useId()

  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const ro = new ResizeObserver(([e]) => e && setWidth(Math.max(260, Math.floor(e.contentRect.width))))
    ro.observe(el)
    setWidth(Math.max(260, Math.floor(el.clientWidth)))
    return () => ro.disconnect()
  }, [])

  const single = series.length === 1
  const right = single && endLabel ? 62 : 14
  const innerW = width - M.left - right
  const innerH = height - M.top - M.bottom
  const span = Math.max(to - from, 1)

  const values = useMemo(() => series.flatMap((s) => s.points.map((p) => p[1]).filter((v): v is number => v !== null)), [series])
  const times = useMemo(() => mergeTimes(series), [series])
  const [y0, y1] = yDomain ?? niceDomain(values, { min: yMin })
  const x = (t: number) => M.left + ((t - from) / span) * innerW
  const y = (v: number) => M.top + (1 - (v - y0) / (y1 - y0 || 1)) * innerH

  const yTicks = niceTicks(y0, y1, innerH > 150 ? 5 : 4)
  const xTicks = timeTicks(from, to, Math.max(3, Math.floor(innerW / 96)))
  const decimals = yTicks.length > 1 && Math.abs(yTicks[1]! - yTicks[0]!) < 1 ? 1 : 0

  const lookup = useMemo(
    () => series.map((s) => new Map(s.points.map((p) => [p[0], p[1]] as const))),
    [series],
  )

  const activeT = active !== null ? times[active] : undefined
  const empty = values.length === 0

  const onMove = (clientX: number) => {
    const el = wrapRef.current
    if (!el || times.length === 0) return
    const px = clientX - el.getBoundingClientRect().left
    const t = from + ((px - M.left) / innerW) * span
    setActive(nearestIndex(times, t))
  }

  const onKey = (e: React.KeyboardEvent) => {
    if (times.length === 0) return
    const last = times.length - 1
    if (e.key === 'ArrowLeft') setActive((a) => Math.max(0, (a ?? last + 1) - 1))
    else if (e.key === 'ArrowRight') setActive((a) => Math.min(last, (a ?? -1) + 1))
    else if (e.key === 'Home') setActive(0)
    else if (e.key === 'End') setActive(last)
    else if (e.key === 'Escape') setActive(null)
    else return
    e.preventDefault()
  }

  // Tooltip: valores de cada serie, banda y riego en el instante activo.
  const tip = useMemo(() => {
    if (activeT === undefined) return null
    const rows = series.map((s, i) => {
      const v = lookup[i]!.get(activeT) ?? null
      return { id: s.id, label: s.label, color: s.color, text: v === null ? '—' : `${fmtNum(v, s.digits ?? 1)}${s.unit ? ` ${s.unit}` : ''}`, v }
    })
    const first = rows[0]?.v ?? null
    const band = bands && first !== null ? bands.find((b) => first >= b.from && first < b.to) : undefined
    const inSpan = spans?.find((s) => activeT >= s.start && activeT <= (s.end ?? to))
    return { rows, band: band?.label, span: inSpan?.label }
  }, [activeT, series, lookup, bands, spans, to])

  const timeLabel = (t: number) => (span > 36 * 3600_000 ? `${fmtDM(t)} ${fmtHM(t)}` : span <= 2 * 3600_000 ? fmtHMS(t) : fmtHM(t))

  const live_text = tip && activeT !== undefined ? `${timeLabel(activeT)}: ${tip.rows.map((r) => `${r.label} ${r.text}`).join(', ')}${tip.band ? `, banda ${tip.band}` : ''}` : ''

  // Tabla equivalente (mismos datos que el gráfico).
  const table = useMemo(
    () => ({
      columns: ['Hora', ...series.map((s) => (s.unit ? `${s.label} (${s.unit})` : s.label))],
      rows: [...times].reverse().map((t) => [
        `${fmtDM(t)} ${fmtHMS(t)}`,
        ...series.map((s, i) => {
          const v = lookup[i]!.get(t) ?? null
          return v === null ? null : fmtNum(v, s.digits ?? 1)
        }),
      ]),
    }),
    [series, times, lookup],
  )

  const legend: LegendItem[] = []
  if (series.length >= 2) for (const s of series) legend.push({ label: s.label, color: s.color, kind: 'line' })
  if (spans && spans.length > 0) {
    if (series.length === 1) legend.push({ label: series[0]!.label, color: series[0]!.color, kind: 'line' })
    legend.push({ label: spanLegend, color: 'var(--ink)', kind: 'span' })
  }

  const clipId = `clip-${live.replace(/[^a-zA-Z0-9_-]/g, '')}` // useId puede traer caracteres inválidos para url(#…)
  const lastPoint = single ? [...series[0]!.points].reverse().find((p) => p[1] !== null) : undefined

  return (
    <ChartFrame title={title} subtitle={subtitle} legend={legend} table={table} className={className}>
      <div
        ref={wrapRef}
        className="relative select-none outline-offset-4"
        style={{ height, touchAction: 'pan-y' }}
        tabIndex={empty ? -1 : 0}
        role="group"
        aria-roledescription="gráfico interactivo"
        aria-label={`${title}. Usa las flechas izquierda y derecha para recorrer los valores; el botón «Tabla» muestra los datos completos.`}
        onPointerMove={(e) => onMove(e.clientX)}
        onPointerDown={(e) => onMove(e.clientX)}
        onPointerLeave={() => setActive(null)}
        onKeyDown={onKey}
        onBlur={() => setActive(null)}
      >
        <svg width={width} height={height} aria-hidden="true" className="block">
          <defs>
            <clipPath id={clipId}>
              <rect x={M.left} y={M.top} width={Math.max(innerW, 0)} height={Math.max(innerH, 0)} />
            </clipPath>
          </defs>

          {/* Bandas horizontales (zonas del sensor de suelo) */}
          {bands?.map((b) => {
            const top = y(Math.min(b.to, y1))
            const bottom = y(Math.max(b.from, y0))
            const h = bottom - top
            if (h <= 0) return null
            return (
              <g key={b.label}>
                <rect x={M.left} y={top} width={innerW} height={h} fill={b.fill} />
                {h >= 16 && (
                  <text x={M.left + 8} y={top + h / 2 + 3.5} fontSize={10.5} fontWeight={600} letterSpacing="0.05em" fill="var(--ink-3)">
                    {b.label.toUpperCase()}
                  </text>
                )}
              </g>
            )
          })}

          {/* Rejilla: hairlines sólidas, una tonalidad sobre la superficie */}
          {yTicks.map((t) => (
            <g key={t}>
              <line x1={M.left} x2={M.left + innerW} y1={y(t)} y2={y(t)} stroke="var(--grid)" strokeWidth={1} />
              <text x={M.left - 8} y={y(t) + 4} textAnchor="end" fontSize={11} fill="var(--muted)">{fmtNum(t, decimals)}</text>
            </g>
          ))}
          <line x1={M.left} x2={M.left + innerW} y1={M.top + innerH} y2={M.top + innerH} stroke="var(--baseline)" strokeWidth={1} />
          {xTicks.map((t) => {
            const px = x(t.t)
            const anchor = px < M.left + 18 ? 'start' : px > width - right - 18 ? 'end' : 'middle'
            return (
              <g key={t.t}>
                <line x1={px} x2={px} y1={M.top + innerH} y2={M.top + innerH + 4} stroke="var(--baseline)" strokeWidth={1} />
                <text x={px} y={height - 6} textAnchor={anchor} fontSize={11} fill="var(--muted)">{fmtAxisTime(t.t, t.day)}</text>
              </g>
            )
          })}

          {/* Líneas de referencia (sólidas y recesivas) */}
          {refLines?.map((r) =>
            r.value >= y0 && r.value <= y1 ? (
              <g key={r.label}>
                <line x1={M.left} x2={M.left + innerW} y1={y(r.value)} y2={y(r.value)} stroke="var(--baseline)" strokeWidth={1} />
                <text x={M.left + innerW - 4} y={y(r.value) - 4} textAnchor="end" fontSize={10.5} fill="var(--ink-3)">{r.label}</text>
              </g>
            ) : null,
          )}

          <g clipPath={`url(#${clipId})`}>
            {/* Ventanas de riego: neutras (no consumen un color de serie) */}
            {spans?.map((s, i) => {
              const x1 = x(s.start)
              const x2 = s.end === null ? x(to) : x(s.end)
              const w = Math.max(x2 - x1, 4) // los riegos de 30 s serían invisibles: ancho mínimo de 4 px
              const left = x1 - (w - (x2 - x1)) / 2
              return (
                <g key={`${s.start}-${i}`}>
                  <rect x={left} y={M.top} width={w} height={innerH} fill="var(--ink)" opacity={0.08} />
                  <rect x={left} y={M.top} width={w} height={3} fill="var(--ink-2)" opacity={0.7} />
                </g>
              )
            })}

            {series.map((s) => {
              const segs = splitSegments(s.points, gapMs)
              const path = segs.map((seg) => seg.map(([t, v], k) => `${k === 0 ? 'M' : 'L'}${x(t).toFixed(1)} ${y(v).toFixed(1)}`).join(' ')).join(' ')
              const fill = area && single
                ? segs.filter((seg) => seg.length > 1).map((seg) =>
                    `${seg.map(([t, v], k) => `${k === 0 ? 'M' : 'L'}${x(t).toFixed(1)} ${y(v).toFixed(1)}`).join(' ')} L${x(seg[seg.length - 1]![0]).toFixed(1)} ${M.top + innerH} L${x(seg[0]![0]).toFixed(1)} ${M.top + innerH} Z`).join(' ')
                : ''
              return (
                <g key={s.id}>
                  {fill && <path d={fill} fill={s.color} opacity={0.1} />}
                  <path d={path} fill="none" stroke={s.color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
                  {/* Puntos aislados (un tramo de una sola lectura) */}
                  {segs.flatMap((seg) => (seg.length === 1 && seg[0] ? [seg[0]] : [])).map(([t, v]) => (
                    <circle key={t} cx={x(t)} cy={y(v)} r={3} fill={s.color} />
                  ))}
                </g>
              )
            })}
          </g>

          {/* Valor final junto a la línea (texto en tinta, no en el color de la serie) */}
          {single && endLabel && lastPoint && lastPoint[1] !== null && (
            <text x={Math.min(x(lastPoint[0]) + 8, width - 4)} y={y(lastPoint[1]) + 4} fontSize={11.5} fontWeight={600} fill="var(--ink)">
              {fmtNum(lastPoint[1], series[0]!.digits ?? 1)}{series[0]!.unit ? ` ${series[0]!.unit}` : ''}
            </text>
          )}

          {/* Cruceta y puntos activos */}
          {activeT !== undefined && (
            <g>
              <line x1={x(activeT)} x2={x(activeT)} y1={M.top} y2={M.top + innerH} stroke="var(--border-strong)" strokeWidth={1} />
              {series.map((s, i) => {
                const v = lookup[i]!.get(activeT)
                return v === null || v === undefined ? null : (
                  <circle key={s.id} cx={x(activeT)} cy={y(v)} r={4} fill={s.color} stroke="var(--surface)" strokeWidth={2} />
                )
              })}
            </g>
          )}
        </svg>

        {empty && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-[13px] text-ink-3">{emptyText}</div>
        )}

        {tip && activeT !== undefined && (
          <div
            className="pointer-events-none absolute z-10 min-w-[150px] rounded-lg border border-line-strong bg-surface px-3 py-2 text-[12px] shadow-[0_8px_24px_rgb(0_0_0/0.18)]"
            style={{ top: 6, ...(x(activeT) > width * 0.58 ? { right: width - x(activeT) + 12 } : { left: x(activeT) + 12 }) }}
          >
            <div className="mb-1 text-[11.5px] text-ink-3">{timeLabel(activeT)}</div>
            {tip.rows.map((r) => (
              <div key={r.id} className="flex items-center gap-2 leading-[1.5]">
                <span className="inline-block h-[2px] w-3 shrink-0 rounded-full" style={{ background: r.color }} aria-hidden />
                <strong className="text-[13px] font-semibold text-ink">{r.text}</strong>
                <span className="text-ink-3">{r.label}</span>
              </div>
            ))}
            {tip.band && <div className="mt-0.5 text-ink-2">Banda: <strong className="font-semibold text-ink">{tip.band}</strong></div>}
            {tip.span && <div className="mt-0.5 text-ink-2">{tip.span}</div>}
          </div>
        )}

        <span className="sr-only" role="status" aria-live="polite" id={live}>{active !== null ? live_text : ''}</span>
      </div>
    </ChartFrame>
  )
}
