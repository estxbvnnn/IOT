'use client'

import { Check, Copy } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

/**
 * Copia un texto al portapapeles y confirma con texto («Copiado»), no solo con un ícono.
 * Si el navegador bloquea el portapapeles (p. ej. HTTP en una IP de la red local), selecciona el texto
 * del elemento indicado para que se pueda copiar con Ctrl+C.
 */
export function CopyButton({ value, label = 'Copiar', selectTargetId }: { value: string; label?: string; selectTargetId?: string }) {
  const [state, setState] = useState<'idle' | 'copied' | 'manual'>('idle')
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)

  useEffect(() => () => clearTimeout(timer.current), [])

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value)
      setState('copied')
    } catch {
      const el = selectTargetId ? document.getElementById(selectTargetId) : null
      if (el) {
        const range = document.createRange()
        range.selectNodeContents(el)
        const sel = window.getSelection()
        sel?.removeAllRanges()
        sel?.addRange(range)
      }
      setState('manual')
    }
    clearTimeout(timer.current)
    timer.current = setTimeout(() => setState('idle'), 3500)
  }

  return (
    <button type="button" className="btn btn-sm" onClick={copy}>
      {state === 'copied' ? <Check size={14} aria-hidden /> : <Copy size={14} aria-hidden />}
      <span role="status">{state === 'copied' ? 'Copiado' : state === 'manual' ? 'Seleccionado: usa Ctrl+C' : label}</span>
    </button>
  )
}
