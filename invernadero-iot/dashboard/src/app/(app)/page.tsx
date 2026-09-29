import type { Metadata } from 'next'
import { Sprout } from 'lucide-react'
import { AutoRefresh } from '@/components/ui/auto-refresh'
import { Card, EmptyState } from '@/components/ui/card'
import { GreenhouseTable } from '@/components/site/greenhouse-table'
import { HeroStatus } from '@/components/site/hero-status'
import { KpiRow } from '@/components/site/kpi-row'
import { MapHelp, MapLegend } from '@/components/site/map-legend'
import { toMapItems } from '@/components/site/map-data'
import { RecentAlerts } from '@/components/site/recent-alerts'
import { SiteMap } from '@/components/site/site-map'
import { getDb } from '@/lib/db'
import { requirePermission } from '@/lib/dal'
import { fmtHM } from '@/lib/format'
import { can } from '@/lib/rbac'
import { getSiteOverview } from '@/lib/services/queries'

export const metadata: Metadata = { title: 'Predio' }

const TABLE_ID = 'tabla-invernaderos'
const MAP_HELP_ID = 'mapa-descripcion'

/**
 * Panel principal: el predio completo (o, para un operador, solo sus sectores: el servicio ya filtra por
 * alcance). Se actualiza solo cada 10 s sin esqueletos ni saltos.
 */
export default async function OverviewPage() {
  const user = await requirePermission('site:view')
  const overview = await getSiteOverview(getDb(), user)
  const canViewAlerts = can(user.role, 'alerts:view')
  const linkable = can(user.role, 'greenhouse:view')
  const empty = overview.greenhouses.length === 0

  return (
    <div className="flex flex-col gap-5">
      <header className="flex flex-wrap items-end justify-between gap-x-4 gap-y-2">
        <div>
          <h1 className="text-[24px] font-semibold leading-tight tracking-tight text-ink">Predio</h1>
          <p className="mt-0.5 text-[13.5px] text-ink-3">
            {overview.siteName} · datos de las {fmtHM(overview.generatedAt)} (hora del predio)
          </p>
        </div>
        <AutoRefresh generatedAt={overview.generatedAt} />
      </header>

      {empty ? (
        <Card>
          <EmptyState icon={Sprout} title="Sin sectores asignados">
            Tu cuenta todavía no tiene invernaderos asignados. Pide al administrador que te asigne uno o más sectores para ver su estado y operar el riego.
          </EmptyState>
        </Card>
      ) : (
        <>
          <div className="grid gap-3 xl:grid-cols-[340px_minmax(0,1fr)]">
            <HeroStatus kpis={overview.kpis} />
            <KpiRow overview={overview} />
          </div>

          <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)]">
            <div className="order-2 lg:order-1">
              <Card
                title="Mapa del predio"
                description={`${overview.widthM.toLocaleString('es-CL')} × ${overview.heightM.toLocaleString('es-CL')} m · un nodo por invernadero y una subestación con el mástil de 6 m`}
              >
                <SiteMap
                  items={toMapItems(overview.greenhouses)}
                  widthM={overview.widthM}
                  heightM={overview.heightM}
                  substation={overview.substation}
                  linkable={linkable}
                  describedBy={MAP_HELP_ID}
                />
                <MapHelp describedById={MAP_HELP_ID} tableId={TABLE_ID} />
                {/* En pantallas pequeñas la leyenda va bajo el mapa; en escritorio, en la columna derecha. */}
                <div className="mt-3 border-t border-line pt-3 lg:hidden">
                  <MapLegend greenhouses={overview.greenhouses} plain />
                </div>
              </Card>
            </div>
            <div className="order-1 flex flex-col gap-5 lg:order-2">
              {canViewAlerts && (
                <RecentAlerts alerts={overview.recentAlerts} nowIso={overview.generatedAt} showAllLink linkable={linkable} />
              )}
              <Card title="Cómo leer el mapa" className="hidden lg:block">
                <MapLegend greenhouses={overview.greenhouses} plain />
              </Card>
            </div>
          </div>

          <GreenhouseTable greenhouses={overview.greenhouses} linkable={linkable} id={TABLE_ID} />
        </>
      )}
    </div>
  )
}
