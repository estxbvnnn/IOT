'use client'

import { AlertOctagon, AlertTriangle, CheckCircle2, CircleDashed, WifiOff } from 'lucide-react'
import Link from 'next/link'
import { useEffect, useMemo, useRef, useState } from 'react'
import { StatusChip } from '@/components/ui/status'
import { ADC_MAX } from '@/lib/domain/soil'
import type { GreenhouseStatus } from '@/lib/domain/types'
import { fmtAgo, fmtNum } from '@/lib/format'
import { BAND_TEXT, type MapGreenhouse, describeGreenhouse, pumpText } from './map-data'

/**
 * Mapa del predio: réplica de la figura 2 del informe con datos en vivo.
 * El SVG está en METROS (viewBox = predio + margen); cada invernadero mide ~19 × 11 m, como en la figura.
 *
 * Accesibilidad y reglas de visualización:
 *  - cada invernadero es un enlace por teclado con aria-label completo (estado en texto, no solo color);
 *  - el estado se codifica con borde + fondo + GLIFO distinto por estado (ícono), y con texto en la leyenda;
 *  - la tabla de invernaderos de la misma página es el gemelo accesible del mapa (aria-describedby);
 *  - rejilla/anillos son hairlines SÓLIDAS (nunca punteadas); la distancia solo aparece al pasar el foco.
 */

const MARGIN = 6
const GH_W = 19
const GH_H = 11
const TREE_BAND = 6

const STATUS_STYLE: Record<GreenhouseStatus, { stroke: string; fill: string; glyph: string; Icon: typeof CheckCircle2 }> = {
  ok: { stroke: 'var(--good)', fill: 'var(--surface)', glyph: 'var(--good)', Icon: CheckCircle2 },
  warning: { stroke: 'var(--warn)', fill: 'var(--warn-wash)', glyph: 'var(--warn-ink)', Icon: AlertTriangle },
  critical: { stroke: 'var(--crit)', fill: 'var(--crit-wash)', glyph: 'var(--crit)', Icon: AlertOctagon },
  offline: { stroke: 'var(--muted)', fill: 'var(--off-wash)', glyph: 'var(--ink-3)', Icon: WifiOff },
  nodata: { stroke: 'var(--muted)', fill: 'var(--off-wash)', glyph: 'var(--ink-3)', Icon: CircleDashed },
}

/** Zonas del mini-medidor de suelo: mismos tonos que las bandas del resto de la interfaz. */
const ZONE = { saturado: 'var(--accent)', optimo: 'var(--good)', seco: 'var(--serious)' } as const

interface SiteMapProps {
  items: MapGreenhouse[]
  widthM: number
  heightM: number
  substation: { x: number; y: number }
  /** Los invernaderos son enlaces al detalle (rol con permiso greenhouse:view). */
  linkable?: boolean
  /** id de la tabla equivalente. */
  describedBy?: string
}

