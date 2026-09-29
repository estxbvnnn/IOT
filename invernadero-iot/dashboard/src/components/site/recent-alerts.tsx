import { BellOff } from 'lucide-react'
import Link from 'next/link'
import { Card, EmptyState } from '@/components/ui/card'
import { SeverityChip } from '@/components/ui/status'
import type { AlertDTO } from '@/lib/domain/types'
import { fmtAgo } from '@/lib/format'

/**
 * Últimas alertas activas del predio (la página /alerts tiene el listado completo y permite reconocerlas).
 * `nowIso` es la hora con la que se generó la página, para que la antigüedad no dependa del reloj del cliente.
 */
export function RecentAlerts({ alerts, nowIso, showAllLink, linkable }: { alerts: readonly AlertDTO[]; nowIso: string; showAllLink: boolean; linkable: boolean }) {
  const now = new Date(nowIso).getTime()
  return (
    <Card
      title="Alertas recientes"
      description="Las más urgentes primero"
      flush
      action={
        showAllLink ? (
          <Link href="/alerts" className="btn btn-sm">Ver todas</Link>
        ) : undefined
      }
    >
      {alerts.length === 0 ? (
        <EmptyState icon={BellOff} title="Sin alertas activas">Cuando una variable salga de rango o un nodo deje de reportar, aparecerá aquí.</EmptyState>
      ) : (
        <ul className="divide-y divide-line">
          {alerts.map((a) => {
            const ageS = Math.max(0, Math.round((now - new Date(a.openedAt).getTime()) / 1000))
            return (
              <li key={a.id} className="flex items-start gap-3 px-[18px] py-3">
                <SeverityChip severity={a.severity} className="mt-0.5 shrink-0" />
                <div className="min-w-0 flex-1">
                  <p className="text-[13px] leading-snug text-ink">{a.message}</p>
                  <p className="mt-1 flex flex-wrap items-center gap-x-1.5 text-[12px] text-ink-3">
                    {a.greenhouseCode ? (
                      linkable ? (
                        <Link href={`/greenhouses/${a.greenhouseCode}`} prefetch={false} className="font-semibold text-ink underline-offset-2 hover:underline">{a.greenhouseCode}</Link>
                      ) : (
                        <span className="font-semibold text-ink">{a.greenhouseCode}</span>
                      )
                    ) : (
                      <span className="font-semibold text-ink">Predio</span>
                    )}
                    <span aria-hidden>·</span>
                    <span>abierta {fmtAgo(ageS)}</span>
                    {a.status === 'acknowledged' && (
                      <>
                        <span aria-hidden>·</span>
                        <span>reconocida{a.acknowledgedBy ? ` por ${a.acknowledgedBy}` : ''}</span>
                      </>
                    )}
                  </p>
                </div>
              </li>
            )
          })}
        </ul>
      )}
    </Card>
  )
}
