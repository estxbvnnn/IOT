import type { Metadata } from 'next'
import Link from 'next/link'
import { ChevronRight, LockKeyhole } from 'lucide-react'
import { AUDIT_GROUPS } from '@/components/admin/audit-labels'
import { AuditTable } from '@/components/admin/audit-table'
import { FilterBar } from '@/components/admin/filter-bar'
import { PageHeader } from '@/components/admin/page-header'
import { VerifyChain } from '@/components/admin/verify-chain'
import { Card, EmptyState } from '@/components/ui/card'
import { getDb } from '@/lib/db'
import { requirePermission } from '@/lib/dal'
import { listAudit } from '@/lib/services/audit'

export const metadata: Metadata = { title: 'Bitácora' }

type SearchParams = Promise<Record<string, string | string[] | undefined>>
const one = (v: string | string[] | undefined): string => (Array.isArray(v) ? (v[0] ?? '') : (v ?? ''))
const PAGE = 50

export default async function AuditPage({ searchParams }: { searchParams: SearchParams }) {
  const user = await requirePermission('audit:view')
  const sp = await searchParams

  const prefijo = AUDIT_GROUPS.some((g) => g.prefix !== '' && g.prefix === one(sp.prefijo)) ? one(sp.prefijo) : ''
  const actor = one(sp.actor).trim().slice(0, 80)
  // Cursor de paginación: debe ser un entero seguro. Un valor como 1e21 llegaría a la base como bigint fuera
  // de rango y provocaría un error 500 con solo editar la URL.
  const beforeRaw = Number(one(sp.antes))
  const beforeId = Number.isSafeInteger(beforeRaw) && beforeRaw > 0 ? beforeRaw : undefined

  const page = await listAudit(getDb(), { limit: PAGE, beforeId, actionPrefix: prefijo || undefined, actor: actor || undefined })

  const nextQuery = (before: number) => {
    const q = new URLSearchParams()
    if (prefijo) q.set('prefijo', prefijo)
    if (actor) q.set('actor', actor)
    q.set('antes', String(before))
    return `/audit?${q.toString()}`
  }

  return (
    <>
      <PageHeader
        title="Bitácora de auditoría"
        subtitle={
          user.role === 'admin'
            ? 'Registro de todo lo que ocurre en el sistema: accesos, órdenes al riego, cambios de configuración y actividad de los nodos.'
            : 'Registro de solo lectura de los accesos, órdenes al riego, cambios de configuración y actividad de los nodos.'
        }
        actions={<VerifyChain />}
      />

      <FilterBar
        fields={[
          {
            name: 'prefijo', label: 'Tipo de acción', value: prefijo,
            options: AUDIT_GROUPS.map((g) => ({ value: g.prefix, label: g.label })),
          },
          { name: 'actor', label: 'Actor', type: 'text', value: actor, placeholder: 'correo, nodo:I3 o sistema' },
        ]}
      />

      <Card
        flush
        title={beforeId ? 'Registros más antiguos' : 'Registros más recientes'}
        description={`${page.rows.length} ${page.rows.length === 1 ? 'registro' : 'registros'} en esta página · el más nuevo arriba`}
      >
        {page.rows.length === 0 ? (
          <EmptyState icon={LockKeyhole} title="Sin registros">No hay registros que coincidan con los filtros.</EmptyState>
        ) : (
          <AuditTable rows={page.rows} />
        )}
        {(page.nextBefore !== null || beforeId) && (
          <nav aria-label="Paginación" className="flex items-center justify-between gap-3 border-t border-line px-[18px] py-3">
            {beforeId ? (
              <Link href={`/audit${prefijo || actor ? `?${new URLSearchParams({ ...(prefijo ? { prefijo } : {}), ...(actor ? { actor } : {}) }).toString()}` : ''}`} className="btn btn-sm">Volver a los más recientes</Link>
            ) : <span />}
            {page.nextBefore !== null && (
              <Link href={nextQuery(page.nextBefore)} className="btn btn-sm">
                Más antiguos <ChevronRight size={14} aria-hidden />
              </Link>
            )}
          </nav>
        )}
      </Card>

      <aside className="card mt-4 flex items-start gap-3 px-[18px] py-4 text-[13px] leading-relaxed text-ink-2" aria-label="Por qué la bitácora es confiable">
        <LockKeyhole size={17} className="mt-0.5 shrink-0 text-ink-3" aria-hidden />
        <p>
          <strong className="text-ink">La aplicación solo puede insertar y leer</strong> esta bitácora: la base de datos rechaza modificar o borrar registros
          (permisos y un disparador que lo impide incluso al dueño de la tabla). Además, cada fila guarda el hash SHA-256 de la anterior: si alguien
          alterara un registro por otra vía, «Verificar integridad de la cadena» señalaría exactamente cuál se rompió.
        </p>
      </aside>
    </>
  )
}
