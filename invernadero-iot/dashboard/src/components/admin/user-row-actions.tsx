'use client'

import { Ban, KeyRound, Loader2, Pencil, Power, ShieldOff } from 'lucide-react'
import { useState, useTransition } from 'react'
import {
  resetUserMfaAction, resetUserPasswordAction, setUserActiveAction, updateUserAccessAction,
} from '@/app/actions/admin'
import { Dialog } from '@/components/ui/dialog'
import type { Role } from '@/lib/rbac'
import { AccessFields } from './access-fields'
import type { GreenhouseOption } from './greenhouse-options-type'
import { SecretReveal } from './secret-reveal'

export interface RowUser {
  id: string
  name: string
  email: string
  role: Role
  isActive: boolean
  hasTotp: boolean
  greenhouseIds: number[]
}

type Modal = null | 'access' | 'password' | 'mfa' | 'deactivate'

/** Acciones de administración sobre un usuario. Cada una pide confirmación y deja registro en la bitácora. */
export function UserRowActions({ user, isSelf, greenhouses }: { user: RowUser; isSelf: boolean; greenhouses: readonly GreenhouseOption[] }) {
  const [modal, setModal] = useState<Modal>(null)
  const [pending, start] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [role, setRole] = useState<Role>(user.role)
  const [ids, setIds] = useState<number[]>(user.greenhouseIds)
  const [newPassword, setNewPassword] = useState<string | null>(null)

  const open = (m: Exclude<Modal, null>) => {
    setError(null); setErrors({}); setNewPassword(null); setRole(user.role); setIds(user.greenhouseIds); setModal(m)
  }
  const close = () => {
    if (pending) return
    setModal(null)
    setNewPassword(null) // la contraseña restablecida no permanece en memoria
    setError(null)
  }
  const failWith = (r: { error: string; fieldErrors?: Record<string, string> }) => {
    setErrors(r.fieldErrors ?? {})
    setError(r.error)
  }

  const saveAccess = () =>
    start(async () => {
      setError(null); setErrors({})
      const r = await updateUserAccessAction(user.id, { role, greenhouseIds: role === 'operator' ? ids : [] })
      if (r.ok) setModal(null)
      else failWith(r)
    })

  const resetPassword = () =>
    start(async () => {
      setError(null)
      const r = await resetUserPasswordAction(user.id)
      if (r.ok) setNewPassword(r.data.password)
      else failWith(r)
    })

  const resetMfa = () =>
    start(async () => {
      setError(null)
      const r = await resetUserMfaAction(user.id)
      if (r.ok) setModal(null)
      else failWith(r)
    })

  const setActive = (active: boolean) =>
    start(async () => {
      setError(null)
      const r = await setUserActiveAction(user.id, active)
      if (r.ok) setModal(null)
      else failWith(r)
    })

  // Nodos JSX y no componentes definidos dentro del render: un componente interno cambia de identidad en cada
  // render, React lo vuelve a montar y el lector de pantalla anunciaría de nuevo la alerta.
  const errorBox = error && Object.keys(errors).length === 0 ? <p role="alert" className="rounded-lg bg-crit-wash px-3 py-2 text-[13px] text-ink">{error}</p> : null
  const spin = pending ? <Loader2 size={15} className="animate-spin" aria-hidden /> : null

  return (
    <div className="flex flex-wrap justify-end gap-1.5">
      <button type="button" className="btn btn-sm" onClick={() => open('access')} aria-label={`Editar rol y sectores de ${user.name}`}>
        <Pencil size={14} aria-hidden /> Acceso
      </button>
      <button type="button" className="btn btn-sm" onClick={() => open('password')} aria-label={`Restablecer contraseña de ${user.name}`}>
        <KeyRound size={14} aria-hidden /> Contraseña
      </button>
      {user.hasTotp && (
        <button type="button" className="btn btn-sm" onClick={() => open('mfa')} aria-label={`Quitar el segundo factor de ${user.name}`}>
          <ShieldOff size={14} aria-hidden /> Quitar 2FA
        </button>
      )}
      {user.isActive ? (
        <button
          type="button" className="btn btn-sm" onClick={() => open('deactivate')} disabled={isSelf}
          title={isSelf ? 'No puedes desactivar tu propia cuenta' : undefined} aria-label={`Desactivar a ${user.name}`}
        >
          <Ban size={14} aria-hidden /> Desactivar
        </button>
      ) : (
        <button type="button" className="btn btn-sm" onClick={() => setActive(true)} disabled={pending} aria-label={`Activar a ${user.name}`}>
          {pending ? <Loader2 size={14} className="animate-spin" aria-hidden /> : <Power size={14} aria-hidden />} Activar
        </button>
      )}
      {!user.isActive && error && <span role="alert" className="basis-full text-right text-[12px] text-crit-ink">{error}</span>}

      <Dialog open={modal === 'access'} onClose={close} locked={pending} width={520} title={`Rol y sectores de ${user.name}`} description={user.email}>
        <div className="flex flex-col gap-4">
          <AccessFields role={role} onRole={setRole} selected={ids} onToggle={(g) => setIds((s) => (s.includes(g) ? s.filter((x) => x !== g) : [...s, g]))} greenhouses={greenhouses} errors={errors} />
          {role !== user.role && <p className="rounded-lg bg-warn-wash px-3 py-2 text-[12.5px] text-ink">Al cambiar el rol se cierran las sesiones de esta persona: tendrá que volver a iniciar sesión.</p>}
          {errorBox}
          <div className="flex justify-end gap-2">
            <button type="button" className="btn" onClick={close} disabled={pending}>Cancelar</button>
            <button type="button" className="btn btn-primary" onClick={saveAccess} disabled={pending}>{spin} Guardar cambios</button>
          </div>
        </div>
      </Dialog>

      <Dialog open={modal === 'password'} onClose={close} locked={pending} title={newPassword ? 'Contraseña restablecida' : `Restablecer la contraseña de ${user.name}`}>
        {newPassword ? (
          <div className="flex flex-col gap-4">
            <SecretReveal label="Contraseña nueva" value={newPassword} warning="Se muestra una sola vez. Se cerraron todas sus sesiones y deberá cambiarla en su próximo ingreso." />
            <div className="flex justify-end"><button type="button" className="btn btn-primary" onClick={close}>Listo</button></div>
          </div>
        ) : (
          <div className="flex flex-col gap-4">
            <p className="text-[13.5px] leading-relaxed text-ink-2">
              Se generará una contraseña aleatoria nueva, se cerrarán todas las sesiones abiertas de <strong className="text-ink">{user.email}</strong> y deberá cambiarla al ingresar.
            </p>
            {errorBox}
            <div className="flex justify-end gap-2">
              <button type="button" className="btn" onClick={close} disabled={pending}>Cancelar</button>
              <button type="button" className="btn btn-danger" onClick={resetPassword} disabled={pending}>{spin} Restablecer</button>
            </div>
          </div>
        )}
      </Dialog>

      <Dialog open={modal === 'mfa'} onClose={close} locked={pending} title={`Quitar el segundo factor de ${user.name}`}>
        <div className="flex flex-col gap-4">
          <p className="text-[13.5px] leading-relaxed text-ink-2">
            Úsalo si perdió su teléfono. Se cerrarán sus sesiones; si su rol exige segundo factor, deberá registrarlo de nuevo al ingresar.
          </p>
          {errorBox}
          <div className="flex justify-end gap-2">
            <button type="button" className="btn" onClick={close} disabled={pending}>Cancelar</button>
            <button type="button" className="btn btn-danger" onClick={resetMfa} disabled={pending}>{spin} Quitar segundo factor</button>
          </div>
        </div>
      </Dialog>

      <Dialog open={modal === 'deactivate'} onClose={close} locked={pending} title={`Desactivar a ${user.name}`}>
        <div className="flex flex-col gap-4">
          <p className="text-[13.5px] leading-relaxed text-ink-2">
            Se cerrarán sus sesiones y no podrá volver a ingresar hasta que lo actives de nuevo. Sus acciones anteriores permanecen en la bitácora.
            El sistema no permite dejar de tener al menos un administrador activo.
          </p>
          {errorBox}
          <div className="flex justify-end gap-2">
            <button type="button" className="btn" onClick={close} disabled={pending}>Cancelar</button>
            <button type="button" className="btn btn-danger" onClick={() => setActive(false)} disabled={pending}>{spin} Desactivar</button>
          </div>
        </div>
      </Dialog>
    </div>
  )
}
