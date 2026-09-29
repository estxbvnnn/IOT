import { fmtNum } from '@/lib/format'

export interface Quality {
  level: 0 | 1 | 2 | 3 | 4
  label: string
}

/**
 * Calidad de un enlace a partir de sus métricas. Si hay SNR (enlace LoRa) manda la relación señal/ruido,
 * porque LoRa decodifica bajo el ruido; si no, se usa la potencia recibida (RSSI) como en WiFi.
 */
export function linkQuality(rssi: number | null, snr: number | null): Quality {
  if (snr !== null) {
    if (snr >= 7) return { level: 4, label: 'Excelente' }
    if (snr >= 0) return { level: 3, label: 'Buena' }
    if (snr >= -7) return { level: 2, label: 'Regular' }
    return { level: 1, label: 'Débil' }
  }
  if (rssi === null) return { level: 0, label: 'Sin dato' }
  if (rssi >= -60) return { level: 4, label: 'Excelente' }
  if (rssi >= -70) return { level: 3, label: 'Buena' }
  if (rssi >= -80) return { level: 2, label: 'Regular' }
  if (rssi >= -90) return { level: 1, label: 'Débil' }
  return { level: 0, label: 'Muy débil' }
}

/**
 * Barras de intensidad (como el ícono de señal del teléfono). Son neutras a propósito: la información va en
 * el número de barras y en el texto de calidad que las acompaña, nunca solo en un color.
 */
export function SignalBars({ level, dim }: { level: 0 | 1 | 2 | 3 | 4; dim?: boolean }) {
  return (
    <span className="inline-flex h-[16px] items-end gap-[2px]" role="img" aria-label={`${level} de 4 barras`} style={{ opacity: dim ? 0.45 : 1 }}>
      {[1, 2, 3, 4].map((i) => (
        <span
          key={i}
          className="w-[4px] rounded-[1px]"
          style={{ height: 4 + i * 3, background: i <= level ? 'var(--ink)' : 'var(--grid)' }}
        />
      ))}
    </span>
  )
}

/** −61 dBm (con el signo menos tipográfico). */
export const fmtDbm = (v: number | null): string => (v === null ? '—' : `${fmtNum(v, 0).replace('-', '−')} dBm`)
