import { BarChart, type BarDatum } from '@/components/charts/bar-chart'
import { niceDomain, niceTicks } from '@/components/charts/scales'
import { type ChartBand, type ChartRef, type ChartSpan, TimeSeriesChart } from '@/components/charts/time-series-chart'
import type { GreenhouseSummary, IrrigationEventDTO, Point, RangeKey, SeriesBundle } from '@/lib/domain/types'
import { RANGE_SPECS } from '@/lib/domain/types'
import { TZ, fmtDM, fmtDay, fmtDuration, fmtNum } from '@/lib/format'

/**
 * Gráficos del invernadero como PEQUEÑOS MÚLTIPLOS: cada uno con una sola serie y una sola escala
 * (jamás doble eje). Colores fijos por variable en toda la app: suelo azul (--s1), temperatura naranja
 * (--s2), humedad del aire aqua (--s3), luz amarillo (--s4), señal RSSI violeta (--s7).
 */

const SPAN_LABEL: Record<IrrigationEventDTO['trigger'], string> = {
  auto: 'Riego automático',
  manual: 'Riego manual',
  schedule: 'Riego programado',
}

const hasData = (pts: readonly Point[]): boolean => pts.some((p) => p[1] !== null)
const valuesOf = (pts: readonly Point[]): number[] => pts.map((p) => p[1]).filter((v): v is number => v !== null)

/**
 * Eje Y de la temperatura: se ajusta a los datos, pero si el valor se acerca a un umbral de la
 * configuración (calor, frío, bloqueo de riego) el eje se amplía para que la línea de referencia se vea.
 */
function tempDomain(pts: readonly Point[], t: GreenhouseSummary['thresholds']): [number, number] | undefined {
  const vals = valuesOf(pts)
  if (vals.length === 0) return undefined
  const hi0 = Math.max(...vals)
  const lo0 = Math.min(...vals)
  let [lo, hi] = niceDomain(vals)
  if (t.tempHeat - hi0 <= 6) hi = Math.max(hi, t.tempHeat + 2)
  if (hi0 >= t.tempHeat) hi = Math.max(hi, Math.min(t.tempMax, hi0 + 3) + 2)
  if (lo0 - t.tempCold <= 6) lo = Math.min(lo, t.tempCold - 2)
  const ticks = niceTicks(lo, hi, 5)
  return [Math.min(lo, ticks[0] ?? lo), Math.max(hi, ticks[ticks.length - 1] ?? hi)]
}

const dayFmt = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' })
/** Fecha LOCAL del predio (America/Santiago) como AAAA-MM-DD. */
const localDay = (ms: number): string => dayFmt.format(ms)

/** Litros estimados por día local, con todos los días del rango (también los sin riego). */
function waterByDay(series: SeriesBundle, range: RangeKey): BarDatum[] {
  const days: string[] = []
  const step = 6 * 3_600_000
  for (let t = series.from; t < series.to + step; t += step) {
    const d = localDay(Math.min(t, series.to))
    if (!days.includes(d)) days.push(d)
  }
  const agg = new Map<string, { l: number; n: number; s: number }>()
  for (const e of series.events) {
    const d = localDay(Date.parse(e.startedAt))
    const a = agg.get(d) ?? { l: 0, n: 0, s: 0 }
    a.l += e.waterL ?? 0
    a.n += 1
    a.s += e.durationS ?? 0
    agg.set(d, a)
  }
  const label = (d: string) => {
    const noon = Date.parse(`${d}T15:00:00Z`) // 15:00 UTC = mediodía en Santiago: cae siempre en ese día local
    return range === '30d' ? fmtDM(noon) : fmtDay(noon)
  }
  return days.map((d) => {
    const a = agg.get(d)
    return {
      key: d,
      label: label(d),
      value: Math.round((a?.l ?? 0) * 10) / 10,
      detail: a ? `${a.n} ${a.n === 1 ? 'riego' : 'riegos'} · ${fmtDuration(a.s)}` : 'Sin riegos',
    }
  })
}

interface GreenhouseChartsProps {
  summary: GreenhouseSummary
  series: SeriesBundle
  range: RangeKey
}

