'use client'

import { Loader2 } from 'lucide-react'
import { useEffect, useId, useState } from 'react'
import { setAutoIrrigationAction } from '@/app/actions/operations'
import { Card } from '@/components/ui/card'
import { cn } from '@/lib/cn'

/**
 * Activa o desactiva el riego AUTOMÁTICO (por humedad) del invernadero. Con el riego automático desactivado el nodo
 * no inicia riegos por su cuenta; el riego manual, los calendarios y «detener» siguen funcionando. El cambio viaja al
 * nodo en su próximo reporte (campo «auto» de la cfg) y queda en la bitácora como una actualización de umbrales.
 */

export interface AutoIrrigationSwitchProps {
  greenhouseId: number
  enabled: boolean
  /** El usuario tiene permiso thresholds:edit. */
  canEdit: boolean
  /** Segundos entre reportes del nodo (para decir cuánto tarda en enterarse). */
  intervalS: number
}

export function AutoIrrigationSwitch({ greenhouseId, enabled, canEdit, intervalS }: AutoIrrigationSwitchProps) {
  const uid = useId()
  const [on, setOn] = useState(enabled)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  // Si otra persona lo cambia, la página nueva trae el valor real.
  useEffect(() => { setOn(enabled) }, [enabled])

  const toggle = async () => {
    if (busy || !canEdit) return
    const next = !on
    setBusy(true)
    setError(null)
    setSaved(false)
    const res = await setAutoIrrigationAction(greenhouseId, next)
    setBusy(false)
    if (res.ok) {
      setOn(res.data)
      setSaved(true)
    } else {
      setError(res.error)
    }
  }

  return (
    <Card
      id="riego-automatico"
      title="Riego automático"
      description={on ? 'Activado: el nodo riega solo según los umbrales de humedad' : 'Desactivado: el nodo no inicia riegos por su cuenta'}
    >
      <div className="flex flex-col gap-2.5">
        <div className="flex items-center justify-between gap-3">
          <span id={`${uid}-lbl`} className="text-[13.5px] font-medium text-ink">
            {on ? 'Riego automático activado' : 'Riego automático desactivado'}
          </span>
          <button
            type="button" role="switch" aria-checked={on} aria-labelledby={`${uid}-lbl`}
            disabled={!canEdit || busy} onClick={() => void toggle()}
            className={cn(
              'relative inline-flex h-7 w-12 shrink-0 items-center rounded-full border border-line-strong transition-colors',
              'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--focus)]',
              'disabled:cursor-not-allowed disabled:opacity-60',
              on ? 'border-transparent bg-accent-btn' : 'bg-surface-2',
            )}
          >
            <span
              aria-hidden
              className={cn('absolute left-0.5 grid h-5 w-5 place-items-center rounded-full bg-white shadow transition-transform', on ? 'translate-x-[22px]' : 'translate-x-0')}
            >
              {busy && <Loader2 size={12} className="text-ink-3 motion-safe:animate-spin" aria-hidden />}
            </span>
          </button>
        </div>
        <p className="text-[12.5px] leading-snug text-ink-3">
          {canEdit
            ? `Afecta solo al riego automático por humedad. El riego manual y los calendarios siguen funcionando. El nodo lo aplica en su próximo reporte (hasta ${intervalS} s).`
            : 'Solo lectura: lo cambian el ingeniero agrónomo o el administrador.'}
        </p>
        {saved && <p role="status" className="text-[12.5px] text-ink-2">Guardado. El nodo lo recibe en su próximo reporte.</p>}
        {error && <p role="alert" className="rounded-lg bg-crit-wash px-3 py-2 text-[13px] text-ink">{error}</p>}
      </div>
    </Card>
  )
}
