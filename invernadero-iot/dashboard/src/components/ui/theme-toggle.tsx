'use client'

import { Moon, Sun } from 'lucide-react'
import { useSyncExternalStore } from 'react'

function subscribe(cb: () => void): () => void {
  const obs = new MutationObserver(cb)
  obs.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
  const mq = window.matchMedia('(prefers-color-scheme: dark)')
  mq.addEventListener('change', cb)
  return () => {
    obs.disconnect()
    mq.removeEventListener('change', cb)
  }
}

function isDark(): boolean {
  const t = document.documentElement.dataset.theme
  return t ? t === 'dark' : window.matchMedia('(prefers-color-scheme: dark)').matches
}

/** Alterna claro/oscuro y recuerda la elección en este navegador (localStorage, opcional). */
export function ThemeToggle() {
  const dark = useSyncExternalStore(subscribe, isDark, () => false)
  const toggle = () => {
    const next = dark ? 'light' : 'dark'
    document.documentElement.dataset.theme = next
    try {
      localStorage.setItem('theme', next)
    } catch {
      /* el navegador puede bloquear el almacenamiento: el tema igual cambia en esta sesión */
    }
  }
  return (
    <button type="button" onClick={toggle} className="btn btn-ghost btn-sm" aria-label={dark ? 'Cambiar a tema claro' : 'Cambiar a tema oscuro'} title="Cambiar tema">
      {dark ? <Sun size={16} aria-hidden /> : <Moon size={16} aria-hidden />}
    </button>
  )
}
