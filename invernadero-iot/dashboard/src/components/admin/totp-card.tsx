'use client'

import { CheckCircle2, Loader2, ShieldCheck, ShieldOff } from 'lucide-react'
import { useActionState, useEffect, useState, useTransition } from 'react'
import {
  type EnrollmentView, beginTotpAction, confirmTotpAction, disableTotpAction,
} from '@/app/actions/account'
import { Chip } from '@/components/ui/status'
import type { ActionResult } from '@/lib/actions/result'
import { CopyButton } from './copy-button'

interface Props {
  hasTotp: boolean
  /** La política exige segundo factor para este rol: no se puede desactivar. */
  mfaRequired: boolean
}

/**
 * Segundo factor (TOTP, RFC 6238), en dos fases: primero se genera la semilla y se muestra el QR; solo se
 * ACTIVA cuando la persona demuestra que su app funciona escribiendo un código válido.
 */
export function TotpCard({ hasTotp, mfaRequired }: Props) {
  const [enroll, setEnroll] = useState<EnrollmentView | null>(null)
  const [beginError, setBeginError] = useState<string | null>(null)
  const [beginPending, startBegin] = useTransition()
  const [cState, cAction, cPending] = useActionState<ActionResult | null, FormData>(confirmTotpAction, null)
  const [dState, dAction, dPending] = useActionState<ActionResult | null, FormData>(disableTotpAction, null)

  useEffect(() => {
    if (cState?.ok) setEnroll(null) // activado: la semilla ya no debe seguir en pantalla
  }, [cState])

  const begin = () =>
    startBegin(async () => {
      setBeginError(null)
      const r = await beginTotpAction()
      if (r.ok) setEnroll(r.data)
      else setBeginError(r.error)
    })

  const cErr = cState && !cState.ok ? (cState.fieldErrors?.code ?? cState.error) : null
  const dErr = dState && !dState.ok ? (dState.fieldErrors?.password ?? dState.error) : null
  const grouped = enroll?.secret.match(/.{1,4}/g)?.join(' ') ?? ''

  if (hasTotp && !enroll) {
    return (
      <div className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center gap-3">
          <Chip tone="good" icon={ShieldCheck}>Segundo factor activo</Chip>
          <span className="text-[13px] text-ink-2">Al ingresar, además de la contraseña se pide un código de 6 dígitos de tu app.</span>
        </div>
        {mfaRequired ? (
          <p className="text-[13px] text-ink-3">Tu rol exige segundo factor, por eso no se puede desactivar.</p>
        ) : (
          <form action={dAction} className="flex max-w-[420px] flex-col gap-3" noValidate>
            <div>
              <label htmlFor="mfa-off-pw" className="label">Para desactivarlo, confirma tu contraseña</label>
              <input id="mfa-off-pw" name="password" type="password" autoComplete="current-password" className="input" required aria-invalid={!!dErr} aria-describedby={dErr ? 'mfa-off-e' : undefined} />
              {dErr && <p id="mfa-off-e" role="alert" className="field-error">{dErr}</p>}
            </div>
            <div>
              <button type="submit" className="btn btn-danger" disabled={dPending}>
                {dPending && <Loader2 size={15} className="animate-spin" aria-hidden />}
                <ShieldOff size={15} aria-hidden /> Desactivar segundo factor
              </button>
            </div>
          </form>
        )}
        {cState?.ok && (
          <p role="status" className="flex items-center gap-2 text-[13px] text-ink"><CheckCircle2 size={16} className="text-good" aria-hidden /> {cState.message ?? 'Segundo factor activado.'}</p>
        )}
      </div>
    )
  }

  if (!enroll) {
    return (
      <div className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center gap-3">
          <Chip tone="off" icon={ShieldOff}>Segundo factor no configurado</Chip>
          <span className="text-[13px] text-ink-2">
            {mfaRequired ? 'Tu rol lo exige: configúralo para poder usar el panel.' : 'Recomendado: protege tu cuenta aunque alguien conozca tu contraseña.'}
          </span>
        </div>
        {beginError && <p role="alert" className="rounded-lg bg-crit-wash px-3 py-2 text-[13px] text-ink">{beginError}</p>}
        <div>
          <button type="button" className="btn btn-primary" onClick={begin} disabled={beginPending}>
            {beginPending ? <Loader2 size={15} className="animate-spin" aria-hidden /> : <ShieldCheck size={15} aria-hidden />} Configurar segundo factor
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-5">
      <ol className="list-decimal space-y-1 pl-5 text-[13.5px] leading-relaxed text-ink-2">
        <li>Instala una app autenticadora (Google Authenticator, Microsoft Authenticator, Aegis, 1Password…).</li>
        <li>Escanea el código QR o escribe la clave manualmente.</li>
        <li>Ingresa el código de 6 dígitos que muestra la app para confirmar.</li>
      </ol>
      <div className="flex flex-wrap items-start gap-6">
        {/* eslint-disable-next-line @next/next/no-img-element -- data URL generado en el servidor: next/image no aplica */}
        <img src={enroll.qr} width={200} height={200} alt="Código QR para tu app autenticadora" className="rounded-lg border border-line bg-white p-1.5" />
        <div className="flex min-w-[240px] flex-1 flex-col gap-4">
          <div>
            <div className="label">Clave manual</div>
            <code id="mfa-secret" className="block select-all break-all rounded-lg border border-line-strong bg-surface-2 px-3 py-2 font-mono text-[14px] tracking-wider text-ink" data-testid="totp-secret" data-raw={enroll.secret}>
              {grouped}
            </code>
            <div className="mt-2"><CopyButton value={enroll.secret} label="Copiar clave" selectTargetId="mfa-secret" /></div>
          </div>
          <form action={cAction} className="flex max-w-[300px] flex-col gap-3" noValidate>
            <input type="hidden" name="enrollToken" value={enroll.enrollToken} />
            <div>
              <label htmlFor="mfa-code" className="label">Código de 6 dígitos</label>
              <input
                id="mfa-code" name="code" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9 ]*" maxLength={8}
                className="input tracking-[0.3em]" placeholder="000000" required aria-invalid={!!cErr} aria-describedby={cErr ? 'mfa-code-e' : undefined}
              />
              {cErr && <p id="mfa-code-e" role="alert" className="field-error">{cErr}</p>}
            </div>
            <div className="flex flex-wrap gap-2">
              <button type="submit" className="btn btn-primary" disabled={cPending}>
                {cPending && <Loader2 size={15} className="animate-spin" aria-hidden />} Activar
              </button>
              <button type="button" className="btn" onClick={() => setEnroll(null)} disabled={cPending}>Cancelar</button>
            </div>
          </form>
        </div>
      </div>
    </div>
  )
}
