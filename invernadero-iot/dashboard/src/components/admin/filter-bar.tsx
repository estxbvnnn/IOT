'use client'

import { FilterX, Search } from 'lucide-react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { useId, useState, useTransition } from 'react'

export interface FilterOption { value: string; label: string }

export interface FilterField {
  /** Nombre del parámetro en la URL. */
  name: string
  label: string
  type?: 'select' | 'text'
  options?: readonly FilterOption[]
  value: string
  placeholder?: string
}

/**
 * Fila ÚNICA de filtros sobre el contenido que acota (regla de la guía de visualización: los filtros
 * van juntos y arriba, nunca dentro de una tarjeta). El estado vive en la URL: se puede compartir y
 * recargar. Cambiar un filtro reinicia la paginación (`antes`).
 */
export function FilterBar({ fields }: { fields: readonly FilterField[] }) {
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()
  const [pending, start] = useTransition()
  const uid = useId()
  const [draft, setDraft] = useState<Record<string, string>>(() => Object.fromEntries(fields.filter((f) => f.type === 'text').map((f) => [f.name, f.value])))

  const push = (name: string, value: string) => {
    const q = new URLSearchParams(params.toString())
    if (value) q.set(name, value)
    else q.delete(name)
    q.delete('antes')
    const qs = q.toString()
    start(() => router.replace(qs ? `${pathname}?${qs}` : pathname))
  }

  const active = fields.some((f) => f.value !== '')
  const clear = () => {
    setDraft({})
    start(() => router.replace(pathname))
  }

  return (
    <form
      role="search"
      aria-label="Filtros"
      className="mb-4 flex flex-wrap items-end gap-x-3 gap-y-3"
      onSubmit={(e) => {
        e.preventDefault()
        for (const f of fields) if (f.type === 'text') push(f.name, (draft[f.name] ?? '').trim())
      }}
      data-pending={pending || undefined}
    >
      {fields.map((f) => (
        <div key={f.name} className={f.type === 'text' ? 'min-w-[200px] flex-1 sm:max-w-[320px]' : 'min-w-[150px]'}>
          <label htmlFor={`${uid}-${f.name}`} className="label">{f.label}</label>
          {f.type === 'text' ? (
            <div className="relative">
              <Search size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-3" aria-hidden />
              <input
                id={`${uid}-${f.name}`}
                className="input pl-9"
                value={draft[f.name] ?? ''}
                placeholder={f.placeholder}
                onChange={(e) => setDraft((d) => ({ ...d, [f.name]: e.target.value }))}
                maxLength={80}
                autoComplete="off"
              />
            </div>
          ) : (
            <select id={`${uid}-${f.name}`} className="input" value={f.value} onChange={(e) => push(f.name, e.target.value)}>
              {f.options?.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
          )}
        </div>
      ))}
      {fields.some((f) => f.type === 'text') && (
        <button type="submit" className="btn">Buscar</button>
      )}
      {active && (
        <button type="button" className="btn btn-ghost" onClick={clear}>
          <FilterX size={15} aria-hidden /> Quitar filtros
        </button>
      )}
    </form>
  )
}