export function SiteMap({ items, widthM, heightM, substation, linkable = true, describedBy }: SiteMapProps) {
  const wrapRef = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(560)
  const [hover, setHover] = useState<string | null>(null)
  const [focus, setFocus] = useState<string | null>(null)

  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const ro = new ResizeObserver(([e]) => e && setWidth(Math.floor(e.contentRect.width)))
    ro.observe(el)
    setWidth(Math.floor(el.clientWidth) || 560)
    return () => ro.disconnect()
  }, [])

  const compact = width < 470
  const vbW = widthM + MARGIN * 2
  const vbH = heightM + MARGIN * 2
  const activeCode = hover ?? focus
  const active = useMemo(() => items.find((g) => g.code === activeCode) ?? null, [items, activeCode])
  const { x: sx, y: sy } = substation

  // Árboles del perímetro (sutiles): una fila por lado a media franja.
  const trees = useMemo(() => {
    const out: [number, number][] = []
    const half = TREE_BAND / 2
    for (let x = half; x <= widthM - half + 0.01; x += 8) {
      out.push([x, half], [x, heightM - half])
    }
    for (let y = half + 8; y <= heightM - half - 7.99; y += 8) {
      out.push([half, y], [widthM - half, y])
    }
    return out
  }, [widthM, heightM])

  return (
    <div ref={wrapRef} className="relative w-full select-none">
      <svg
        viewBox={`${-MARGIN} ${-MARGIN} ${vbW} ${vbH}`}
        className="block h-auto w-full"
        role="group"
        aria-label="Mapa del predio con los diez invernaderos y la subestación del mástil"
        aria-describedby={describedBy}
      >
        {/* Terreno y franja perimetral de árboles y vegetación */}
        <rect x={0} y={0} width={widthM} height={heightM} rx={1.4} fill="var(--good)" opacity={0.045} />
        <path
          d={`M0 0H${widthM}V${heightM}H0Z M${TREE_BAND} ${TREE_BAND}V${heightM - TREE_BAND}H${widthM - TREE_BAND}V${TREE_BAND}Z`}
          fillRule="evenodd"
          fill="var(--good)"
          opacity={0.07}
        />
        {trees.map(([tx, ty]) => (
          <circle key={`${tx}-${ty}`} cx={tx} cy={ty} r={1.15} fill="var(--good)" opacity={0.2} />
        ))}
        <rect x={0} y={0} width={widthM} height={heightM} rx={1.4} fill="none" stroke="var(--border-strong)" strokeWidth={0.3} />

        {/* Cobertura de radio: hairlines sólidas */}
        <circle cx={sx} cy={sy} r={35} fill="var(--accent)" opacity={0.05} />
        <circle cx={sx} cy={sy} r={35} fill="none" stroke="var(--baseline)" strokeWidth={0.3} />
        <circle cx={sx} cy={sy} r={71} fill="none" stroke="var(--baseline)" strokeWidth={0.3} />
        {!compact && (
          <g fontSize={2.15} fill="var(--ink-3)">
            <text x={sx - 33} y={sy + 0.6}>Cobertura</text>
            <text x={sx - 33} y={sy + 3.2}>holgada 35 m</text>
            <text x={widthM - TREE_BAND - 1.5} y={TREE_BAND + 3.4} textAnchor="end">Cobertura necesaria</text>
            <text x={widthM - TREE_BAND - 1.5} y={TREE_BAND + 6} textAnchor="end">71 m (esquinas)</text>
          </g>
        )}
        {compact && (
          <g fontSize={2.6} fill="var(--ink-3)">
            <text x={sx - 33} y={sy + 0.8}>35 m</text>
            <text x={widthM - TREE_BAND - 1.5} y={TREE_BAND + 4} textAnchor="end">71 m</text>
          </g>
        )}

        {/* Estanque de acumulación de agua */}
        <g>
          <title>Estanque de acumulación de agua</title>
          <ellipse cx={76} cy={56} rx={3.7} ry={2.4} fill="var(--accent)" opacity={0.3} stroke="var(--accent)" strokeWidth={0.3} />
          {!compact && <text x={76} y={60.6} textAnchor="middle" fontSize={2} fill="var(--ink-3)">Estanque</text>}
        </g>

        {/* Distancia a la subestación: solo del invernadero que tiene el foco */}
        {active && (
          <g pointerEvents="none">
            <line x1={sx} y1={sy} x2={active.x} y2={active.y} stroke="var(--ink-2)" strokeWidth={0.3} />
            <g transform={`translate(${(sx + active.x) / 2} ${(sy + active.y) / 2})`}>
              <rect x={-5.2} y={-2.1} width={10.4} height={4.2} rx={1} fill="var(--surface)" stroke="var(--border-strong)" strokeWidth={0.25} />
              <text y={1.05} textAnchor="middle" fontSize={2.7} fontWeight={600} fill="var(--ink)">{active.distanceM} m</text>
            </g>
          </g>
        )}

        {/* Invernaderos */}
        {items.map((g) => (
          <GreenhouseCell
            key={g.code}
            g={g}
            compact={compact}
            linkable={linkable}
            active={activeCode === g.code}
            focused={focus === g.code}
            onHover={(v) => setHover(v ? g.code : null)}
            onFocusChange={(v) => setFocus(v ? g.code : null)}
          />
        ))}

        {/* Subestación (gateway + anemómetro en el mástil de 6 m) */}
        <g>
          <title>Subestación de campo: gateway LoRaWAN + anemómetro en un mástil de 6 m</title>
          <g transform={`translate(${sx} ${sy + 5})`} pointerEvents="none">
            <rect x={compact ? -8.5 : -19.5} y={0} width={compact ? 17 : 39} height={compact ? 4.6 : 7.4} rx={1.3} fill="var(--surface)" stroke="var(--border-strong)" strokeWidth={0.25} opacity={0.96} />
            <text y={compact ? 3.3 : 3} textAnchor="middle" fontSize={compact ? 2.8 : 2.7} fontWeight={700} fill="var(--ink)">Subestación</text>
            {!compact && (
              <text y={6} textAnchor="middle" fontSize={2.05} fill="var(--ink-2)">gateway + anemómetro · mástil 6 m</text>
            )}
          </g>
          <circle cx={sx} cy={sy} r={2.8} fill="var(--ink)" stroke="var(--surface)" strokeWidth={0.8} />
          <circle cx={sx} cy={sy} r={1} fill="var(--surface)" />
        </g>
      </svg>

      {/* Tooltip: el valor primero y la etiqueta después */}
      {active && <MapTooltip g={active} vbW={vbW} vbH={vbH} />}
    </div>
  )
}

