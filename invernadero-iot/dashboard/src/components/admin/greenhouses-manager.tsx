'use client'

import Link from 'next/link'
import { Archive, ArchiveRestore, CheckCircle2, Loader2, Pencil, Sprout, TriangleAlert } from 'lucide-react'
import { useState, useTransition } from 'react'
import { archiveGreenhouseAction, restoreGreenhouseAction, updateGreenhouseAction } from '@/app/actions/greenhouses'
import { EmptyState } from '@/components/ui/card'
import { Dialog } from '@/components/ui/dialog'
import { Chip } from '@/components/ui/status'
import { distanceToSubstation } from '@/lib/domain/layout'
import type { ManagedGreenhouseDTO, SiteSettingsDTO } from '@/lib/domain/types'
import { fmtAgo, fmtNum } from '@/lib/format'
import type { ArchiveSummary } from '@/lib/services/greenhouses'
import {
  GreenhouseFields, type GreenhouseFormValues, greenhousePayload, greenhouseValuesOf,
} from './greenhouse-fields'
import type { PickerNeighbor } from './position-picker'

type Modal = null | { kind: 'edit' | 'archive' | 'restore'; g: ManagedGreenhouseDTO }

const fmtPos = (n: number) => fmtNum(n, Number.isInteger(n) ? 0 : 1)

/**
 * Tabla de administración de invernaderos (activos y dados de baja) con sus acciones. Una sola instancia de cada
 * diálogo sirve a todas las filas: escala a cientos de invernaderos sin repetir datos por fila.
 */
