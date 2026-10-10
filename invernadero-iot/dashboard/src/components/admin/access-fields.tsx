'use client'

import { useId } from 'react'
import { ROLES, ROLE_LABELS, type Role } from '@/lib/rbac'
import type { GreenhouseOption } from './greenhouse-options-type'

interface Props {
  role: Role
  onRole: (r: Role) => void
  selected: readonly number[]
  onToggle: (id: number) => void
  /** Marca o desmarca todos los sectores de una vez (útil cuando hay muchos invernaderos). */
  onSetAll?: (ids: number[]) => void
  greenhouses: readonly GreenhouseOption[]
  errors?: Record<string, string>
}

const ROLE_HINT: Record<Role, string> = {
  superadmin: 'Cuenta de pruebas: todo lo del administrador, sin confirmación en dos pasos del riego ni topes de duración. Solo la asigna otro súper administrador.',
  owner: 'Solo lectura del panel ejecutivo. No configura ni acciona nada.',
  admin: 'Control total: usuarios, equipos, llaves y todo lo demás.',
  agronomist: 'Analiza el historial, ajusta umbrales y programa calendarios de riego.',
  operator: 'Ve alertas y acciona el riego manual, solo en los sectores asignados.',
  technician: 'Solo lectura de la bitácora, la calidad de enlace y el estado de los equipos.',
}

/** Selector de rol y, solo para operadores, de los sectores que pueden ver y regar. */
export function AccessFields({ role, onRole, selected, onToggle, onSetAll, greenhouses, errors }: Props) {
  const id = useId()
  const isOperator = role === 'operator'
  // Un invernadero dado de baja no se puede asignar: no se ofrece.
  const options = greenhouses.filter((g) => !g.archived)
  const selectedCount = options.filter((g) => selected.includes(g.id)).length
  return (
    <div className="flex flex-col gap-4">
      <div>
        <label htmlFor={`${id}-rol`} className="label">Rol</label>
        <select id={`${id}-rol`} className="input" value={role} onChange={(e) => onRole(e.target.value as Role)} aria-describedby={`${id}-rol-h`} aria-invalid={!!errors?.role}>
          {ROLES.map((r) => (
            <option key={r} value={r}>{ROLE_LABELS[r]}</option>
          ))}
        </select>
        <p id={`${id}-rol-h`} className="hint">{ROLE_HINT[role]}</p>
        {errors?.role && <p className="field-error">{errors.role}</p>}
      </div>

      <fieldset className="min-w-0" disabled={!isOperator}>
        <legend className="label">Sectores asignados</legend>
        {isOperator ? (
          <>
            {/* La cantidad de invernaderos no es fija: la lista se adapta al ancho y hace scroll si son muchos. */}
            <div className="grid max-h-[248px] grid-cols-[repeat(auto-fill,minmax(84px,1fr))] gap-1.5 overflow-y-auto pr-1">
              {options.map((g) => {
                const checked = selected.includes(g.id)
                return (
                  <label
                    key={g.id}
                    className="flex min-h-[36px] min-w-0 cursor-pointer items-center justify-center gap-1.5 rounded-lg border border-line-strong px-2 text-[13px] font-semibold has-[:checked]:border-[color:var(--accent)] has-[:checked]:bg-accent-wash has-[:focus-visible]:outline has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-[color:var(--focus)]"
                    title={g.name}
                  >
                    <input type="checkbox" className="sr-only" checked={checked} onChange={() => onToggle(g.id)} />
                    <span aria-hidden className="grid h-3.5 w-3.5 shrink-0 place-items-center rounded-[4px] border border-line-strong text-[10px] leading-none text-white" style={checked ? { background: 'var(--accent-btn)', borderColor: 'transparent' } : undefined}>{checked ? '✓' : ''}</span>
                    <span className="truncate">{g.code}</span>
                  </label>
                )
              })}
            </div>
            <div className="mt-1.5 flex flex-wrap items-center justify-between gap-2">
              <p className="hint !mt-0">
                {options.length === 0
                  ? 'Todavía no hay invernaderos que asignar.'
                  : selectedCount === 0
                    ? 'Sin sectores: el operador no verá ningún invernadero.'
                    : `${selectedCount} de ${options.length} sectores.`}
              </p>
              {onSetAll && options.length > 1 && (
                <div className="flex gap-1">
                  <button type="button" className="btn btn-ghost btn-sm" onClick={() => onSetAll(options.map((g) => g.id))}>Todos</button>
                  <button type="button" className="btn btn-ghost btn-sm" onClick={() => onSetAll([])}>Ninguno</button>
                </div>
              )}
            </div>
          </>
        ) : (
          <p className="text-[13px] text-ink-3">Este rol ve todos los invernaderos: solo los operadores tienen sectores asignados.</p>
        )}
        {errors?.greenhouseIds && <p className="field-error">{errors.greenhouseIds}</p>}
      </fieldset>
    </div>
  )
}