interface CellProps {
  g: MapGreenhouse
  compact: boolean
  linkable: boolean
  active: boolean
  focused: boolean
  onHover: (v: boolean) => void
  onFocusChange: (v: boolean) => void
}

function GreenhouseCell({ g, compact, linkable, active, focused, onHover, onFocusChange }: CellProps) {
  const s = STATUS_STYLE[g.status]
  const { Icon } = s
  const left = g.x - GH_W / 2
  const top = g.y - GH_H / 2
  const meterX = g.x - 8.4
  const meterW = 16.8
  const frac = (v: number) => Math.min(Math.max(v / ADC_MAX, 0), 1)
  const zoneBand = g.soilRaw !== null && g.online

  const body = (
    <g opacity={g.online ? 1 : 0.92}>
      {/* Anillo de foco de teclado */}
      {focused && (
        <rect x={left - 1.2} y={top - 1.2} width={GH_W + 2.4} height={GH_H + 2.4} rx={3.1} fill="none" stroke="var(--focus)" strokeWidth={0.7} />
      )}
      <rect x={left} y={top} width={GH_W} height={GH_H} rx={2.2} fill="var(--surface)" />
      <rect x={left} y={top} width={GH_W} height={GH_H} rx={2.2} fill={s.fill} stroke={s.stroke} strokeWidth={active ? 1.15 : 0.75} />
      {/* Código y glifo de estado */}
      <text x={left + 1.3} y={g.y - 1.4} fontSize={3.5} fontWeight={700} fill="var(--ink)">{g.code}</text>
      <Icon x={left + GH_W - 5.6} y={top + 0.9} width={4.2} height={4.2} strokeWidth={2.3} color={s.glyph} />
      {/* Lectura (temperatura) o antigüedad si el nodo no reporta */}
      {!compact && (
        <text x={left + 1.3} y={g.y + 2.2} fontSize={2.7} fill={g.online ? 'var(--ink-2)' : 'var(--ink-3)'}>
          {g.status === 'nodata' ? 'sin datos' : g.online ? (g.tempC === null ? '—' : `${fmtNum(g.tempC)} °C`) : fmtAgo(g.ageS)}
        </text>
      )}
      {/* Nodo del invernadero: se rellena y pulsa mientras la bomba riega */}
      {g.pumpOn && <circle className="pump-pulse" cx={left + GH_W - 3.4} cy={g.y + 1.4} r={1.5} fill="none" stroke="var(--accent)" strokeWidth={0.5} />}
      <circle cx={left + GH_W - 3.4} cy={g.y + 1.4} r={1.5} fill={g.pumpOn ? 'var(--accent)' : 'var(--surface)'} stroke={g.pumpOn ? 'var(--accent)' : 'var(--ink-2)'} strokeWidth={0.45} />
      {/* Mini-medidor del suelo (0–1023) con sus bandas y la lectura */}
      <g>
        <rect x={meterX} y={top + 9.1} width={meterW} height={1.2} rx={0.6} fill="var(--grid)" />
        {zoneBand && (
          <>
            <rect x={meterX} y={top + 9.1} width={meterW * frac(g.satLimit)} height={1.2} rx={0.6} fill={ZONE.saturado} opacity={0.55} />
            <rect x={meterX + meterW * frac(g.satLimit)} y={top + 9.1} width={meterW * (frac(g.onLimit) - frac(g.satLimit))} height={1.2} fill={ZONE.optimo} opacity={0.55} />
            <rect x={meterX + meterW * frac(g.onLimit)} y={top + 9.1} width={meterW * (1 - frac(g.onLimit))} height={1.2} rx={0.6} fill={ZONE.seco} opacity={0.6} />
            <rect x={meterX + meterW * frac(g.soilRaw!) - 0.3} y={top + 8.55} width={0.65} height={2.2} rx={0.3} fill="var(--ink)" stroke="var(--surface)" strokeWidth={0.25} />
          </>
        )}
      </g>
    </g>
  )

  if (!linkable) {
    return (
      <g
        onPointerEnter={() => onHover(true)}
        onPointerLeave={() => onHover(false)}
        role="img"
        aria-label={describeGreenhouse(g)}
      >
        {body}
      </g>
    )
  }

  return (
    <Link
      href={`/greenhouses/${g.code}`}
      prefetch={false}
      aria-label={describeGreenhouse(g)}
      onPointerEnter={() => onHover(true)}
      onPointerLeave={() => onHover(false)}
      onFocus={(e) => onFocusChange(e.currentTarget.matches(':focus-visible'))}
      onBlur={() => onFocusChange(false)}
      className="cursor-pointer outline-none"
    >
      {body}
    </Link>
  )
}

