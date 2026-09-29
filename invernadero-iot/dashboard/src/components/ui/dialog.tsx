'use client'

import { X } from 'lucide-react'
import { useEffect, useRef } from 'react'
import { cn } from '@/lib/cn'

interface DialogProps {
  open: boolean
  onClose: () => void
  title: string
  description?: string
  children: React.ReactNode
  /** Ancho máximo en px. */
  width?: number
  /** Impide cerrar con Escape o clic fuera (p. ej. mientras se procesa una orden). */
  locked?: boolean
}

/**
 * Diálogo modal sobre el elemento nativo <dialog>: el navegador ya entrega el atrape del foco,
 * el cierre con Escape y la inertización del resto de la página.
 */
export function Dialog({ open, onClose, title, description, children, width = 460, locked }: DialogProps) {
  const ref = useRef<HTMLDialogElement>(null)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    if (open && !el.open) el.showModal()
    if (!open && el.open) el.close()
  }, [open])

  return (
    <dialog
      ref={ref}
      onCancel={(e) => {
        e.preventDefault()
        if (!locked) onClose()
      }}
      onClick={(e) => {
        if (e.target === ref.current && !locked) onClose()
      }}
      className={cn('m-auto w-[calc(100vw-32px)] rounded-2xl border border-line-strong bg-surface p-0 shadow-[0_24px_64px_rgb(0_0_0/0.3)]')}
      style={{ maxWidth: width }}
      aria-labelledby="dlg-title"
    >
      {open && (
        <div className="p-5">
          <div className="mb-4 flex items-start justify-between gap-3">
            <div>
              <h2 id="dlg-title" className="text-[16px] font-semibold text-ink">{title}</h2>
              {description && <p className="mt-1 text-[13px] text-ink-3">{description}</p>}
            </div>
            <button type="button" className="btn btn-ghost btn-sm -mr-2 -mt-1" onClick={onClose} disabled={locked} aria-label="Cerrar">
              <X size={16} aria-hidden />
            </button>
          </div>
          {children}
        </div>
      )}
    </dialog>
  )
}
