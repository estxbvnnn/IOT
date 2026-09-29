import { Clock, Droplets, Sprout, Sun, Thermometer } from 'lucide-react'
import { BandChip, PumpChip } from '@/components/ui/status'
import { SoilMeter } from '@/components/ui/soil-meter'
import { Stat } from '@/components/ui/stat'
import { SOIL_BAND_INFO } from '@/lib/domain/soil'
import type { GreenhouseSummary } from '@/lib/domain/types'
import { fmtAgo, fmtDateTime, fmtDuration, fmtLux, fmtNum } from '@/lib/format'

/** Detalle de la bomba según lo que informó el nodo: en marcha, en espera entre riegos o lista. */
function pumpDetail(s: GreenhouseSummary): string {
  if (!s.online) return 'Último estado informado'
  if (s.pumpOn) return `En marcha hace ${fmtDuration(s.pumpRunS ?? 0)} · corte a los ${s.thresholds.pumpMaxS} s`
  if (s.pumpState === 'espera' && (s.cooldownS ?? 0) > 0) return `Espera restante ${fmtDuration(s.cooldownS)}`
  if (s.pumpState === 'bloq_temp') return `Calor: no riega sobre ${fmtNum(s.thresholds.tempMax, 0)} °C`
  if (s.pumpState === 'bloq_sensor') return 'Sin lectura válida del sensor'
  if (s.pumpState === 'saturado') return 'El suelo ya está saturado'
  return `Corte automático a los ${s.thresholds.pumpMaxS} s`
}

function SoilCard({ s }: { s: GreenhouseSummary }) {
  const t = s.thresholds
  const info = s.band ? SOIL_BAND_INFO[s.band] : null
  return (
    <div className="card px-[18px] py-4">
      <div className="flex flex-wrap items-start justify-between gap-x-8 gap-y-4">
        <div>
          <div className="flex items-center gap-2 text-[12.5px] font-medium text-ink-2">
            <Sprout size={16} className="text-ink-3" aria-hidden /> Humedad del suelo · sensor YL-38
          </div>
          <div className="mt-2 flex items-baseline gap-2">
            <span className="text-[44px] font-semibold leading-none tracking-tight text-ink">{s.soilRaw ?? '—'}</span>
            <span className="text-[13px] text-ink-3">de 1023</span>
          </div>
          <div className="mt-2.5 flex flex-wrap items-center gap-2">
            <BandChip band={s.band} />
            <span className="text-[13px] text-ink-2">{s.soilPct === null ? 'Sin dato' : `${fmtNum(s.soilPct, 1)} % de humedad`}</span>
          </div>
        </div>

        <div className="min-w-[230px] flex-1 basis-[280px] self-center">
          <SoilMeter raw={s.soilRaw} sat={t.soilSat} on={t.soilOn} ticks />
          <p className="mt-3 text-[12.5px] leading-snug text-ink-2">
            {info ? <><strong className="font-semibold text-ink">{info.advice}</strong> {info.meaning}</> : 'El sensor no entrega lectura válida.'}
          </p>
          <p className="mt-1 text-[12px] text-ink-3">
            El riego automático parte con lectura ≥ {t.soilOn} y se detiene en ≤ {t.soilOff}. A mayor lectura, más seco el suelo.
          </p>
        </div>
      </div>
    </div>
  )
}

/** Estado actual del invernadero: suelo (protagonista), temperatura, humedad del aire, luz, bomba y último dato. */
export function CurrentState({ summary: s }: { summary: GreenhouseSummary }) {
  const t = s.thresholds
  return (
    <section aria-labelledby="estado-actual" className="flex flex-col gap-3">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h2 id="estado-actual" className="text-[15px] font-semibold text-ink">Estado actual</h2>
        {!s.online && s.lastSeen && <span className="text-[12px] text-ink-3">Último valor conocido · {fmtDateTime(s.lastSeen)}</span>}
      </div>

      <SoilCard s={s} />

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <Stat
          label="Temperatura"
          icon={Thermometer}
          value={fmtNum(s.tempC, 1)}
          unit={s.tempC === null ? undefined : '°C'}
          detail={`Riego bloqueado sobre ${fmtNum(t.tempMax, 0)} °C`}
        />
        <Stat
          label="Humedad del aire"
          icon={Droplets}
          value={fmtNum(s.humAir, 1)}
          unit={s.humAir === null ? undefined : '%'}
          detail={`Rango deseado ${fmtNum(t.humAirMin, 0)}–${fmtNum(t.humAirMax, 0)} %`}
        />
        <Stat label="Luz" icon={Sun} value={fmtLux(s.lightLux)} detail={s.lightLux === null ? 'Sin sensor BH1750' : 'Sensor BH1750'} />
        <Stat
          label="Último dato"
          icon={Clock}
          value={s.lastSeen ? fmtAgo(s.ageS) : '—'}
          detail={s.lastSeen ? fmtDateTime(s.lastSeen) : 'Este nodo todavía no ha reportado'}
        />
        <Stat
          label="Bomba"
          className="col-span-2"
          value={<PumpChip state={s.pumpState} on={s.online ? s.pumpOn : false} />}
          detail={pumpDetail(s)}
        />
      </div>
    </section>
  )
}
