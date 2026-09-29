import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { AlertsList } from '@/components/alerts/alerts-list'
import { GreenhouseCharts } from '@/components/greenhouse/charts'
import { CommandsTable } from '@/components/greenhouse/commands-table'
import { CurrentState } from '@/components/greenhouse/current-state'
import { EventsTable } from '@/components/greenhouse/events-table'
import { GreenhouseHeader } from '@/components/greenhouse/header'
import { IrrigationPanel } from '@/components/greenhouse/irrigation-panel'
import { RangeFilter } from '@/components/greenhouse/range-filter'
import { SchedulesPanel } from '@/components/greenhouse/schedules-panel'
import { ThresholdsPanel } from '@/components/greenhouse/thresholds-panel'
import { Card } from '@/components/ui/card'
import { getDb } from '@/lib/db'
import { requirePermission } from '@/lib/dal'
import { GREENHOUSE_CODE_RE } from '@/lib/domain/greenhouse'
import { RANGE_SPECS, type RangeKey, isRangeKey } from '@/lib/domain/types'
import { can, canOnGreenhouse } from '@/lib/rbac'
import { listCommands } from '@/lib/services/commands'
import { getGreenhouseDetail, resolveGreenhouse } from '@/lib/services/queries'
import { listSchedules } from '@/lib/services/schedules'

interface Props {
  params: Promise<{ code: string }>
  searchParams: Promise<Record<string, string | string[] | undefined>>
}

export async function generateMetadata({ params }: Pick<Props, 'params'>): Promise<Metadata> {
  const { code } = await params
  return { title: GREENHOUSE_CODE_RE.test(code) ? `Invernadero ${code}` : 'Invernadero' }
}

/**
 * Detalle de un invernadero: estado actual, gráficos, riegos y los paneles de control según el rol.
 * La autorización se verifica AQUÍ (no en el layout): permiso de ver + alcance sobre el sector.
 * Un sector ajeno responde igual que uno inexistente (404), sin revelar cuáles existen.
 */
export default async function GreenhousePage({ params, searchParams }: Props) {
  const user = await requirePermission('greenhouse:view')
  const { code } = await params
  const db = getDb()
  const id = await resolveGreenhouse(db, user, code)
  if (id === null) notFound()

  const sp = await searchParams
  const raw = Array.isArray(sp.range) ? sp.range[0] : sp.range
  const range: RangeKey = isRangeKey(raw) ? raw : '24h'

  const [detail, commands, schedules] = await Promise.all([
    getGreenhouseDetail(db, user, id, range),
    listCommands(db, user, id, 10),
    listSchedules(db, user, id),
  ])
  const { summary, series, alerts } = detail

  return (
    <div className="flex flex-col gap-5">
      <GreenhouseHeader summary={summary} canExport={can(user.role, 'export:csv')} range={range} generatedAt={new Date().toISOString()} />

      {/*
        Una sola estructura para dos disposiciones. En pantallas estrechas los hijos se apilan con el panel de
        riego justo después del estado actual (display: contents + order). Desde 1280 px son dos columnas:
        la principal (estado, gráficos, riegos) y la lateral (controles, órdenes y alertas).
      */}
      <div className="flex flex-col gap-5 xl:grid xl:grid-cols-[minmax(0,1fr)_360px] xl:items-start xl:gap-6">
        <div className="contents xl:flex xl:min-w-0 xl:flex-col xl:gap-5">
          <div className="order-1">
            <CurrentState summary={summary} />
          </div>
          <div className="order-3 flex min-w-0 flex-col gap-5">
            <RangeFilter code={summary.code} current={range} from={series.from} to={series.to} />
            <GreenhouseCharts summary={summary} series={series} range={range} />
            <EventsTable events={series.events} rangeLabel={RANGE_SPECS[range].label} />
          </div>
        </div>

        <div className="contents xl:flex xl:min-w-0 xl:flex-col xl:gap-5">
          <div className="order-2">
            <IrrigationPanel greenhouse={summary} canCommand={canOnGreenhouse(user, 'irrigation:command', id)} />
          </div>
          <div className="order-4">
            <ThresholdsPanel greenhouseId={id} greenhouseCode={summary.code} thresholds={summary.thresholds} canEdit={can(user.role, 'thresholds:edit')} />
          </div>
          <div className="order-5">
            <SchedulesPanel greenhouseId={id} schedules={schedules} canEdit={can(user.role, 'schedules:edit')} pumpMaxS={summary.thresholds.pumpMaxS} />
          </div>
          <div className="order-6">
            <CommandsTable commands={commands} />
          </div>
          <div className="order-7">
            <Card
              id="alertas-invernadero"
              title="Alertas del invernadero"
              description={alerts.some((a) => a.status !== 'resolved') ? 'Hay alertas activas en este sector.' : 'Sin alertas activas en este sector.'}
              flush
            >
              <AlertsList alerts={alerts} canAck={can(user.role, 'alerts:ack')} showGreenhouse={false} />
            </Card>
          </div>
        </div>
      </div>
    </div>
  )
}