function MapTooltip({ g, vbW, vbH }: { g: MapGreenhouse; vbW: number; vbH: number }) {
  const px = ((g.x + MARGIN) / vbW) * 100
  const below = g.y < 34
  const py = ((g.y + (below ? GH_H / 2 : -GH_H / 2) + MARGIN) / vbH) * 100
  const shiftX = px < 26 ? '-12%' : px > 74 ? '-88%' : '-50%'
  const rows: { value: string; label: string }[] = g.online
    ? [
        { value: g.tempC === null ? '—' : `${fmtNum(g.tempC)} °C`, label: 'Temperatura' },
        { value: g.humAir === null ? '—' : `${fmtNum(g.humAir, 0)} %`, label: 'Humedad del aire' },
        { value: g.soilRaw === null || !g.band ? '—' : `${g.soilRaw} · ${BAND_TEXT[g.band]}`, label: 'Suelo (0–1023)' },
        { value: pumpText(g), label: 'Bomba' },
        { value: fmtAgo(g.ageS), label: 'Última lectura' },
      ]
    : [
        { value: g.ageS === null ? 'sin lecturas' : fmtAgo(g.ageS), label: 'Última lectura' },
        { value: 'sin datos', label: 'Bomba' },
      ]
  return (
    <div
      className="pointer-events-none absolute z-10 w-[230px] max-w-[70%] rounded-lg border border-line-strong bg-surface px-3 py-2.5 text-[12px] shadow-[0_8px_24px_rgb(0_0_0/0.18)]"
      style={{
        left: `${px}%`,
        top: `${py}%`,
        transform: `translate(${shiftX}, ${below ? '10px' : 'calc(-100% - 10px)'})`,
      }}
      role="status"
    >
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <div className="min-w-0">
          <div className="truncate text-[13px] font-semibold text-ink">{g.code}{g.crop ? ` · ${g.crop}` : ''}</div>
          <div className="text-[11.5px] text-ink-3">{g.distanceM} m de la subestación</div>
        </div>
        <StatusChip status={g.status} />
      </div>
      {rows.map((r) => (
        <div key={r.label} className="flex items-baseline gap-1.5 leading-[1.55]">
          <strong className="text-[12.5px] font-semibold text-ink">{r.value}</strong>
          <span className="text-ink-3">{r.label}</span>
        </div>
      ))}
    </div>
  )
}
