import { Bot, CalendarClock, Droplets, Hand } from 'lucide-react'
import { Card, EmptyState } from '@/components/ui/card'
import type { IrrigationEventDTO } from '@/lib/domain/types'
import { fmtDateTime, fmtDuration, fmtLiters } from '@/lib/format'

/** Motivo de término de un riego, en lenguaje de operación (docs/contrato-api.md §2.1). */
export const END_REASON_LABEL: Record<string, string> = {
  objetivo: 'Humedad objetivo alcanzada',
  tiempo_max: 'Corte por tiempo máximo',
  orden: 'Por orden',
  seguridad: 'Corte de seguridad (falla del sensor)',
  saturado: 'Suelo saturado',
  desconocido: 'Sin información',
}

export const TRIGGER_LABEL: Record<IrrigationEventDTO['trigger'], string> = {
  auto: 'Automático',
  manual: 'Manual',
  schedule: 'Calendario',
}

const TRIGGER_ICON = { auto: Bot, manual: Hand, schedule: CalendarClock } as const

const MAX_ROWS = 25

interface EventsTableProps {
  events: readonly IrrigationEventDTO[]
  rangeLabel: string
}

/** Riegos del rango elegido: cuándo, cuánto, quién los inició, por qué terminaron y cuánta agua se estima. */
export function EventsTable({ events, rangeLabel }: EventsTableProps) {
  const shown = events.slice(0, MAX_ROWS)
  const totalWater = events.reduce((a, e) => a + (e.waterL ?? 0), 0)
  return (
    <Card
      id="riegos"
      title="Riegos del rango"
      description={
        events.length === 0
          ? `Sin riegos en ${rangeLabel.toLowerCase()}.`
          : `${events.length} ${events.length === 1 ? 'riego' : 'riegos'} en ${rangeLabel.toLowerCase()} · ${fmtLiters(totalWater)} estimados`
      }
      flush
    >
      {events.length === 0 ? (
        <EmptyState icon={Droplets} title="No hubo riegos en este rango">
          Cuando la bomba se encienda (automática o manualmente) el riego aparecerá aquí con su motivo de término.
        </EmptyState>
      ) : (
        <>
          <div className="overflow-x-auto">
            <table className="tbl min-w-[640px]">
              <thead>
                <tr>
                  <th scope="col">Inicio</th>
                  <th scope="col">Duración</th>
                  <th scope="col">Origen</th>
                  <th scope="col">Término</th>
                  <th scope="col" className="text-right">Agua</th>
                  <th scope="col" className="text-right" title="Lectura del suelo (0–1023) al empezar y al terminar el riego">Suelo (ini → fin)</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((e) => {
                  const Icon = TRIGGER_ICON[e.trigger]
                  return (
                    <tr key={e.id}>
                      <td className="whitespace-nowrap text-ink">{fmtDateTime(e.startedAt)}</td>
                      <td className="whitespace-nowrap">{e.endedAt === null ? <span className="text-ink-2">En curso…</span> : fmtDuration(e.durationS)}</td>
                      <td className="whitespace-nowrap">
                        <span className="inline-flex items-center gap-1.5 text-ink-2"><Icon size={14} className="text-ink-3" aria-hidden />{TRIGGER_LABEL[e.trigger]}</span>
                      </td>
                      <td className="text-ink-2">{e.endReason ? (END_REASON_LABEL[e.endReason] ?? e.endReason) : '—'}</td>
                      <td className="whitespace-nowrap text-right">{fmtLiters(e.waterL)}</td>
                      <td className="whitespace-nowrap text-right text-ink-2">{e.soilRawStart ?? '—'} <span aria-hidden>→</span><span className="sr-only">a</span> {e.soilRawEnd ?? '—'}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
          {events.length > MAX_ROWS && (
            <p className="border-t border-line px-[18px] py-2.5 text-[12px] text-ink-3">
              Se muestran los {MAX_ROWS} más recientes de {events.length}. Exporta el CSV para ver el historial completo.
            </p>
          )}
        </>
      )}
    </Card>
  )
}