export function GreenhousesManager({ items, site, nowMs }: { items: ManagedGreenhouseDTO[]; site: SiteSettingsDTO; nowMs: number }) {
  const [modal, setModal] = useState<Modal>(null)
  const [pending, start] = useTransition()
  const [values, setValues] = useState<GreenhouseFormValues | null>(null)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [error, setError] = useState<string | null>(null)
  const [summary, setSummary] = useState<ArchiveSummary | null>(null)

  const open = (kind: 'edit' | 'archive' | 'restore', g: ManagedGreenhouseDTO) => {
    setErrors({})
    setError(null)
    setSummary(null)
    setValues(kind === 'edit' ? greenhouseValuesOf(g) : null)
    setModal({ kind, g })
  }
  const close = () => {
    if (pending) return
    setModal(null)
  }
  const failWith = (r: { error: string; fieldErrors?: Record<string, string> }) => {
    setErrors(r.fieldErrors ?? {})
    if (!r.fieldErrors || Object.keys(r.fieldErrors).length === 0) setError(r.error)
  }

  const save = (e: React.FormEvent) => {
    e.preventDefault()
    if (modal?.kind !== 'edit' || !values) return
    const id = modal.g.id
    start(async () => {
      setErrors({})
      setError(null)
      const r = await updateGreenhouseAction(id, greenhousePayload(values, 'edit'))
      if (r.ok) setModal(null)
      else failWith(r)
    })
  }

  const archive = () => {
    if (modal?.kind !== 'archive') return
    const id = modal.g.id
    start(async () => {
      setError(null)
      const r = await archiveGreenhouseAction(id)
      if (r.ok) setSummary(r.data)
      else failWith(r)
    })
  }

  const restore = () => {
    if (modal?.kind !== 'restore') return
    const id = modal.g.id
    start(async () => {
      setError(null)
      const r = await restoreGreenhouseAction(id)
      if (r.ok) setModal(null)
      else failWith(r)
    })
  }

  if (items.length === 0) {
    return (
      <EmptyState icon={Sprout} title="Todavía no hay invernaderos">
        Crea el primero con «Nuevo invernadero»: se genera junto con su nodo y sus umbrales de riego.
      </EmptyState>
    )
  }

  const neighborsOf = (id: number): PickerNeighbor[] =>
    items.filter((g) => !g.archived && g.id !== id).map((g) => ({ code: g.code, x: g.x, y: g.y }))

  return (
    <>
      <div className="overflow-x-auto">
        <table className="tbl min-w-[960px]">
          <caption className="sr-only">Invernaderos del predio, activos y dados de baja, con su posición, nodo y acciones</caption>
          <thead>
            <tr>
              <th scope="col">Invernadero</th>
              <th scope="col">Posición</th>
              <th scope="col">Superficie · caudal</th>
              <th scope="col">Nodo</th>
              <th scope="col">Estado</th>
              <th scope="col"><span className="sr-only">Acciones</span></th>
            </tr>
          </thead>
          <tbody>
            {items.map((g) => {
              const ageS = g.node?.lastSeen ? Math.max(0, Math.round((nowMs - new Date(g.node.lastSeen).getTime()) / 1000)) : null
              return (
                <tr key={g.id} data-greenhouse-code={g.code} className={g.archived ? 'opacity-70' : undefined}>
                  <td className="max-w-[260px]">
                    {g.archived ? (
                      <div className="font-semibold text-ink">{g.code}</div>
                    ) : (
                      <Link href={`/greenhouses/${g.code}`} prefetch={false} className="font-semibold text-ink underline decoration-line-strong underline-offset-2 hover:decoration-accent">
                        {g.code}
                      </Link>
                    )}
                    <div className="truncate text-[12px] text-ink-3" title={g.name}>{g.name}{g.crop ? ` · ${g.crop}` : ''}</div>
                  </td>
                  <td className="whitespace-nowrap">
                    <div className="text-ink">{fmtPos(g.x)} · {fmtPos(g.y)} m</div>
                    <div className="text-[12px] text-ink-3">{distanceToSubstation(g, site.substation)} m de la subestación</div>
                  </td>
                  <td className="whitespace-nowrap">
                    <div className="text-ink">{g.areaM2 === null ? '—' : `${fmtNum(g.areaM2, 0)} m²`}</div>
                    <div className="text-[12px] text-ink-3">{fmtNum(g.flowLph, 0)} L/h</div>
                  </td>
                  <td className="whitespace-nowrap">
                    {g.node ? (
                      <>
                        <div className="font-mono text-[12.5px] text-ink">{g.node.tokenPrefix}…</div>
                        <div className="text-[12px] text-ink-3">{ageS === null ? 'sin tramas aún' : `última trama ${fmtAgo(ageS)}`}</div>
                      </>
                    ) : (
                      <span className="text-ink-3">Sin nodo</span>
                    )}
                  </td>
                  <td className="whitespace-nowrap">
                    {g.archived ? <Chip tone="off" icon={Archive}>Dado de baja</Chip> : <Chip tone="good" icon={CheckCircle2}>Activo</Chip>}
                  </td>
                  <td className="text-right">
                    <div className="flex flex-wrap justify-end gap-1.5">
                      <button type="button" className="btn btn-sm" onClick={() => open('edit', g)} aria-label={`Editar ${g.code}`}>
                        <Pencil size={14} aria-hidden /> Editar
                      </button>
                      {g.archived ? (
                        <button type="button" className="btn btn-sm" onClick={() => open('restore', g)} aria-label={`Reactivar ${g.code}`}>
                          <ArchiveRestore size={14} aria-hidden /> Reactivar
                        </button>
                      ) : (
                        <button type="button" className="btn btn-sm" onClick={() => open('archive', g)} aria-label={`Dar de baja ${g.code}`}>
                          <Archive size={14} aria-hidden /> Dar de baja
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      {/* Editar */}
      <Dialog open={modal?.kind === 'edit'} onClose={close} locked={pending} width={600} title={modal ? `Editar ${modal.g.code}` : 'Editar'} description="El código no cambia; el resto se puede ajustar cuando quieras.">
        {modal?.kind === 'edit' && values && (
          <form onSubmit={save} className="flex flex-col gap-4" noValidate>
            <GreenhouseFields
              mode="edit"
              values={values}
              onChange={(patch) => setValues((v) => (v ? { ...v, ...patch } : v))}
              errors={errors}
              site={site}
              neighbors={neighborsOf(modal.g.id)}
            />
            {error && <p role="alert" className="rounded-lg bg-crit-wash px-3 py-2 text-[13px] text-ink">{error}</p>}
            <div className="flex justify-end gap-2">
              <button type="button" className="btn" onClick={close} disabled={pending}>Cancelar</button>
              <button type="submit" className="btn btn-primary" disabled={pending}>
                {pending && <Loader2 size={15} className="animate-spin" aria-hidden />} Guardar cambios
              </button>
            </div>
          </form>
        )}
      </Dialog>

      {/* Dar de baja */}
      <Dialog open={modal?.kind === 'archive'} onClose={close} locked={pending} width={520} title={modal ? `Dar de baja ${modal.g.code}` : 'Dar de baja'}>
        {modal?.kind === 'archive' &&
          (summary ? (
            <div className="flex flex-col gap-4">
              <p className="text-[13.5px] leading-relaxed text-ink-2">
                {summary.changed ? (
                  <>
                    <strong className="text-ink">{modal.g.code}</strong> quedó dado de baja. Se resolvieron {summary.alertsResolved} {summary.alertsResolved === 1 ? 'alerta' : 'alertas'},
                    se cancelaron {summary.commandsCancelled} {summary.commandsCancelled === 1 ? 'orden' : 'órdenes'} pendientes y se desactivaron {summary.schedulesDisabled} {summary.schedulesDisabled === 1 ? 'calendario' : 'calendarios'}.
                  </>
                ) : (
                  'Ya estaba dado de baja.'
                )}
              </p>
              <div className="flex items-start gap-2 rounded-lg bg-warn-wash px-3 py-2 text-[12.5px] leading-snug text-ink">
                <TriangleAlert size={16} className="mt-px shrink-0 text-warn-ink" aria-hidden />
                <p>El nodo físico sigue regando de forma autónoma con su última configuración. Apágalo o desconéctalo si ya no debe operar.</p>
              </div>
              <div className="flex justify-end">
                <button type="button" className="btn btn-primary" onClick={close}>Listo</button>
              </div>
            </div>
          ) : (
            <div className="flex flex-col gap-4">
              <p className="text-[13.5px] leading-relaxed text-ink-2">
                <strong className="text-ink">{modal.g.code}</strong> deja de aparecer en el panel y su nodo se deshabilita: el servidor rechaza sus tramas.
                Se resuelven sus alertas, se cancelan sus órdenes pendientes y se desactivan sus calendarios.
              </p>
              <ul className="list-disc space-y-1 pl-5 text-[13px] text-ink-2">
                <li><strong className="text-ink">No se borra nada:</strong> el historial (lecturas, riegos, alertas y bitácora) se conserva.</li>
                <li>Se puede reactivar cuando quieras (los calendarios quedan desactivados).</li>
                <li>El nodo físico sigue regando solo con su última configuración hasta que lo apagues.</li>
              </ul>
              {error && <p role="alert" className="rounded-lg bg-crit-wash px-3 py-2 text-[13px] text-ink">{error}</p>}
              <div className="flex justify-end gap-2">
                <button type="button" className="btn" onClick={close} disabled={pending}>Cancelar</button>
                <button type="button" className="btn btn-danger" onClick={archive} disabled={pending}>
                  {pending && <Loader2 size={15} className="animate-spin" aria-hidden />} Dar de baja
                </button>
              </div>
            </div>
          ))}
      </Dialog>

      {/* Reactivar */}
      <Dialog open={modal?.kind === 'restore'} onClose={close} locked={pending} width={480} title={modal ? `Reactivar ${modal.g.code}` : 'Reactivar'}>
        {modal?.kind === 'restore' && (
          <div className="flex flex-col gap-4">
            <p className="text-[13.5px] leading-relaxed text-ink-2">
              <strong className="text-ink">{modal.g.code}</strong> vuelve al panel y su nodo se habilita otra vez con el mismo token.
              Los calendarios de riego siguen desactivados: actívalos desde el detalle del invernadero.
            </p>
            {error && <p role="alert" className="rounded-lg bg-crit-wash px-3 py-2 text-[13px] text-ink">{error}</p>}
            <div className="flex justify-end gap-2">
              <button type="button" className="btn" onClick={close} disabled={pending}>Cancelar</button>
              <button type="button" className="btn btn-primary" onClick={restore} disabled={pending}>
                {pending && <Loader2 size={15} className="animate-spin" aria-hidden />} Reactivar
              </button>
            </div>
          </div>
        )}
      </Dialog>
    </>
  )
}
