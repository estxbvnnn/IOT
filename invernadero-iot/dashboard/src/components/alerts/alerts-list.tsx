import Link from 'next/link'
import { BellRing, CheckCheck, CheckCircle2 } from 'lucide-react'
import { EmptyState } from '@/components/ui/card'
import { Chip, SeverityChip } from '@/components/ui/status'
import type { AlertDTO } from '@/lib/domain/types'
import { fmtAgo, fmtDateTime } from '@/lib/format'
import { AckButton } from './ack-button'
import { alertTypeLabel } from './labels'

export interface AlertsListProps {
  alerts: AlertDTO[]
  /** El usuario puede reconocer alertas (permiso alerts:ack). */
  canAck: boolean
  /** Muestra la columna del invernadero (false en el detalle de un invernadero). */
  showGreenhouse?: boolean
}

const ago = (iso: string, now: number) => fmtAgo(Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000)))

/**
 * Tabla de alertas. Estado siempre con ícono + texto; el mensaje viene del motor de alertas (o del nodo)
 * y se muestra solo como texto. Componente de servidor: solo el botón «Reconocer» es interactivo.
 */
export function AlertsList({ alerts, canAck, showGreenhouse = true }: AlertsListProps) {
  if (alerts.length === 0) {
    return (
      <EmptyState icon={CheckCircle2} title="Sin alertas">
        Cuando una variable se salga de rango o un nodo deje de reportar, aparecerá aquí.
      </EmptyState>
    )
  }
  const now = Date.now()
  return (
    <div className="overflow-x-auto">
      <table className="tbl min-w-[760px]">
        <thead>
          <tr>
            <th scope="col">Severidad</th>
            {showGreenhouse && <th scope="col">Invernadero</th>}
            <th scope="col">Alerta</th>
            <th scope="col">Estado</th>
            <th scope="col">Abierta</th>
            <th scope="col" className="text-right">Detecciones</th>
            {canAck && <th scope="col"><span className="sr-only">Acciones</span></th>}
          </tr>
        </thead>
        <tbody>
          {alerts.map((a) => (
            <tr key={a.id} data-alert-id={a.id}>
              <td className="whitespace-nowrap"><SeverityChip severity={a.severity} /></td>
              {showGreenhouse && (
                <td className="whitespace-nowrap">
                  {a.greenhouseCode ? (
                    <Link href={`/greenhouses/${a.greenhouseCode}`} className="font-semibold text-ink underline decoration-line-strong underline-offset-2 hover:decoration-accent">
                      {a.greenhouseCode}
                    </Link>
                  ) : (
                    <span className="text-ink-2">Predio</span>
                  )}
                </td>
              )}
              <td className="max-w-[440px]">
                <div className="text-[12px] font-semibold uppercase tracking-wide text-ink-3">{alertTypeLabel(a.type)}</div>
                <div className="text-ink">{a.message}</div>
              </td>
              <td className="whitespace-nowrap">
                {a.status === 'open' && <Chip tone="crit" icon={BellRing}>Abierta</Chip>}
                {a.status === 'acknowledged' && (
                  <>
                    <Chip tone="info" icon={CheckCheck}>Reconocida</Chip>
                    <div className="mt-1 text-[12px] text-ink-3">
                      {a.acknowledgedBy ? `por ${a.acknowledgedBy}` : 'por una persona'}
                      {a.acknowledgedAt ? ` · ${ago(a.acknowledgedAt, now)}` : ''}
                    </div>
                  </>
                )}
                {a.status === 'resolved' && (
                  <>
                    <Chip tone="good" icon={CheckCircle2}>Resuelta</Chip>
                    <div className="mt-1 text-[12px] text-ink-3">
                      {a.resolvedReason === 'manual' ? 'manual' : 'por el sistema'}
                      {a.resolvedAt ? ` · ${ago(a.resolvedAt, now)}` : ''}
                    </div>
                  </>
                )}
              </td>
              <td className="whitespace-nowrap">
                <div className="text-ink">{ago(a.openedAt, now)}</div>
                <div className="text-[12px] text-ink-3" title={`Última detección: ${fmtDateTime(a.lastSeenAt)}`}>{fmtDateTime(a.openedAt)}</div>
              </td>
              <td className="text-right text-ink-2">{a.occurrences}</td>
              {canAck && (
                <td className="text-right">{a.status === 'open' ? <AckButton alertId={a.id} code={a.greenhouseCode} /> : null}</td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