export function GreenhouseCharts({ summary, series, range }: GreenhouseChartsProps) {
  const t = summary.thresholds
  const spec = RANGE_SPECS[range]
  // Un hueco mayor a 3 intervalos (de reporte o de promedio) corta la línea: el nodo no reportó.
  const gapMs = Math.max(series.bucketS * 3, t.intervalS * 3) * 1000
  const base = { from: series.from, to: series.to, gapMs }

  // Ventanas de riego. Se ensanchan medio promedio por lado: el tooltip trabaja con la marca de cada
  // promedio, y un riego de 30 s quedaría fuera de la ventana exacta de su promedio.
  const pad = series.bucketS * 500
  const spans: ChartSpan[] = series.events
    .map((e) => ({
      start: Date.parse(e.startedAt) - pad,
      end: e.endedAt ? Date.parse(e.endedAt) + pad : null,
      label: `${SPAN_LABEL[e.trigger]}${e.durationS !== null && e.endedAt ? ` · ${fmtDuration(e.durationS)}` : e.endedAt ? '' : ' · en curso'}`,
    }))
    .filter((s) => (s.end ?? series.to) >= series.from && s.start <= series.to)
    .sort((a, b) => a.start - b.start)

  const soilBands: ChartBand[] = [
    { from: 0, to: t.soilSat, label: 'Saturado', fill: 'var(--band-saturado)' },
    { from: t.soilSat, to: t.soilOn, label: 'Óptimo', fill: 'var(--band-optimo)' },
    { from: t.soilOn, to: 1024, label: 'Seco', fill: 'var(--band-seco)' },
  ]
  const soilRefs: ChartRef[] = [
    { value: t.soilOn, label: `Inicia riego · ${t.soilOn}` },
    { value: t.soilOff, label: `Detiene riego · ${t.soilOff}` },
  ]

  const tempRefs: ChartRef[] = [
    { value: t.tempMax, label: `Bloqueo de riego · ${fmtNum(t.tempMax, 0)} °C` },
    { value: t.tempHeat, label: `Aviso de calor · ${fmtNum(t.tempHeat, 0)} °C` },
    { value: t.tempCold, label: `Aviso de frío · ${fmtNum(t.tempCold, 0)} °C` },
    { value: t.tempFrost, label: `Helada · ${fmtNum(t.tempFrost, 0)} °C` },
  ]
  const humRefs: ChartRef[] = [
    { value: t.humAirMax, label: `Humedad alta · ${fmtNum(t.humAirMax, 0)} %` },
    { value: t.humAirMin, label: `Aire seco · ${fmtNum(t.humAirMin, 0)} %` },
  ]

  const water = range === '1h' || range === '6h' ? null : waterByDay(series, range)

  return (
    <div className="flex flex-col gap-5">
      <TimeSeriesChart
        {...base}
        title="Humedad del suelo"
        subtitle="Sensor YL-38 · escala 0–1023 (a mayor lectura, más seco) · bandas de la tabla de la clase"
        series={[{ id: 'suelo', label: 'Humedad del suelo', unit: '', color: 'var(--s1)', points: series.soilRaw, digits: 0 }]}
        yDomain={[0, 1023]}
        bands={soilBands}
        refLines={soilRefs}
        spans={spans}
        spanLegend="Riego"
        endLabel
        height={280}
      />

      <div className="grid gap-5 2xl:grid-cols-2">
        <TimeSeriesChart
          {...base}
          title="Temperatura"
          subtitle="Sensor DHT22 · promedio de cada intervalo"
          series={[{ id: 'temp', label: 'Temperatura', unit: '°C', color: 'var(--s2)', points: series.temp, digits: 1 }]}
          yDomain={tempDomain(series.temp, t)}
          refLines={tempRefs}
          area
          endLabel
          height={210}
        />
        <TimeSeriesChart
          {...base}
          title="Humedad del aire"
          subtitle="Sensor DHT22 · promedio de cada intervalo"
          series={[{ id: 'hum', label: 'Humedad del aire', unit: '%', color: 'var(--s3)', points: series.humAir, digits: 1 }]}
          yDomain={[0, 100]}
          refLines={humRefs}
          area
          endLabel
          height={210}
        />
        {hasData(series.light) && (
          <TimeSeriesChart
            {...base}
            title="Luz"
            subtitle="Sensor BH1750 · intensidad lumínica"
            series={[{ id: 'luz', label: 'Luz', unit: 'lx', color: 'var(--s4)', points: series.light, digits: 0 }]}
            yMin={0}
            area
            endLabel
            height={210}
          />
        )}
        {series.rssi !== null && hasData(series.rssi) && (
          <TimeSeriesChart
            {...base}
            title="Señal del nodo (RSSI)"
            subtitle="Calidad del enlace: mientras más cerca de 0 dBm, mejor"
            series={[{ id: 'rssi', label: 'Señal', unit: 'dBm', color: 'var(--s7)', points: series.rssi, digits: 0 }]}
            endLabel
            height={210}
          />
        )}
        {water && (
          <BarChart
            title="Agua estimada por día"
            subtitle={`Según el tiempo de bomba y el caudal del invernadero · ${spec.label.toLowerCase()}`}
            data={water}
            unit="L"
            digits={1}
            valueLabel="Agua"
            height={210}
          />
        )}
      </div>
    </div>
  )
}
