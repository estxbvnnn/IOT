import { cn } from '@/lib/cn'

interface SparklineProps {
  values: readonly (number | null)[]
  /** Color de la serie (variable CSS o color). */
  color?: string
  width?: number
  height?: number
  /** Dominio fijo del eje Y; por defecto se ajusta a los datos. */
  domain?: readonly [number, number]
  label: string
  className?: string
  /** Círculo final con anillo del color de la superficie. */
  endDot?: boolean
}

/** Sparkline: línea de 2 px, relleno al 10 % y punto final de 8 px con anillo de 2 px del color de la superficie. */
export function Sparkline({ values, color = 'var(--s1)', width = 96, height = 30, domain, label, className, endDot = true }: SparklineProps) {
  const pts = values.map((v, i) => ({ i, v })).filter((p): p is { i: number; v: number } => p.v !== null)
  if (pts.length < 2) {
    return (
      <svg width={width} height={height} role="img" aria-label={`${label}: sin datos suficientes`} className={className}>
        <line x1={0} x2={width} y1={height - 1} y2={height - 1} stroke="var(--grid)" strokeWidth={1} />
      </svg>
    )
  }
  const pad = 4
  const ys = pts.map((p) => p.v)
  const [lo, hi] = domain ?? [Math.min(...ys), Math.max(...ys)]
  const span = hi - lo || 1
  const x = (i: number) => pad + (i / Math.max(values.length - 1, 1)) * (width - pad * 2)
  const y = (v: number) => height - pad - ((v - lo) / span) * (height - pad * 2)

  // Segmentos: un valor nulo interrumpe la línea.
  const segments: { i: number; v: number }[][] = []
  let cur: { i: number; v: number }[] = []
  values.forEach((v, i) => {
    if (v === null) {
      if (cur.length) segments.push(cur)
      cur = []
    } else cur.push({ i, v })
  })
  if (cur.length) segments.push(cur)

  const line = segments.map((s) => s.map((p, k) => `${k === 0 ? 'M' : 'L'}${x(p.i).toFixed(1)} ${y(p.v).toFixed(1)}`).join(' ')).join(' ')
  const last = pts[pts.length - 1]!
  const area = segments
    .filter((s) => s.length > 1)
    .map((s) => `${s.map((p, k) => `${k === 0 ? 'M' : 'L'}${x(p.i).toFixed(1)} ${y(p.v).toFixed(1)}`).join(' ')} L${x(s[s.length - 1]!.i).toFixed(1)} ${height - pad} L${x(s[0]!.i).toFixed(1)} ${height - pad} Z`)
    .join(' ')

  return (
    <svg width={width} height={height} role="img" aria-label={`${label}: último valor ${Math.round(last.v * 10) / 10}`} className={cn('overflow-visible', className)}>
      <path d={area} fill={color} opacity={0.1} />
      <path d={line} fill="none" stroke={color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
      {endDot && (
        <circle cx={x(last.i)} cy={y(last.v)} r={4} fill={color} stroke="var(--surface)" strokeWidth={2} />
      )}
    </svg>
  )
}
