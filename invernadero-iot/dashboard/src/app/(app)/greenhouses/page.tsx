import type { Metadata } from 'next'
import { Info } from 'lucide-react'
import { GreenhousesManager } from '@/components/admin/greenhouses-manager'
import { NewGreenhouseButton } from '@/components/admin/new-greenhouse-dialog'
import { PageHeader } from '@/components/admin/page-header'
import { SiteSettingsButton } from '@/components/admin/site-settings-dialog'
import { Card } from '@/components/ui/card'
import { getDb } from '@/lib/db'
import { requirePermission } from '@/lib/dal'
import { suggestPosition } from '@/lib/domain/layout'
import { getSiteSettings, listManagedGreenhouses } from '@/lib/services/greenhouses'

export const metadata: Metadata = { title: 'Invernaderos' }

/**
 * Administración de invernaderos (solo el administrador, permiso greenhouses:manage). La cantidad NO es fija:
 * se pueden sumar, editar y dar de baja desde aquí, y el predio (mapa) se ajusta a su tamaño.
 */
export default async function GreenhousesAdminPage() {
  const admin = await requirePermission('greenhouses:manage')
  const db = getDb()
  const [items, site] = await Promise.all([listManagedGreenhouses(db, admin), getSiteSettings(db, admin)])
  const active = items.filter((g) => !g.archived)
  const archived = items.length - active.length
  const suggested = suggestPosition(active, { widthM: site.widthM, heightM: site.heightM, substation: site.substation, tank: site.tank })

  return (
    <>
      <PageHeader
        title="Invernaderos"
        subtitle="Suma, edita o da de baja invernaderos cuando el predio cambie. Cada uno se crea con su nodo ESP32 y sus umbrales de riego."
        actions={
          <>
            <SiteSettingsButton site={site} />
            <NewGreenhouseButton
              site={site}
              active={active.map((g) => ({ id: g.id, code: g.code, name: g.name, x: g.x, y: g.y }))}
              suggested={suggested}
            />
          </>
        }
      />

      <Card
        flush
        title="Invernaderos del predio"
        description={`${active.length} ${active.length === 1 ? 'activo' : 'activos'}${archived > 0 ? ` · ${archived} ${archived === 1 ? 'dado de baja' : 'dados de baja'}` : ''} · predio de ${site.widthM.toLocaleString('es-CL')} × ${site.heightM.toLocaleString('es-CL')} m`}
      >
        <GreenhousesManager items={items} site={site} nowMs={Date.now()} />
      </Card>

      <aside className="card mt-4 flex items-start gap-3 px-[18px] py-4 text-[13px] leading-relaxed text-ink-2" aria-label="Notas sobre la administración de invernaderos">
        <Info size={17} className="mt-0.5 shrink-0 text-ink-3" aria-hidden />
        <div className="flex flex-col gap-1.5">
          <p>
            <strong className="text-ink">No hay un máximo fijo</strong>: agrega invernaderos a medida que instales nodos. Cada alta genera el token de su nodo, que se muestra una sola vez;
            el servidor guarda únicamente su huella (SHA-256).
          </p>
          <p>
            Los invernaderos <strong className="text-ink">no se borran</strong>: se dan de baja, para conservar su historial, sus riegos y la trazabilidad en la bitácora. Un invernadero dado de baja no aparece en el panel y su nodo
            queda deshabilitado; se puede reactivar. El nodo físico sigue regando de forma autónoma hasta que se apague.
          </p>
          <p>
            Un invernadero nuevo <strong className="text-ink">no lo ve ningún operador</strong> hasta que lo asignes en Usuarios (el administrador, el agrónomo, el técnico y el dueño ven todos).
          </p>
        </div>
      </aside>
    </>
  )
}
