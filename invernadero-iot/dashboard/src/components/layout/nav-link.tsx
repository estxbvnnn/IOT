'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { cn } from '@/lib/cn'

interface NavLinkProps {
  href: string
  label: string
  children: React.ReactNode
  badge?: number
  badgeTone?: 'crit' | 'neutral'
  onNavigate?: () => void
}

/** Enlace del menú con estado activo (aria-current). «/» solo es activo en la portada exacta. */
export function NavLink({ href, label, children, badge, badgeTone = 'neutral', onNavigate }: NavLinkProps) {
  const path = usePathname()
  const active = href === '/' ? path === '/' : path === href || path.startsWith(`${href}/`)
  return (
    <Link
      href={href}
      onClick={onNavigate}
      aria-current={active ? 'page' : undefined}
      className={cn(
        'group flex min-h-[38px] items-center gap-2.5 rounded-lg px-2.5 text-[13.5px] font-medium transition-colors',
        active ? 'bg-accent-wash text-ink' : 'text-ink-2 hover:bg-surface-2 hover:text-ink',
      )}
    >
      <span className={cn('shrink-0', active ? 'text-accent' : 'text-ink-3 group-hover:text-ink-2')}>{children}</span>
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {badge !== undefined && badge > 0 && (
        <span
          className={cn(
            'inline-flex h-[20px] min-w-[20px] items-center justify-center rounded-full px-1.5 text-[11.5px] font-bold',
            badgeTone === 'crit' ? 'bg-crit text-white' : 'bg-off-wash text-ink',
          )}
          aria-label={`${badge} sin reconocer`}
        >
          {badge > 99 ? '99+' : badge}
        </span>
      )}
    </Link>
  )
}
