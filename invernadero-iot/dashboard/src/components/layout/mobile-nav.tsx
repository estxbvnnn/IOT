'use client'

import { Menu, X } from 'lucide-react'
import { usePathname } from 'next/navigation'
import { useEffect, useState } from 'react'

/** Barra superior y cajón de navegación para pantallas pequeñas (< 1024 px). */
export function MobileNav({ brand, nav, userBlock, alertCount }: { brand: React.ReactNode; nav: React.ReactNode; userBlock: React.ReactNode; alertCount: number }) {
  const [open, setOpen] = useState(false)
  const path = usePathname()

  useEffect(() => setOpen(false), [path])
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false)
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open])

  return (
    <div className="lg:hidden">
      <div className="sticky top-0 z-30 flex h-14 items-center justify-between border-b border-line bg-page/95 px-4 backdrop-blur">
        {brand}
        <button
          type="button"
          className="btn btn-ghost relative"
          aria-expanded={open}
          aria-controls="menu-movil"
          aria-label={open ? 'Cerrar menú' : 'Abrir menú'}
          onClick={() => setOpen((v) => !v)}
        >
          {open ? <X size={20} aria-hidden /> : <Menu size={20} aria-hidden />}
          {!open && alertCount > 0 && <span className="absolute right-1.5 top-1.5 h-2.5 w-2.5 rounded-full bg-crit ring-2 ring-[var(--page)]" aria-hidden />}
        </button>
      </div>
      {open && (
        <div id="menu-movil" className="fixed inset-x-0 top-14 z-20 flex max-h-[calc(100dvh-56px)] flex-col gap-4 overflow-auto border-b border-line bg-page p-4 shadow-lg">
          {nav}
          {userBlock}
        </div>
      )}
    </div>
  )
}
