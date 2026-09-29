'use client'

import { Loader2 } from 'lucide-react'
import { useActionState } from 'react'
import { type LoginState, loginAction } from '@/app/actions/auth'

export function LoginForm({ next }: { next: string }) {
  const [state, action, pending] = useActionState<LoginState | null, FormData>(loginAction, null)
  return (
    <form action={action} className="flex flex-col gap-4" noValidate>
      {next !== '/' && <input type="hidden" name="next" value={next} />}
      <div>
        <label htmlFor="email" className="label">Correo</label>
        <input id="email" name="email" type="email" autoComplete="username" required autoFocus className="input" placeholder="nombre@empresa.cl" aria-invalid={!!state?.error} />
      </div>
      <div>
        <label htmlFor="password" className="label">Contraseña</label>
        <input id="password" name="password" type="password" autoComplete="current-password" required className="input" aria-invalid={!!state?.error} />
      </div>
      {state?.needsCode && (
        <div>
          <label htmlFor="totp" className="label">Código de verificación</label>
          <input
            id="totp" name="totp" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9 ]*" maxLength={8}
            required autoFocus className="input tracking-[0.3em]" placeholder="000000" aria-describedby="totp-hint"
          />
          <p id="totp-hint" className="hint">Abre tu app autenticadora e ingresa el código de 6 dígitos.</p>
        </div>
      )}
      {state?.error && (
        <p role="alert" className="rounded-lg bg-crit-wash px-3 py-2 text-[13px] text-ink">{state.error}</p>
      )}
      <button type="submit" className="btn btn-primary min-h-[42px]" disabled={pending}>
        {pending && <Loader2 size={16} className="animate-spin" aria-hidden />}
        {state?.needsCode ? 'Verificar e ingresar' : 'Ingresar'}
      </button>
    </form>
  )
}
