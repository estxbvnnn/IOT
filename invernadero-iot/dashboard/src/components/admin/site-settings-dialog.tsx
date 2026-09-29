'use client'

import { Loader2, Settings2 } from 'lucide-react'
import { useId, useState, useTransition } from 'react'
import { updateSiteSettingsAction } from '@/app/actions/greenhouses'
import { Dialog } from '@/components/ui/dialog'
import type { SiteSettingsDTO } from '@/lib/domain/types'
import { toNum } from './greenhouse-fields'

interface Values {
  siteName: string
  width: string
  height: string
  sx: string
  sy: string
  hasTank: boolean
  tx: string
  ty: string
}

const valuesOf = (s: SiteSettingsDTO): Values => ({
  siteName: s.siteName, width: String(s.widthM), height: String(s.heightM),
  sx: String(s.substation.x), sy: String(s.substation.y),
  hasTank: s.tank !== null, tx: s.tank ? String(s.tank.x) : '', ty: s.tank ? String(s.tank.y) : '',
})

/** Número si se puede; si el texto no es un número se envía tal cual para que el servidor responda «Ingresa un número». */
const numOrRaw = (t: string): number | string | undefined => toNum(t) ?? (t.trim() === '' ? undefined : t)

/**
 * Ajustes del predio: nombre, tamaño, posición de la subestación (mástil) y del estanque. Al sumar invernaderos el
 * predio puede necesitar crecer; el servidor no deja achicarlo por debajo de lo que ocupan los invernaderos activos.
 */
export function SiteSettingsButton({ site }: { site: SiteSettingsDTO }) {
  const id = useId()
  const [open, setOpen] = useState(false)
  const [pending, start] = useTransition()
  const [v, setV] = useState<Values>(() => valuesOf(site))
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [formError, setFormError] = useState<string | null>(null)

  const openDialog = () => {
    setV(valuesOf(site))
    setErrors({})
    setFormError(null)
    setOpen(true)
  }
  const close = () => {
    if (pending) return
    setOpen(false)
  }
  const set = (patch: Partial<Values>) => setV((cur) => ({ ...cur, ...patch }))

  const submit = (e: React.FormEvent) => {
    e.preventDefault()
    start(async () => {
      setErrors({})
      setFormError(null)
      const r = await updateSiteSettingsAction({
        siteName: v.siteName,
        widthM: numOrRaw(v.width),
        heightM: numOrRaw(v.height),
        substationX: numOrRaw(v.sx),
        substationY: numOrRaw(v.sy),
        tankX: v.hasTank ? numOrRaw(v.tx) : null,
        tankY: v.hasTank ? numOrRaw(v.ty) : null,
      })
      if (r.ok) setOpen(false)
      else {
        setErrors(r.fieldErrors ?? {})
        if (!r.fieldErrors || Object.keys(r.fieldErrors).length === 0) setFormError(r.error)
      }
    })
  }

  const err = (k: string) => (errors[k] ? <p id={`${id}-${k}-e`} className="field-error">{errors[k]}</p> : null)
  const aria = (k: string) => ({ 'aria-invalid': !!errors[k], 'aria-describedby': errors[k] ? `${id}-${k}-e` : undefined })

  return (
    <>
      <button type="button" className="btn" onClick={openDialog}>
        <Settings2 size={16} aria-hidden /> Ajustes del predio
      </button>
      <Dialog open={open} onClose={close} locked={pending} width={540} title="Ajustes del predio" description="Define el tamaño del mapa y dónde están la subestación y el estanque. Las medidas van en metros.">
        <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
          <div>
            <label htmlFor={`${id}-name`} className="label">Nombre del predio</label>
            <input id={`${id}-name`} className="input" value={v.siteName} onChange={(e) => set({ siteName: e.target.value })} maxLength={80} autoComplete="off" required {...aria('siteName')} />
            {err('siteName')}
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label htmlFor={`${id}-w`} className="label">Ancho (m)</label>
              <input id={`${id}-w`} className="input" inputMode="decimal" value={v.width} onChange={(e) => set({ width: e.target.value })} autoComplete="off" required {...aria('widthM')} />
              {err('widthM')}
            </div>
            <div>
              <label htmlFor={`${id}-h`} className="label">Largo (m)</label>
              <input id={`${id}-h`} className="input" inputMode="decimal" value={v.height} onChange={(e) => set({ height: e.target.value })} autoComplete="off" required {...aria('heightM')} />
              {err('heightM')}
            </div>
          </div>

          <fieldset className="min-w-0">
            <legend className="label">Subestación (mástil con el gateway)</legend>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label htmlFor={`${id}-sx`} className="label">X (m)</label>
                <input id={`${id}-sx`} className="input" inputMode="decimal" value={v.sx} onChange={(e) => set({ sx: e.target.value })} autoComplete="off" required {...aria('substationX')} />
                {err('substationX')}
              </div>
              <div>
                <label htmlFor={`${id}-sy`} className="label">Y (m)</label>
                <input id={`${id}-sy`} className="input" inputMode="decimal" value={v.sy} onChange={(e) => set({ sy: e.target.value })} autoComplete="off" required {...aria('substationY')} />
                {err('substationY')}
              </div>
            </div>
          </fieldset>

          <fieldset className="min-w-0">
            <legend className="label">Estanque de agua</legend>
            <label className="mb-3 flex items-center gap-2 text-[13px] text-ink-2">
              <input type="checkbox" checked={v.hasTank} onChange={(e) => set({ hasTank: e.target.checked })} />
              El predio tiene un estanque (se dibuja en el mapa)
            </label>
            {v.hasTank && (
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label htmlFor={`${id}-tx`} className="label">X (m)</label>
                  <input id={`${id}-tx`} className="input" inputMode="decimal" value={v.tx} onChange={(e) => set({ tx: e.target.value })} autoComplete="off" {...aria('tankX')} />
                  {err('tankX')}
                </div>
                <div>
                  <label htmlFor={`${id}-ty`} className="label">Y (m)</label>
                  <input id={`${id}-ty`} className="input" inputMode="decimal" value={v.ty} onChange={(e) => set({ ty: e.target.value })} autoComplete="off" {...aria('tankY')} />
                  {err('tankY')}
                </div>
              </div>
            )}
          </fieldset>

          {formError && <p role="alert" className="rounded-lg bg-crit-wash px-3 py-2 text-[13px] text-ink">{formError}</p>}
          <div className="flex justify-end gap-2">
            <button type="button" className="btn" onClick={close} disabled={pending}>Cancelar</button>
            <button type="submit" className="btn btn-primary" disabled={pending}>
              {pending && <Loader2 size={15} className="animate-spin" aria-hidden />} Guardar ajustes
            </button>
          </div>
        </form>
      </Dialog>
    </>
  )
}
