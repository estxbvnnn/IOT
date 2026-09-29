'use client'

import { CheckCheck, Loader2 } from 'lucide-react'
import { useState, useTransition } from 'react'
import { ackAlertAction } from '@/app/actions/operations'

/** Reconocer una alerta: «la vi y me hago cargo». Queda en la bitácora con quién y cuándo. */
export function AckButton({ alertId, code }: { alertId: number; code: string | null }) {
  const [pending, start] = useTransition()
  const [error, setError] = useState<string | null>(null)

  const ack = () =>
    start(async () => {
      setError(null)
      const r = await ackAlertAction(alertId)
      if (!r.ok) setError(r.error)
      else if (!r.data) setError('Ya no se puede reconocer (otra persona la reconoció o se resolvió).')
    })

  return (
    <div className="flex flex-col items-end gap-1">
      <button type="button" className="btn btn-sm" onClick={ack} disabled={pending} aria-label={`Reconocer alerta${code ? ` de ${code}` : ' del predio'}`}>
        {pending ? <Loader2 size={14} className="animate-spin" aria-hidden /> : <CheckCheck size={14} aria-hidden />}
        Reconocer
      </button>
      {error && <span role="alert" className="max-w-[220px] text-right text-[12px] text-crit-ink">{error}</span>}
    </div>
  )
}
