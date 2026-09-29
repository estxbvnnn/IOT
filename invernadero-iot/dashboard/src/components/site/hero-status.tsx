import { CheckCircle2 } from 'lucide-react'
import { Chip, STATUS_META } from '@/components/ui/status'
import type { SiteOverview } from '@/lib/domain/types'

type Kpis = SiteOverview['kpis']

const PHRASE: { key: 'critical' | 'warning' | 'offline' | 'nodata'; text: (n: number) => string }[] = [
  { key: 'critical', text: (n) => (n === 1 ? '1 crítico' : `${n} críticos`) },
  { key: 'warning', text: (n) => `${n} en atención` },
  { key: 'offline', text: (n) => `${n} sin conexión` },
  { key: 'nodata', text: (n) => `${n} sin datos` },
]

/**
 * La cifra principal del panel — exactamente UNA por vista, en la misma sans que el resto (nunca en cifras
 * tabulares): cuántos invernaderos operan con normalidad, y qué pasa con los demás.
 */
export function HeroStatus({ kpis }: { kpis: Kpis }) {
  const allOk = kpis.total > 0 && kpis.ok === kpis.total
  const summary = `${kpis.ok} de ${kpis.total} invernaderos operando con normalidad`
  return (
    <section className="card flex flex-col justify-between gap-5 px-[22px] py-5 sm:flex-row sm:items-center xl:flex-col xl:items-stretch" aria-label="Estado general del predio">
      <div>
        <p className="sr-only">{summary}</p>
        <div className="flex items-baseline gap-3" aria-hidden>
          <span className="text-[56px] font-semibold leading-none tracking-tight text-ink">{kpis.ok}</span>
          <span className="text-[22px] font-medium text-ink-3">de {kpis.total}</span>
        </div>
        <p className="mt-2 text-[15px] text-ink-2" aria-hidden>invernaderos operando con normalidad</p>
      </div>
      <div className="flex flex-wrap items-center gap-2 sm:justify-end xl:justify-start">
        {PHRASE.map(({ key, text }) => {
          const n = kpis[key]
          if (n <= 0) return null
          const m = STATUS_META[key]
          return <Chip key={key} tone={m.tone} icon={m.icon} className="h-[28px] text-[13px]">{text(n)}</Chip>
        })}
        {allOk && <Chip tone="good" icon={CheckCircle2} className="h-[28px] text-[13px]">Sin novedades</Chip>}
        {kpis.total === 0 && <span className="text-[13px] text-ink-3">Sin invernaderos para mostrar</span>}
      </div>
    </section>
  )
}
