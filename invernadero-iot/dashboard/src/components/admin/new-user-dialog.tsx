'use client'

import { Loader2, UserPlus } from 'lucide-react'
import { useId, useState, useTransition } from 'react'
import { createUserAction } from '@/app/actions/admin'
import { Dialog } from '@/components/ui/dialog'
import type { Role } from '@/lib/rbac'
import { AccessFields } from './access-fields'
import type { GreenhouseOption } from './greenhouse-options-type'
import { SecretReveal } from './secret-reveal'

/** Alta de un usuario. La contraseña inicial es aleatoria, se muestra UNA vez y debe cambiarse al primer ingreso. */
export function NewUserButton({ greenhouses }: { greenhouses: readonly GreenhouseOption[] }) {
  const id = useId()
  const [open, setOpen] = useState(false)
  const [pending, start] = useTransition()
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [role, setRole] = useState<Role>('operator')
  const [ids, setIds] = useState<number[]>([])
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [formError, setFormError] = useState<string | null>(null)
  const [created, setCreated] = useState<{ email: string; password: string } | null>(null)

  const reset = () => {
    setName(''); setEmail(''); setRole('operator'); setIds([]); setErrors({}); setFormError(null); setCreated(null)
  }
  const close = () => {
    if (pending) return
    setOpen(false)
    reset() // la contraseña inicial no permanece en memoria al cerrar
  }

  const submit = (e: React.FormEvent) => {
    e.preventDefault()
    start(async () => {
      setErrors({})
      setFormError(null)
      const r = await createUserAction({ name, email, role, greenhouseIds: role === 'operator' ? ids : [] })
      if (r.ok) setCreated({ email: r.data.user.email, password: r.data.initialPassword })
      else {
        setErrors(r.fieldErrors ?? {})
        if (!r.fieldErrors || Object.keys(r.fieldErrors).length === 0) setFormError(r.error)
      }
    })
  }

  return (
    <>
      <button type="button" className="btn btn-primary" onClick={() => setOpen(true)}>
        <UserPlus size={16} aria-hidden /> Nuevo usuario
      </button>
      <Dialog open={open} onClose={close} locked={pending} width={520} title={created ? 'Usuario creado' : 'Nuevo usuario'} description={created ? undefined : 'Recibirá una contraseña inicial que deberá cambiar al ingresar.'}>
        {created ? (
          <div className="flex flex-col gap-4">
            <p className="text-[13.5px] text-ink-2">Cuenta creada para <strong className="text-ink">{created.email}</strong>.</p>
            <SecretReveal
              label="Contraseña inicial"
              value={created.password}
              warning="Se muestra una sola vez. Entrégala por un canal seguro: la persona deberá cambiarla en su primer ingreso."
            />
            <div className="flex justify-end">
              <button type="button" className="btn btn-primary" onClick={close}>Listo</button>
            </div>
          </div>
        ) : (
          <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
            <div>
              <label htmlFor={`${id}-n`} className="label">Nombre completo</label>
              <input id={`${id}-n`} className="input" value={name} onChange={(e) => setName(e.target.value)} autoComplete="off" maxLength={120} required aria-invalid={!!errors.name} aria-describedby={errors.name ? `${id}-n-e` : undefined} />
              {errors.name && <p id={`${id}-n-e`} className="field-error">{errors.name}</p>}
            </div>
            <div>
              <label htmlFor={`${id}-e`} className="label">Correo</label>
              <input id={`${id}-e`} type="email" className="input" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="off" maxLength={254} required aria-invalid={!!errors.email} aria-describedby={errors.email ? `${id}-e-e` : undefined} />
              {errors.email && <p id={`${id}-e-e`} className="field-error">{errors.email}</p>}
            </div>
            <AccessFields role={role} onRole={setRole} selected={ids} onToggle={(g) => setIds((s) => (s.includes(g) ? s.filter((x) => x !== g) : [...s, g]))} onSetAll={setIds} greenhouses={greenhouses} errors={errors} />
            {formError && <p role="alert" className="rounded-lg bg-crit-wash px-3 py-2 text-[13px] text-ink">{formError}</p>}
            <div className="flex justify-end gap-2">
              <button type="button" className="btn" onClick={close} disabled={pending}>Cancelar</button>
              <button type="submit" className="btn btn-primary" disabled={pending}>
                {pending && <Loader2 size={15} className="animate-spin" aria-hidden />} Crear usuario
              </button>
            </div>
          </form>
        )}
      </Dialog>
    </>
  )
}
