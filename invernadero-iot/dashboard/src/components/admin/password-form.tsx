'use client'

import { CheckCircle2, Loader2 } from 'lucide-react'
import { useActionState, useEffect, useRef } from 'react'
import { changePasswordAction } from '@/app/actions/account'
import type { ActionResult } from '@/lib/actions/result'

/** Cambio de contraseña. Al cambiarla se cierran las demás sesiones de la cuenta (esta se conserva). */
export function PasswordForm() {
  const [state, action, pending] = useActionState<ActionResult | null, FormData>(changePasswordAction, null)
  const ref = useRef<HTMLFormElement>(null)

  useEffect(() => {
    if (state?.ok) ref.current?.reset() // no dejar las contraseñas escritas en el formulario
  }, [state])

  const fe = state && !state.ok ? (state.fieldErrors ?? {}) : {}
  const general = state && !state.ok && Object.keys(fe).length === 0 ? state.error : null

  return (
    <form ref={ref} action={action} className="flex max-w-[420px] flex-col gap-4" noValidate>
      <div>
        <label htmlFor="pw-current" className="label">Contraseña actual</label>
        <input id="pw-current" name="current" type="password" autoComplete="current-password" className="input" required aria-invalid={!!fe.current} aria-describedby={fe.current ? 'pw-current-e' : undefined} />
        {fe.current && <p id="pw-current-e" className="field-error">{fe.current}</p>}
      </div>
      <div>
        <label htmlFor="pw-next" className="label">Contraseña nueva</label>
        <input id="pw-next" name="next" type="password" autoComplete="new-password" className="input" required minLength={12} aria-invalid={!!fe.next} aria-describedby={`pw-next-h${fe.next ? ' pw-next-e' : ''}`} />
        <p id="pw-next-h" className="hint">Al menos 12 caracteres, con letras y números. No puede contener tu correo ni tu nombre, ni ser una clave común.</p>
        {fe.next && <p id="pw-next-e" className="field-error">{fe.next}</p>}
      </div>
      <div>
        <label htmlFor="pw-confirm" className="label">Repite la contraseña nueva</label>
        <input id="pw-confirm" name="confirm" type="password" autoComplete="new-password" className="input" required aria-invalid={!!fe.confirm} aria-describedby={fe.confirm ? 'pw-confirm-e' : undefined} />
        {fe.confirm && <p id="pw-confirm-e" className="field-error">{fe.confirm}</p>}
      </div>
      {general && <p role="alert" className="rounded-lg bg-crit-wash px-3 py-2 text-[13px] text-ink">{general}</p>}
      {state?.ok && (
        <p role="status" className="flex items-start gap-2 rounded-lg bg-good-wash px-3 py-2 text-[13px] text-ink">
          <CheckCircle2 size={16} className="mt-px shrink-0 text-good" aria-hidden />
          {state.message ?? 'Contraseña actualizada.'}
        </p>
      )}
      <div>
        <button type="submit" className="btn btn-primary" disabled={pending}>
          {pending && <Loader2 size={15} className="animate-spin" aria-hidden />} Cambiar contraseña
        </button>
      </div>
    </form>
  )
}
