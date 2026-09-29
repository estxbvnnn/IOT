'use client'

import { LocateFixed, TriangleAlert } from 'lucide-react'
import { useId, useRef, useState } from 'react'
import {
  GH_H, GH_W, RADIO_DESIGN_RANGE_M, type SiteLayout, type XY,
  centerBounds, distanceToSubstation, findOverlap, suggestPosition,
} from '@/lib/domain/layout'

export interface PickerNeighbor extends XY {
  code: string
}

interface Props {
  site: SiteLayout
  /** Invernaderos activos distintos del que se está ubicando (los dados de baja liberan su lugar). */
  neighbors: readonly PickerNeighbor[]
  /** Posición actual (centro, en metros) o null si aún no es válida. */
  value: XY | null
  onChange: (p: XY) => void
}

/**
 * Mapa del predio para ubicar un invernadero: clic o arrastre. Es una ayuda visual; los campos X e Y del
 * formulario siguen siendo la vía accesible (teclado y lector de pantalla) y la que manda.
 * Todo va en METROS, con origen en la esquina superior izquierda del predio.
 */
export function PositionPicker({ site, neighbors, value, onChange }: Props) {
  const svgRef = useRef<SVGSVGElement>(null)
  const helpId = useId()
  const [noRoom, setNoRoom] = useState(false)
  const b = centerBounds(site)
  const { x: sx, y: sy } = site.substation

  // Tamaño del texto proporcional al predio; en predios enormes se omiten los rótulos.
  const scale = Math.max(1, Math.max(site.widthM, site.heightM) / 100)
  const fontSize = Math.min(3.4 * scale, GH_H * 0.5)
  const showLabels = scale <= 3

  const clampInt = (v: number, lo: number, hi: number) => Math.min(Math.max(Math.round(v), Math.ceil(lo)), Math.floor(hi))

  const pick = (e: React.PointerEvent<SVGSVGElement>) => {
    const svg = svgRef.current
    const ctm = svg?.getScreenCTM()
    if (!svg || !ctm) return
    const p = new DOMPoint(e.clientX, e.clientY).matrixTransform(ctm.inverse())
    setNoRoom(false)
    onChange({ x: clampInt(p.x, b.minX, b.maxX), y: clampInt(p.y, b.minY, b.maxY) })
  }

  const suggest = () => {
    const p = suggestPosition(neighbors, site)
    if (!p) {
      setNoRoom(true)
      return
    }
    setNoRoom(false)
    onChange(p)
  }

  const overlap = value ? findOverlap(value, neighbors) : null
  const distance = value ? distanceToSubstation(value, site.substation) : null

  return (
    <div>
      <svg
        ref={svgRef}
        viewBox={`0 0 ${site.widthM} ${site.heightM}`}
        className="mx-auto block max-h-[250px] w-full cursor-crosshair touch-none select-none rounded-lg border border-line-strong bg-surface-2"
        role="img"
        aria-label="Mapa del predio para ubicar el invernadero. Haz clic o arrastra; también puedes escribir las coordenadas en los campos X e Y."
        aria-describedby={helpId}
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId)
          pick(e)
        }}
        onPointerMove={(e) => {
          if (e.buttons === 1) pick(e)
        }}
      >
        <rect x={0} y={0} width={site.widthM} height={site.heightM} fill="var(--good)" opacity={0.05} />
        {/* Alcance de diseño del gateway: hairline sólida */}
        <circle cx={sx} cy={sy} r={RADIO_DESIGN_RANGE_M} fill="none" stroke="var(--baseline)" strokeWidth={0.4} />
        {site.tank && <ellipse cx={site.tank.x} cy={site.tank.y} rx={3.7} ry={2.4} fill="var(--accent)" opacity={0.3} />}

        {neighbors.map((n) => (
          <g key={n.code}>
            <rect x={n.x - GH_W / 2} y={n.y - GH_H / 2} width={GH_W} height={GH_H} rx={2} fill="var(--surface)" stroke="var(--border-strong)" strokeWidth={0.5} />
            {showLabels && (
              <text x={n.x} y={n.y + fontSize * 0.35} textAnchor="middle" fontSize={fontSize} fontWeight={600} fill="var(--ink-3)">{n.code}</text>
            )}
          </g>
        ))}

        <circle cx={sx} cy={sy} r={2.6} fill="var(--ink)" stroke="var(--surface)" strokeWidth={0.7} />

        {value && (
          <g pointerEvents="none">
            <rect
              x={value.x - GH_W / 2} y={value.y - GH_H / 2} width={GH_W} height={GH_H} rx={2}
              fill="var(--accent-wash)" stroke={overlap ? 'var(--warn)' : 'var(--accent)'} strokeWidth={1}
            />
            <circle cx={value.x} cy={value.y} r={1.1} fill={overlap ? 'var(--warn)' : 'var(--accent)'} />
          </g>
        )}
      </svg>

      <div className="mt-2 flex flex-wrap items-start justify-between gap-x-3 gap-y-2">
        <p id={helpId} className="min-w-0 flex-1 text-[12px] leading-snug text-ink-3">
          {value === null ? (
            'Haz clic en el mapa o escribe las coordenadas (metros desde la esquina superior izquierda).'
          ) : (
            <>
              {distance} m de la subestación
              {distance !== null && distance > RADIO_DESIGN_RANGE_M && (
                <span className="ml-1 inline-flex items-center gap-1 text-warn-ink">
                  <TriangleAlert size={12} aria-hidden /> más lejos que el alcance de diseño del gateway ({RADIO_DESIGN_RANGE_M} m)
                </span>
              )}
              {overlap && (
                <span className="ml-1 inline-flex items-center gap-1 text-warn-ink">
                  <TriangleAlert size={12} aria-hidden /> se superpone con {overlap.code}
                </span>
              )}
            </>
          )}
          {noRoom && <span className="block text-warn-ink">No queda un lugar libre: amplía el predio en «Ajustes del predio».</span>}
        </p>
        <button type="button" className="btn btn-sm shrink-0" onClick={suggest}>
          <LocateFixed size={14} aria-hidden /> Sugerir un lugar libre
        </button>
      </div>
    </div>
  )
}
