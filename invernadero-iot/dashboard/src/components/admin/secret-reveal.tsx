'use client'

import { useId } from 'react'
import { TriangleAlert } from 'lucide-react'
import { CopyButton } from './copy-button'

/**
 * Muestra UNA sola vez un secreto recién generado (contraseña inicial, contraseña restablecida, token de
 * un nodo). El servidor no lo guarda en claro: si se cierra el diálogo sin copiarlo, hay que generarlo de nuevo.
 */
export function SecretReveal({ label, value, warning }: { label: string; value: string; warning: string }) {
  const id = useId().replace(/[^a-zA-Z0-9_-]/g, '')
  return (
    <div className="flex flex-col gap-3">
      <div>
        <div className="label">{label}</div>
        <code
          id={`sec-${id}`}
          className="block select-all break-all rounded-lg border border-line-strong bg-surface-2 px-3 py-2.5 font-mono text-[14px] leading-snug text-ink"
          data-testid="secret-value"
        >
          {value}
        </code>
      </div>
      <div className="flex items-start gap-2 rounded-lg bg-warn-wash px-3 py-2 text-[12.5px] leading-snug text-ink">
        <TriangleAlert size={16} className="mt-px shrink-0 text-warn-ink" aria-hidden />
        <p>{warning}</p>
      </div>
      <div>
        <CopyButton value={value} selectTargetId={`sec-${id}`} />
      </div>
    </div>
  )
}
