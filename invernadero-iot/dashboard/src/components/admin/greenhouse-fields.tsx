'use client'

import { useId } from 'react'
import { GREENHOUSE_CODE_HELP } from '@/lib/domain/greenhouse'
import type { ManagedGreenhouseDTO, SiteSettingsDTO } from '@/lib/domain/types'
import { PositionPicker, type PickerNeighbor } from './position-picker'

/** Valores del formulario tal como se escriben (texto): se convierten al enviar. */
export interface GreenhouseFormValues {
  code: string
  name: string
  crop: string
  area: string
  flow: string
  x: string
  y: string
  copyFrom: string
}

export const emptyGreenhouseValues = (pos: { x: number; y: number } | null): GreenhouseFormValues => ({
  code: '', name: '', crop: '', area: '200', flow: '100',
  x: pos ? String(pos.x) : '', y: pos ? String(pos.y) : '', copyFrom: '',
})

export const greenhouseValuesOf = (g: ManagedGreenhouseDTO): GreenhouseFormValues => ({
  code: g.code, name: g.name, crop: g.crop ?? '', area: g.areaM2 === null ? '' : String(g.areaM2),
  flow: String(g.flowLph), x: String(g.x), y: String(g.y), copyFrom: '',
})

/** «12,5» o «12.5» → 12.5; vacío o inválido → undefined. */
export function toNum(text: string): number | undefined {
  const s = text.trim().replace(',', '.')
  if (s === '') return undefined
  const n = Number(s)
  return Number.isFinite(n) ? n : undefined
}

/** Número si se puede; si el texto no es un número se envía tal cual para que el servidor responda «Ingresa un número». */
const numOrRaw = (t: string): number | string | undefined => toNum(t) ?? (t.trim() === '' ? undefined : t)

export function greenhousePayload(v: GreenhouseFormValues, mode: 'create' | 'edit'): Record<string, unknown> {
  const base = {
    name: v.name,
    crop: v.crop.trim() === '' ? null : v.crop,
    areaM2: v.area.trim() === '' ? null : numOrRaw(v.area),
    flowLph: numOrRaw(v.flow),
    x: numOrRaw(v.x),
    y: numOrRaw(v.y),
  }
  if (mode === 'edit') return base
  return { ...base, code: v.code.trim() === '' ? undefined : v.code, copyThresholdsFrom: v.copyFrom === '' ? null : Number(v.copyFrom) }
}

interface Props {
  mode: 'create' | 'edit'
  values: GreenhouseFormValues
  onChange: (patch: Partial<GreenhouseFormValues>) => void
  errors: Record<string, string>
  site: SiteSettingsDTO
  /** Invernaderos activos distintos del que se está creando o editando. */
  neighbors: readonly PickerNeighbor[]
  /** Solo al crear: invernaderos de los que se pueden copiar los umbrales. */
  copySources?: readonly { id: number; code: string; name: string }[]
}

/** Campos comunes de alta y edición. El código se elige al crear y no cambia después (va en la URL y en los CSV). */
export function GreenhouseFields({ mode, values, onChange, errors, site, neighbors, copySources = [] }: Props) {
  const id = useId()
  const px = toNum(values.x)
  const py = toNum(values.y)
  const err = (k: string) => (errors[k] ? <p id={`${id}-${k}-e`} className="field-error">{errors[k]}</p> : null)
  const aria = (k: string) => ({ 'aria-invalid': !!errors[k], 'aria-describedby': errors[k] ? `${id}-${k}-e` : undefined })

  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_180px]">
        <div>
          <label htmlFor={`${id}-name`} className="label">Nombre</label>
          <input id={`${id}-name`} className="input" value={values.name} onChange={(e) => onChange({ name: e.target.value })} maxLength={80} autoComplete="off" required placeholder="Invernadero de tomates" {...aria('name')} />
          {err('name')}
        </div>
        <div>
          <label htmlFor={`${id}-code`} className="label">Código {mode === 'create' && <span className="font-normal text-ink-3">(opcional)</span>}</label>
          {mode === 'create' ? (
            <>
              <input id={`${id}-code`} className="input font-mono" value={values.code} onChange={(e) => onChange({ code: e.target.value })} maxLength={16} autoComplete="off" spellCheck={false} placeholder="automático" {...aria('code')} />
              {errors.code ? err('code') : <p className="hint">{GREENHOUSE_CODE_HELP}</p>}
            </>
          ) : (
            <>
              <input id={`${id}-code`} className="input font-mono" value={values.code} readOnly aria-readonly="true" />
              <p className="hint">No se puede cambiar: va en la URL y en los CSV.</p>
            </>
          )}
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <div>
          <label htmlFor={`${id}-crop`} className="label">Cultivo <span className="font-normal text-ink-3">(opcional)</span></label>
          <input id={`${id}-crop`} className="input" value={values.crop} onChange={(e) => onChange({ crop: e.target.value })} maxLength={60} autoComplete="off" placeholder="Tomate" {...aria('crop')} />
          {err('crop')}
        </div>
        <div>
          <label htmlFor={`${id}-area`} className="label">Superficie (m²)</label>
          <input id={`${id}-area`} className="input" inputMode="decimal" value={values.area} onChange={(e) => onChange({ area: e.target.value })} autoComplete="off" {...aria('areaM2')} />
          {err('areaM2')}
        </div>
        <div>
          <label htmlFor={`${id}-flow`} className="label">Caudal de la bomba (L/h)</label>
          <input id={`${id}-flow`} className="input" inputMode="decimal" value={values.flow} onChange={(e) => onChange({ flow: e.target.value })} autoComplete="off" required {...aria('flowLph')} />
          {err('flowLph')}
          <p className="hint">Sirve para estimar el agua usada.</p>
        </div>
      </div>

      <fieldset className="min-w-0">
        <legend className="label">Posición en el predio</legend>
        <PositionPicker
          site={{ widthM: site.widthM, heightM: site.heightM, substation: site.substation, tank: site.tank }}
          neighbors={neighbors}
          value={px !== undefined && py !== undefined ? { x: px, y: py } : null}
          onChange={(p) => onChange({ x: String(p.x), y: String(p.y) })}
        />
        <div className="mt-3 grid grid-cols-2 gap-4">
          <div>
            <label htmlFor={`${id}-x`} className="label">X (m, desde la izquierda)</label>
            <input id={`${id}-x`} className="input" inputMode="decimal" value={values.x} onChange={(e) => onChange({ x: e.target.value })} autoComplete="off" required {...aria('x')} />
            {err('x')}
          </div>
          <div>
            <label htmlFor={`${id}-y`} className="label">Y (m, desde arriba)</label>
            <input id={`${id}-y`} className="input" inputMode="decimal" value={values.y} onChange={(e) => onChange({ y: e.target.value })} autoComplete="off" required {...aria('y')} />
            {err('y')}
          </div>
        </div>
      </fieldset>

      {mode === 'create' && copySources.length > 0 && (
        <div>
          <label htmlFor={`${id}-copy`} className="label">Umbrales de riego y alertas</label>
          <select id={`${id}-copy`} className="input" value={values.copyFrom} onChange={(e) => onChange({ copyFrom: e.target.value })} {...aria('copyThresholdsFrom')}>
            <option value="">Valores por defecto (regar ≥ 700 · apagar ≤ 500 · saturado &lt; 300)</option>
            {copySources.map((g) => (
              <option key={g.id} value={g.id}>Copiar los de {g.code} · {g.name}</option>
            ))}
          </select>
          {err('copyThresholdsFrom')}
        </div>
      )}
    </div>
  )
}
