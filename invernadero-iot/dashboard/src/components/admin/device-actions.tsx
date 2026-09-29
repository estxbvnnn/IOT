'use client'

import { KeyRound, Loader2, Power, PowerOff } from 'lucide-react'
import { useState, useTransition } from 'react'
import { rotateNodeTokenAction, setNodeEnabledAction } from '@/app/actions/admin'
import { Dialog } from '@/components/ui/dialog'
import { SecretReveal } from './secret-reveal'

interface Props {
  nodeId: number
  label: string
  enabled: boolean
  /** El invernadero del nodo está dado de baja: el nodo solo se habilita reactivando el invernadero. */
  archived?: boolean
}

type Modal = null | 'rotate' | 'disable'

/**
 * Acciones del administrador sobre un nodo. Rotar el token invalida el anterior al instante: el nodo deja de
 * reportar hasta que se pegue el token nuevo en `DEVICE_TOKEN` del firmware, se vuelva a cargar y se reinicie.
 */
export function DeviceActions({ nodeId, label, enabled, archived = false }: Props) {
  const [modal, setModal] = useState<Modal>(null)
  const [pending, start] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const [token, setToken] = useState<{ token: string; prefix: string } | null>(null)

  const close = () => {
    if (pending) return
    setModal(null)
    setToken(null) // el token nuevo no permanece en memoria una vez cerrado el diálogo
    setError(null)
  }

  const rotate = () =>
    start(async () => {
      setError(null)
      const r = await rotateNodeTokenAction(nodeId)
      if (r.ok) setToken(r.data)
      else setError(r.error)
    })

  const toggle = (next: boolean) =>
    start(async () => {
      setError(null)
      const r = await setNodeEnabledAction(nodeId, next)
      if (r.ok) setModal(null)
      else setError(r.error)
    })

  return (
    <div className="flex flex-wrap justify-end gap-1.5">
      <button type="button" className="btn btn-sm" onClick={() => setModal('rotate')} aria-label={`Rotar token de ${label}`}>
        <KeyRound size={14} aria-hidden /> Rotar token
      </button>
      {archived ? (
        <span className="self-center text-[12px] text-ink-3">Reactiva el invernadero para habilitarlo</span>
      ) : enabled ? (
        <button type="button" className="btn btn-sm" onClick={() => setModal('disable')} aria-label={`Deshabilitar ${label}`}>
          <PowerOff size={14} aria-hidden /> Deshabilitar
        </button>
      ) : (
        <button type="button" className="btn btn-sm" onClick={() => toggle(true)} disabled={pending} aria-label={`Habilitar ${label}`}>
          {pending ? <Loader2 size={14} className="animate-spin" aria-hidden /> : <Power size={14} aria-hidden />} Habilitar
        </button>
      )}
      {!enabled && error && <span role="alert" className="basis-full text-right text-[12px] text-crit-ink">{error}</span>}

      <Dialog
        open={modal === 'rotate'}
        onClose={close}
        locked={pending}
        title={token ? 'Token nuevo generado' : `Rotar el token de ${label}`}
        description={token ? undefined : 'El token actual dejará de funcionar de inmediato.'}
      >
        {token ? (
          <div className="flex flex-col gap-4">
            <SecretReveal
              label={`Token de ${label}`}
              value={token.token}
              warning="Se muestra una sola vez y el servidor solo guarda su huella (SHA-256). Pégalo en DEVICE_TOKEN del firmware, vuelve a cargarlo en la placa y reinicia el nodo. El token anterior ya no sirve."
            />
            <div className="flex justify-end">
              <button type="button" className="btn btn-primary" onClick={close}>Listo, ya lo copié</button>
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-4">
            <p className="text-[13.5px] leading-relaxed text-ink-2">
              Úsalo si sospechas que el token se filtró o al reemplazar la placa. Mientras no se cargue el token nuevo en el nodo,
              este no podrá enviar telemetría (el riego automático del nodo sigue funcionando con su última configuración).
            </p>
            {error && <p role="alert" className="rounded-lg bg-crit-wash px-3 py-2 text-[13px] text-ink">{error}</p>}
            <div className="flex justify-end gap-2">
              <button type="button" className="btn" onClick={close} disabled={pending}>Cancelar</button>
              <button type="button" className="btn btn-danger" onClick={rotate} disabled={pending}>
                {pending && <Loader2 size={15} className="animate-spin" aria-hidden />} Rotar token
              </button>
            </div>
          </div>
        )}
      </Dialog>

      <Dialog open={modal === 'disable'} onClose={close} locked={pending} title={`Deshabilitar ${label}`}>
        <div className="flex flex-col gap-4">
          <p className="text-[13.5px] leading-relaxed text-ink-2">
            El servidor rechazará las tramas de este nodo hasta que lo vuelvas a habilitar. El nodo seguirá regando de forma
            autónoma con su última configuración, pero el panel dejará de recibir sus datos.
          </p>
          {error && <p role="alert" className="rounded-lg bg-crit-wash px-3 py-2 text-[13px] text-ink">{error}</p>}
          <div className="flex justify-end gap-2">
            <button type="button" className="btn" onClick={close} disabled={pending}>Cancelar</button>
            <button type="button" className="btn btn-danger" onClick={() => toggle(false)} disabled={pending}>
              {pending && <Loader2 size={15} className="animate-spin" aria-hidden />} Deshabilitar
            </button>
          </div>
        </div>
      </Dialog>
    </div>
  )
}
