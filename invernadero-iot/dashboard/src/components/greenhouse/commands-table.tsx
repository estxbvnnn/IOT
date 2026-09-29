import { Droplets, History, Square } from 'lucide-react'
import { Card, EmptyState } from '@/components/ui/card'
import { fmtDateTime, fmtHMS } from '@/lib/format'
import type { CommandDTO } from '@/lib/services/commands'
import { CommandStatusChip, commandSourceLabel, commandTypeLabel } from './cp-command-status'

export interface CommandsTableProps {
  commands: CommandDTO[]
}

/** Recorrido de la orden en texto corto: «confirmada 14:32:05 · entregada 14:32:35 · acuse 14:32:36». */
function timeline(c: CommandDTO): string {
  const parts: string[] = []
  if (c.status === 'awaiting_confirmation' && c.confirmExpiresAt) parts.push(`confirmar antes de ${fmtHMS(c.confirmExpiresAt)}`)
  if (c.confirmedAt) parts.push(`confirmada ${fmtHMS(c.confirmedAt)}`)
  if (c.deliveredAt) parts.push(`entregada ${fmtHMS(c.deliveredAt)}`)
  if (c.ackedAt) parts.push(`acuse ${fmtHMS(c.ackedAt)}`)
  if (c.status === 'queued' && c.expiresAt) parts.push(`vence ${fmtHMS(c.expiresAt)}`)
  return parts.join(' · ')
}

/**
 * Historial de órdenes del invernadero: quién pidió qué, cuándo, y qué respondió el nodo.
 * Componente de servidor (sin hooks). El detalle del nodo (`resultDetail`) es texto que envía el
 * dispositivo: se muestra tal cual, escapado por React, nunca como HTML.
 */
export function CommandsTable({ commands }: CommandsTableProps) {
  return (
    <Card
      id="ordenes"
      title="Órdenes recientes"
      description="Riego manual, calendarios y detenciones de la bomba de este invernadero."
      flush
    >
      {commands.length === 0 ? (
        <EmptyState icon={History} title="Aún no hay órdenes">
          Cuando alguien solicite un riego o un calendario se ejecute, quedará registrado aquí con la respuesta del nodo.
        </EmptyState>
      ) : (
        <div className="overflow-x-auto" tabIndex={0} role="region" aria-label="Órdenes recientes (desplazable)">
          <table className="tbl min-w-[720px]">
            <thead>
              <tr>
                <th scope="col">Fecha</th>
                <th scope="col">Orden</th>
                <th scope="col">Origen</th>
                <th scope="col">Solicitada por</th>
                <th scope="col">Estado</th>
                <th scope="col">Detalle del nodo</th>
              </tr>
            </thead>
            <tbody>
              {commands.map((c) => {
                const line = timeline(c)
                return (
                  <tr key={c.id}>
                    <td className="whitespace-nowrap text-ink-2">{fmtDateTime(c.createdAt)}</td>
                    <td className="whitespace-nowrap">
                      <span className="inline-flex items-center gap-1.5 font-medium text-ink">
                        {c.type === 'stop' ? <Square size={14} className="text-ink-3" aria-hidden /> : <Droplets size={14} className="text-ink-3" aria-hidden />}
                        {commandTypeLabel(c)}
                      </span>
                    </td>
                    <td className="whitespace-nowrap text-ink-2">{commandSourceLabel(c.source)}</td>
                    <td className="text-ink-2">{c.requestedBy ?? '—'}</td>
                    <td>
                      <CommandStatusChip status={c.status} />
                      {line && <div className="mt-1 text-[11.5px] leading-snug text-ink-3">{line}</div>}
                    </td>
                    <td className="max-w-[260px] text-ink-2">{c.resultDetail ?? '—'}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  )
}
