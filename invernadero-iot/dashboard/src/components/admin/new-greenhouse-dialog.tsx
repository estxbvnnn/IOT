'use client'

import { Loader2, Plus } from 'lucide-react'
import { useState, useTransition } from 'react'
import { createGreenhouseAction } from '@/app/actions/greenhouses'
import { Dialog } from '@/components/ui/dialog'
import type { SiteSettingsDTO } from '@/lib/domain/types'
import type { CreatedGreenhouse } from '@/lib/services/greenhouses'
import {
  GreenhouseFields, type GreenhouseFormValues, emptyGreenhouseValues, greenhousePayload,
} from './greenhouse-fields'
import type { PickerNeighbor } from './position-picker'
import { SecretReveal } from './secret-reveal'

interface Props {
  site: SiteSettingsDTO
  /** Invernaderos activos (para no superponer el nuevo y para copiar umbrales). */
  active: readonly { id: number; code: string; name: string; x: number; y: number }[]
  /** Primer lugar libre del predio, calculado en el servidor (null si está lleno). */
  suggested: { x: number; y: number } | null
}

/**
 * Alta de un invernadero. Crea en una sola operación el invernadero, sus umbrales y su nodo; el token del nodo se
 * muestra UNA vez (la base solo guarda su huella SHA-256).
 */
export function NewGreenhouseButton({ site, active, suggested }: Props) {
  const [open, setOpen] = useState(false)
  const [pending, start] = useTransition()
  const [values, setValues] = useState<GreenhouseFormValues>(() => emptyGreenhouseValues(suggested))
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [formError, setFormError] = useState<string | null>(null)
  const [created, setCreated] = useState<CreatedGreenhouse | null>(null)

  const openDialog = () => {
    setValues(emptyGreenhouseValues(suggested))
    setErrors({})
    setFormError(null)
    setCreated(null)
    setOpen(true)
  }
  const close = () => {
    if (pending) return
    setOpen(false)
    setCreated(null) // el token no permanece en memoria una vez cerrado el diálogo
  }

  const submit = (e: React.FormEvent) => {
    e.preventDefault()
    start(async () => {
      setErrors({})
      setFormError(null)
      const r = await createGreenhouseAction(greenhousePayload(values, 'create'))
      if (r.ok) setCreated(r.data)
      else {
        setErrors(r.fieldErrors ?? {})
        if (!r.fieldErrors || Object.keys(r.fieldErrors).length === 0) setFormError(r.error)
      }
    })
  }

  const neighbors: PickerNeighbor[] = active.map((g) => ({ code: g.code, x: g.x, y: g.y }))

  return (
    <>
      <button type="button" className="btn btn-primary" onClick={openDialog}>
        <Plus size={16} aria-hidden /> Nuevo invernadero
      </button>
      <Dialog
        open={open}
        onClose={close}
        locked={pending}
        width={600}
        title={created ? `Invernadero ${created.greenhouse.code} creado` : 'Nuevo invernadero'}
        description={created ? undefined : 'Se crea con su nodo ESP32 y sus umbrales de riego. La cantidad de invernaderos no tiene tope.'}
      >
        {created ? (
          <div className="flex flex-col gap-4">
            <p className="text-[13.5px] text-ink-2">
              <strong className="text-ink">{created.greenhouse.code}</strong> · {created.greenhouse.name} ya aparece en el panel como «Sin datos» hasta que su nodo envíe la primera trama.
            </p>
            <SecretReveal
              label={`Token del nodo ${created.greenhouse.code}`}
              value={created.token}
              warning="Se muestra una sola vez: el servidor solo guarda su huella (SHA-256). Pégalo en DEVICE_TOKEN del firmware (bloque «CONFIGURACION DEL USUARIO») antes de cargarlo en la placa. Si lo pierdes, se genera uno nuevo con «Rotar token» en Equipos."
            />
            <ol className="list-decimal space-y-1 pl-5 text-[13px] text-ink-2">
              <li>Carga el firmware en la placa con este token, el WiFi y la dirección del servidor.</li>
              <li>Cuando llegue la primera trama, el invernadero pasa a «Normal».</li>
              <li>Para que un operador lo vea, asígnaselo en <strong className="text-ink">Usuarios</strong> (por defecto nadie con alcance limitado lo ve).</li>
            </ol>
            <div className="flex justify-end">
              <button type="button" className="btn btn-primary" onClick={close}>Listo, ya copié el token</button>
            </div>
          </div>
        ) : (
          <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
            <GreenhouseFields
              mode="create"
              values={values}
              onChange={(patch) => setValues((v) => ({ ...v, ...patch }))}
              errors={errors}
              site={site}
              neighbors={neighbors}
              copySources={active}
            />
            {formError && <p role="alert" className="rounded-lg bg-crit-wash px-3 py-2 text-[13px] text-ink">{formError}</p>}
            <div className="flex justify-end gap-2">
              <button type="button" className="btn" onClick={close} disabled={pending}>Cancelar</button>
              <button type="submit" className="btn btn-primary" disabled={pending}>
                {pending && <Loader2 size={15} className="animate-spin" aria-hidden />} Crear invernadero
              </button>
            </div>
          </form>
        )}
      </Dialog>
    </>
  )
}
