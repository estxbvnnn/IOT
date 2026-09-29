import { Bell, Droplet, Droplets, Sprout, Thermometer, Wind } from 'lucide-react'
import { Sparkline } from '@/components/ui/sparkline'
import { Stat } from '@/components/ui/stat'
import { soilPct } from '@/lib/domain/soil'
import type { SiteOverview } from '@/lib/domain/types'
import { fmtNum } from '@/lib/format'
import { WindMeter } from './wind-meter'

const plural = (n: number, one: string, many: string) => `${fmtNum(n, 0)} ${n === 1 ? one : many}`

/** Promedio, celda a celda, de las tendencias de suelo de los nodos en línea (24 tramos de 15 min). */
function averageSoilTrend(overview: SiteOverview): (number | null)[] {
  const live = overview.greenhouses.filter((g) => g.online)
  return Array.from({ length: 24 }, (_, i) => {
    const vals = live.map((g) => g.soilSpark[i]).filter((v): v is number => v !== null && v !== undefined)
    if (vals.length === 0) return null
    return soilPct(vals.reduce((a, b) => a + b, 0) / vals.length)
  })
}

/**
 * Seis cifras del predio. Regla de la guía: una cifra sola no necesita un gráfico; la tendencia (sparkline)
 * solo se muestra donde hay una serie real (el suelo, de las últimas 6 h).
 */
export function KpiRow({ overview }: { overview: SiteOverview }) {
  const { kpis, wind, greenhouses } = overview
  const live = greenhouses.filter((g) => g.online).length
  const optimal = greenhouses.map((g) => g.optimalPct24h).filter((v): v is number => v !== null)
  const optimalAvg = optimal.length ? Math.round(optimal.reduce((a, b) => a + b, 0) / optimal.length) : null
  const trend = averageSoilTrend(overview)
  const hasTrend = trend.filter((v) => v !== null).length >= 2
  const crit = greenhouses.reduce((a, g) => a + g.openAlerts.critical, 0) + (wind.level === 'critical' ? 1 : 0)
  const warn = greenhouses.reduce((a, g) => a + g.openAlerts.warning, 0) + (wind.level === 'warning' ? 1 : 0)
  const noOnline = live === 0

  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">
      <Stat
        label="Temperatura media"
        icon={Thermometer}
        value={fmtNum(kpis.avgTempC)}
        unit="°C"
        detail={noOnline ? 'Sin nodos en línea' : `${live} de ${greenhouses.length} en línea`}
      />
      <Stat
        label="Humedad del aire media"
        icon={Droplet}
        value={fmtNum(kpis.avgHumAir, 0)}
        unit="%"
        detail={noOnline ? 'Sin nodos en línea' : `${live} de ${greenhouses.length} en línea`}
      />
      <Stat
        label="Humedad del suelo media"
        icon={Sprout}
        value={fmtNum(kpis.avgSoilPct, 0)}
        unit="%"
        detail={optimalAvg === null ? (noOnline ? 'Sin nodos en línea' : 'Sin historial de 24 h') : <span title="Porcentaje del tiempo con el suelo en banda óptima, últimas 24 horas">Óptimo 24 h: {optimalAvg} %</span>}
        trend={hasTrend ? <span className="hidden sm:block"><Sparkline values={trend} domain={[0, 100]} color="var(--s1)" width={68} height={30} label="Tendencia de la humedad media del suelo, últimas 6 horas" /></span> : undefined}
      />
      <Stat
        label="Viento del mástil"
        icon={Wind}
        value={wind.level === 'nodata' ? '—' : fmtNum(wind.ms)}
        unit={wind.level === 'nodata' ? undefined : 'm/s'}
        detail={<WindMeter wind={wind} />}
        className="[&_.truncate]:overflow-visible [&_.truncate]:whitespace-normal"
      />
      <Stat
        label="Agua usada hoy"
        icon={Droplets}
        value={fmtNum(kpis.waterTodayL, kpis.waterTodayL >= 100 ? 0 : 1)}
        unit="L"
        detail={`${plural(kpis.irrigationsToday, 'riego', 'riegos')} · ${plural(kpis.pumpsOn, 'bomba activa', 'bombas activas')}`}
      />
      <Stat
        label="Alertas activas"
        icon={Bell}
        iconClassName={crit > 0 ? 'text-crit' : warn > 0 ? 'text-warn-ink' : undefined}
        value={fmtNum(kpis.activeAlerts, 0)}
        detail={kpis.activeAlerts === 0 ? 'Sin alertas activas' : `${plural(crit, 'crítica', 'críticas')} · ${plural(warn, 'aviso', 'avisos')}`}
      />
    </div>
  )
}
