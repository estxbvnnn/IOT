import type { Metadata } from 'next'
import { AlertsList } from '@/components/alerts/alerts-list'
import { FilterBar } from '@/components/admin/filter-bar'
import { listGreenhouseOptions } from '@/components/admin/greenhouse-options'
import { PageHeader } from '@/components/admin/page-header'
import { AutoRefresh } from '@/components/ui/auto-refresh'
import { Card } from '@/components/ui/card'
import { SeverityChip } from '@/components/ui/status'
import { getDb } from '@/lib/db'
import { requirePermission } from '@/lib/dal'
import type { Severity } from '@/lib/domain/types'
import { can } from '@/lib/rbac'
import { listAlerts } from '@/lib/services/alerts'

export const metadata: Metadata = { title: 'Alertas' }

type SearchParams = Promise<Record<string, string | string[] | undefined>>
const one = (v: string | string[] | undefined): string => (Array.isArray(v) ? (v[0] ?? '') : (v ?? ''))
const STATES = ['active', 'resolved', 'all'] as const
const SEVERITIES: readonly Severity[] = ['critical', 'warning', 'info']
/** Texto para lectores de pantalla (el chip ya trae su propia etiqueta visible). */
const SEVERITY_PLURAL: Record<Severity, string> = { critical: 'críticas', warning: 'avisos', info: 'informativas' }

export default async function AlertsPage({ searchParams }: { searchParams: SearchParams }) {
  const user = await requirePermission('alerts:view')
  const sp = await searchParams
  const state = (STATES as readonly string[]).includes(one(sp.estado)) ? (one(sp.estado) as (typeof STATES)[number]) : 'active'
  const severity = (SEVERITIES as readonly string[]).includes(one(sp.severidad)) ? (one(sp.severidad) as Severity) : undefined

  const db = getDb()
  const options = await listGreenhouseOptions(db, user)
  // Solo se acepta un invernadero de los que el usuario puede ver: un código ajeno se ignora sin avisar.
  const selected = options.find((o) => o.code === one(sp.invernadero))

  // Se consulta sin filtrar por severidad para poder mostrar el resumen completo; la severidad filtra la tabla.
  const all = await listAlerts(db, user, { state, greenhouseId: selected?.id, limit: 200 })
  const shown = severity ? all.filter((a) => a.severity === severity) : all
  const count = (s: Severity) => all.filter((a) => a.severity === s).length

  const canAck = can(user.role, 'alerts:ack')
  const title = state === 'active' ? 'Alertas activas' : state === 'resolved' ? 'Alertas resueltas' : 'Todas las alertas'

  return (
    <>
      <PageHeader
        title="Alertas"
        subtitle={
          user.role === 'operator'
            ? 'Avisos de tus sectores asignados y del predio. Reconocer una alerta indica que te haces cargo de ella.'
            : 'Avisos cuando una variable se sale de rango, un sensor falla o un nodo deja de reportar. Se despejan solas al volver a la normalidad.'
        }
        actions={<AutoRefresh generatedAt={new Date().toISOString()} />}
      />

      <FilterBar
        fields={[
          {
            name: 'estado', label: 'Estado', value: state === 'active' ? '' : state,
            options: [{ value: '', label: 'Activas' }, { value: 'resolved', label: 'Resueltas' }, { value: 'all', label: 'Todas' }],
          },
          {
            name: 'severidad', label: 'Severidad', value: severity ?? '',
            options: [{ value: '', label: 'Todas' }, { value: 'critical', label: 'Crítica' }, { value: 'warning', label: 'Aviso' }, { value: 'info', label: 'Info' }],
          },
          ...(options.length > 1
            ? [{
                name: 'invernadero', label: 'Invernadero', value: selected?.code ?? '',
                options: [{ value: '', label: 'Todos' }, ...options.map((o) => ({ value: o.code, label: `${o.code} · ${o.name.replace('Invernadero ', 'Inv. ')}` }))],
              }]
            : []),
        ]}
      />

      <Card
        flush
        title={title}
        description={`${shown.length} ${shown.length === 1 ? 'alerta' : 'alertas'}${all.length >= 200 ? ' (se muestran las 200 más relevantes)' : ''}`}
        action={
          <ul className="flex flex-wrap items-center gap-2" aria-label="Resumen por severidad">
            {SEVERITIES.map((s) => (
              <li key={s} className="flex items-center gap-1.5">
                <SeverityChip severity={s} />
                <span className="text-[13px] font-semibold text-ink" aria-label={`${count(s)} ${SEVERITY_PLURAL[s]}`}>{count(s)}</span>
              </li>
            ))}
          </ul>
        }
      >
        <AlertsList alerts={shown} canAck={canAck} showGreenhouse />
      </Card>
    </>
  )
}
