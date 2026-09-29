'use client'

import { useRouter } from 'next/navigation'
import { useEffect, useState, useTransition } from 'react'
import { RefreshCw } from 'lucide-react'
import { fmtAgo } from '@/lib/format'
import { cn } from '@/lib/cn'

/**
 * Mantiene la página «en vivo»: cada `everyMs` pide al servidor los datos nuevos (router.refresh) y
 * conserva lo que ya se ve mientras llegan (sin esqueletos ni saltos). Se pausa con la pestaña oculta.
 */
export function AutoRefresh({ generatedAt, everyMs = 10_000 }: { generatedAt: string; everyMs?: number }) {
  const router = useRouter()
  const [pending, start] = useTransition()
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    const tick = setInterval(() => setNow(Date.now()), 1000)
    const poll = setInterval(() => {
      if (document.visibilityState === 'visible') start(() => router.refresh())
    }, everyMs)
    const onVisible = () => {
      if (document.visibilityState === 'visible') start(() => router.refresh())
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      clearInterval(tick)
      clearInterval(poll)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [router, everyMs])

  const ageS = Math.max(0, Math.round((now - new Date(generatedAt).getTime()) / 1000))
  return (
    <button
      type="button"
      onClick={() => start(() => router.refresh())}
      className="btn btn-ghost btn-sm text-ink-3"
      aria-label="Actualizar ahora"
      title="Actualizar ahora"
    >
      <RefreshCw size={14} className={cn(pending && 'animate-spin')} aria-hidden />
      <span suppressHydrationWarning>Actualizado {fmtAgo(ageS)}</span>
    </button>
  )
}
