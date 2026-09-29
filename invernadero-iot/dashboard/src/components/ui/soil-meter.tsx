import { ADC_MAX, type SoilBand, SOIL_BAND_INFO, soilBand } from '@/lib/domain/soil'
import { cn } from '@/lib/cn'

/**
 * Medidor del sensor de suelo YL-38 en su escala real 0–1023, dividido en las tres bandas de la tabla
 * de la clase (saturado · óptimo · seco). Un marcador indica la lectura actual.
 * Las bandas usan lavados suaves; el marcador y el texto llevan la información (no solo el color).
 */
interface SoilMeterProps {
  raw: number | null
  /** Límites del invernadero (por defecto los de la imagen: 300 y 700). */
  sat?: number
  on?: number
  className?: string
  /** Muestra las etiquetas de los límites debajo de la barra. */
  ticks?: boolean
}

const ZONE_BG: Record<SoilBand, string> = {
  saturado: 'var(--band-saturado)',
  optimo: 'var(--band-optimo)',
  seco: 'var(--band-seco)',
}
const ZONE_EDGE: Record<SoilBand, string> = {
  saturado: 'var(--accent)',
  optimo: 'var(--good)',
  seco: 'var(--serious)',
}

export function SoilMeter({ raw, sat = 300, on = 700, className, ticks = false }: SoilMeterProps) {
  const pct = (v: number) => `${(Math.min(Math.max(v, 0), ADC_MAX) / ADC_MAX) * 100}%`
  const band = raw === null ? null : soilBand(raw, { sat, on })
  const zones: { id: SoilBand; from: number; to: number }[] = [
    { id: 'saturado', from: 0, to: sat },
    { id: 'optimo', from: sat, to: on },
    { id: 'seco', from: on, to: ADC_MAX },
  ]
  return (
    <div
      className={cn('w-full', className)}
      role="img"
      aria-label={raw === null ? 'Humedad del suelo: sin dato' : `Humedad del suelo: lectura ${raw} de 1023, banda ${SOIL_BAND_INFO[band!].label}`}
    >
      <div className="relative h-2 w-full overflow-visible rounded-full">
        {zones.map((z, i) => (
          <div
            key={z.id}
            className="absolute inset-y-0"
            style={{
              left: `calc(${pct(z.from)} + ${i === 0 ? 0 : 1}px)`,
              width: `calc(${pct(z.to - z.from)} - ${i === 0 ? 1 : 2}px)`,
              background: ZONE_BG[z.id],
              borderRadius: i === 0 ? '999px 0 0 999px' : i === 2 ? '0 999px 999px 0' : 0,
              boxShadow: band === z.id ? `inset 0 -2px 0 ${ZONE_EDGE[z.id]}` : undefined,
            }}
          />
        ))}
        {raw !== null && (
          <div
            className="absolute -top-[3px] h-[14px] w-[3px] -translate-x-1/2 rounded-full"
            style={{ left: pct(raw), background: 'var(--ink)', boxShadow: '0 0 0 2px var(--surface)' }}
          />
        )}
      </div>
      {ticks && (
        <div className="relative mt-1 h-3 text-[10.5px] text-ink-3">
          <span className="absolute left-0">0</span>
          <span className="absolute -translate-x-1/2" style={{ left: pct(sat) }}>{sat}</span>
          <span className="absolute -translate-x-1/2" style={{ left: pct(on) }}>{on}</span>
          <span className="absolute right-0">1023</span>
        </div>
      )}
    </div>
  )
}
