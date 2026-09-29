'use client'

import { Loader2, ShieldAlert, ShieldCheck } from 'lucide-react'
import { useRouter } from 'next/navigation'
import { useState, useTransition } from 'react'
import { verifyAuditAction } from '@/app/actions/admin'
import { Chip } from '@/components/ui/status'
import { fmtNum } from '@/lib/format'

/**
 * Recorre TODA la cadena de hashes en la base y confirma que ningún registro fue alterado.
 * La verificación misma queda registrada en la bitácora.
 */
export function VerifyChain() {
  const [pending, start] = useTransition()
  const router = useRouter()
  const [result, setResult] = useState<{ checked: number; firstBrokenId: number | null } | null>(null)
  const [error, setError] = useState<string | null>(null)

  const run = () =>
    start(async () => {
      setError(null)
      const r = await verifyAuditAction()
      if (r.ok) {
        setResult(r.data)
        router.refresh() // aparece el registro «Verificación de la cadena»
      } else {
        setResult(null)
        setError(r.error)
      }
    })

  return (
    <div className="flex flex-wrap items-center gap-3">
      <button type="button" className="btn" onClick={run} disabled={pending}>
        {pending ? <Loader2 size={15} className="animate-spin" aria-hidden /> : <ShieldCheck size={15} aria-hidden />}
        Verificar integridad de la cadena
      </button>
      <div aria-live="polite" role="status">
        {result && (result.firstBrokenId === null ? (
          <Chip tone="good" icon={ShieldCheck}>Íntegra: {fmtNum(result.checked, 0)} registros</Chip>
        ) : (
          <Chip tone="crit" icon={ShieldAlert}>ROTA en el registro #{result.firstBrokenId}</Chip>
        ))}
        {error && <span className="text-[13px] text-crit-ink">{error}</span>}
      </div>
    </div>
  )
}
