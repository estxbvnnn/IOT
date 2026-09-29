'use client'

import { useRouter } from 'next/navigation'

/**
 * Hace clicable toda la fila de una tabla (las filas llevan `data-href`). Es solo comodidad para el ratón:
 * el enlace real está en la primera celda, que es lo que usan el teclado y los lectores de pantalla,
 * y lo que permite abrir en otra pestaña. Las filas se renderizan en el servidor (children).
 */
export function RowLinks({ children, className }: { children: React.ReactNode; className?: string }) {
  const router = useRouter()
  return (
    <div
      className={className}
      onClick={(e) => {
        const target = e.target as HTMLElement
        if (target.closest('a, button, input, select, textarea, summary')) return // los controles reales actúan solos
        if (window.getSelection()?.toString()) return // no interrumpir una selección de texto
        const href = target.closest<HTMLElement>('tr[data-href]')?.dataset.href
        if (href) router.push(href)
      }}
    >
      {children}
    </div>
  )
}
