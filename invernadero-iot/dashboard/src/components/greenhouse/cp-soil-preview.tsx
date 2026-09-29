import { ADC_MAX, SOIL_BAND_INFO, type SoilBand } from '@/lib/domain/soil'

/**
 * Vista previa de las zonas del sensor de suelo con los valores que se están editando: tres bandas de la
 * tabla de la clase y un marcador donde se apaga la bomba. Puramente visual y sin hooks.
 */

const ZONE_BG: Record<SoilBand, string> = {
  saturado: 'var(--band-saturado)',
  optimo: 'var(--band-optimo)',
  seco: 'var(--band-seco)',
}

interface SoilPreviewProps {
  sat: number
  off: number
  on: number
}

const clamp = (v: number) => Math.min(Math.max(v, 0), ADC_MAX)
const pct = (v: number) => `${(clamp(v) / ADC_MAX) * 100}%`

export function SoilPreview({ sat, off, on }: SoilPreviewProps) {
  const ok = sat < off && off < on
  const rows: { id: SoilBand; range: string }[] = [
    { id: 'saturado', range: `0 – ${Math.max(sat - 1, 0)}` },
    { id: 'optimo', range: `${sat} – ${Math.max(on - 1, sat)}` },
    { id: 'seco', range: `${on} – ${ADC_MAX}` },
  ]
  const zones: { id: SoilBand; from: number; to: number }[] = [
    { id: 'saturado', from: 0, to: clamp(sat) },
    { id: 'optimo', from: clamp(sat), to: clamp(on) },
    { id: 'seco', from: clamp(on), to: ADC_MAX },
  ]
  return (
    <div className="flex flex-col gap-2.5" aria-label="Zonas del sensor de suelo con los valores del formulario">
      <div className="relative mt-4 h-2.5 w-full">
        {zones.map((z) => (
          <div
            key={z.id}
            className="absolute inset-y-0"
            style={{ left: pct(z.from), width: `calc(${pct(z.to - z.from)} - 1px)`, background: ZONE_BG[z.id] }}
            aria-hidden
          />
        ))}
        {ok && (
          <div className="absolute -top-[5px] h-[20px] w-[3px] -translate-x-1/2 rounded-full" style={{ left: pct(off), background: 'var(--ink)', boxShadow: '0 0 0 2px var(--surface)' }} aria-hidden>
            <span className="absolute -top-4 left-1/2 -translate-x-1/2 whitespace-nowrap text-[10.5px] font-semibold text-ink-2">apagar {off}</span>
          </div>
        )}
      </div>
      <div className="relative h-3 text-[10.5px] text-ink-3" aria-hidden>
        <span className="absolute left-0">0</span>
        <span className="absolute -translate-x-1/2" style={{ left: pct(sat) }}>{sat}</span>
        <span className="absolute -translate-x-1/2" style={{ left: pct(on) }}>{on}</span>
        <span className="absolute right-0">{ADC_MAX}</span>
      </div>
      <div className="overflow-x-auto rounded-lg border border-line">
        <table className="tbl">
          <thead>
            <tr><th scope="col">Lectura</th><th scope="col">Banda</th><th scope="col">Significado</th></tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td className="whitespace-nowrap font-medium text-ink">{r.range}</td>
                <td className="whitespace-nowrap text-ink">{SOIL_BAND_INFO[r.id].label}</td>
                <td className="text-ink-2">{SOIL_BAND_INFO[r.id].meaning} <strong className="font-semibold text-ink">{SOIL_BAND_INFO[r.id].advice}</strong></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-[12px] text-ink-3">
        Tabla de la clase (escala de 10 bits, 0–1023): 0–300 saturado · 300–700 óptimo · 700–1023 seco. El sensor es resistivo: a mayor lectura, más seco el suelo.
      </p>
    </div>
  )
}
