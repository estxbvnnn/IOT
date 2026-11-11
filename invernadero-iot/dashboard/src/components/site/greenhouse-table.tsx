import Link from 'next/link'
import { Card, EmptyState } from '@/components/ui/card'
import { SoilMeter } from '@/components/ui/soil-meter'
import { Sparkline } from '@/components/ui/sparkline'
import { BandChip, PumpChip, STATUS_META, StatusChip } from '@/components/ui/status'
import type { GreenhouseSummary } from '@/lib/domain/types'
import { fmtAgo, fmtDuration, fmtNum } from '@/lib/format'
import { cn } from '@/lib/cn'
import { Sprout } from 'lucide-react'
import { RowLinks } from './row-links'

/** Crítico, atención, sin conexión, sin datos, normal; y dentro de cada grupo por número de invernadero. */
export function sortBySeverity(gs: readonly GreenhouseSummary[]): GreenhouseSummary[] {
  return [...gs].sort((a, b) => STATUS_META[a.status].rank - STATUS_META[b.status].rank || a.id - b.id)
}

/**
 * Tabla «Invernaderos»: es a la vez el resumen principal y el GEMELO ACCESIBLE del mapa (mismos datos,
 * en texto). Un nodo que no reporta muestra su último valor conocido atenuado, sin afirmar que la
 * bomba sigue regando.
 */
export function GreenhouseTable({ greenhouses, linkable, id }: { greenhouses: readonly GreenhouseSummary[]; linkable: boolean; id: string }) {
  const rows = sortBySeverity(greenhouses)
  return (
    <Card
      id={id}
      title="Invernaderos"
      description="Ordenados por gravedad. En la tendencia, la línea sube cuando el suelo se seca (lectura cruda del sensor, 0–1023)."
      flush
    >
      {rows.length === 0 ? (
        <EmptyState icon={Sprout} title="Sin invernaderos para mostrar">
          Si eres operador, pide al administrador que te asigne uno o más sectores.
        </EmptyState>
      ) : (
        <RowLinks className="overflow-x-auto">
          <table className="tbl min-w-[1000px]">
            <caption className="sr-only">Estado actual de cada invernadero: temperatura, humedad del aire, humedad del suelo, luz y bomba</caption>
            <thead>
              <tr>
                <th scope="col">Invernadero</th>
                <th scope="col">Estado</th>
                <th scope="col">Temp.</th>
                <th scope="col">Hum. aire</th>
                <th scope="col">Suelo (0–1023)</th>
                <th scope="col">Flujo de agua</th>
                <th scope="col">Bomba</th>
                <th scope="col">Tendencia suelo 6 h</th>
                <th scope="col">Última lectura</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((g) => {
                const href = `/greenhouses/${g.code}`
                const stale = !g.online
                const dim = stale ? 'opacity-60' : undefined
                return (
                  <tr key={g.code} data-href={linkable ? href : undefined} className={cn(linkable && 'cursor-pointer')}>
                    <td role="rowheader">
                      {linkable ? (
                        <Link href={href} prefetch={false} className="block font-semibold text-ink underline-offset-2 hover:underline">
                          {g.code}
                        </Link>
                      ) : (
                        <span className="block font-semibold text-ink">{g.code}</span>
                      )}
                      <span className="text-[12px] text-ink-3">{g.crop ?? g.name}</span>
                    </td>
                    <td><StatusChip status={g.status} /></td>
                    <td className={dim} title={stale ? 'Último valor conocido' : undefined}>{g.tempC === null ? '—' : `${fmtNum(g.tempC)} °C`}</td>
                    <td className={dim} title={stale ? 'Último valor conocido' : undefined}>{g.humAir === null ? '—' : `${fmtNum(g.humAir, 0)} %`}</td>
                    <td className={dim} title={stale ? 'Último valor conocido' : undefined}>
                      <div className="w-[150px]">
                        <SoilMeter raw={g.soilRaw} sat={g.thresholds.soilSat} on={g.thresholds.soilOn} />
                        <div className="mt-1.5 flex items-center justify-between gap-2">
                          <span className="text-[12.5px] font-semibold text-ink">{g.soilRaw ?? '—'}</span>
                          <BandChip band={g.band} />
                        </div>
                      </div>
                    </td>
                    <td className={dim}>{g.flowLmin === null ? '—' : `${fmtNum(g.flowLmin, 2)} L/min`}</td>
                    <td>
                      {stale ? (
                        <span className="text-ink-3" title="Sin conexión: estado de la bomba desconocido">—</span>
                      ) : (
                        <div className="flex flex-col items-start gap-0.5">
                          <PumpChip state={g.pumpState} on={g.pumpOn} />
                          {g.pumpOn && g.pumpRunS ? <span className="text-[11.5px] text-ink-3">{fmtDuration(g.pumpRunS)} regando</span> : null}
                          {!g.pumpOn && g.pumpState === 'espera' && g.cooldownS ? (
                            <span className="text-[11.5px] text-ink-3">quedan {Math.max(1, Math.ceil(g.cooldownS / 60))} min</span>
                          ) : null}
                        </div>
                      )}
                    </td>
                    <td className={dim}>
                      <Sparkline values={g.soilSpark} domain={[0, 1023]} color="var(--s1)" width={92} height={28} label={`${g.code}: lectura del suelo, últimas 6 horas (mayor lectura = más seco)`} />
                    </td>
                    <td className="whitespace-nowrap text-ink-2">{g.ageS === null ? 'sin datos' : fmtAgo(g.ageS)}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </RowLinks>
      )}
    </Card>
  )
}
