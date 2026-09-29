import { Bell, Cpu, LayoutDashboard, LogOut, ScrollText, Sprout, UserCog, Users, Droplets } from 'lucide-react'
import { logoutAction } from '@/app/actions/auth'
import { ThemeToggle } from '@/components/ui/theme-toggle'
import { type Permission, ROLE_LABELS, type Role, can } from '@/lib/rbac'
import { MobileNav } from './mobile-nav'
import { NavLink } from './nav-link'

export interface ShellUser {
  name: string
  email: string
  role: Role
}

interface NavItem {
  href: string
  label: string
  icon: React.ReactNode
  permission?: Permission
  badge?: 'alerts'
}

const NAV: NavItem[] = [
  { href: '/', label: 'Predio', icon: <LayoutDashboard size={17} aria-hidden />, permission: 'site:view' },
  { href: '/alerts', label: 'Alertas', icon: <Bell size={17} aria-hidden />, permission: 'alerts:view', badge: 'alerts' },
  { href: '/greenhouses', label: 'Invernaderos', icon: <Sprout size={17} aria-hidden />, permission: 'greenhouses:manage' },
  { href: '/devices', label: 'Equipos', icon: <Cpu size={17} aria-hidden />, permission: 'devices:view' },
  { href: '/audit', label: 'Bitácora', icon: <ScrollText size={17} aria-hidden />, permission: 'audit:view' },
  { href: '/users', label: 'Usuarios', icon: <Users size={17} aria-hidden />, permission: 'users:manage' },
  { href: '/account', label: 'Mi cuenta', icon: <UserCog size={17} aria-hidden /> },
]

function initials(name: string): string {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0]!.toUpperCase()).join('') || '?'
}

function Brand() {
  return (
    <div className="flex items-center gap-2.5 px-1">
      <span className="grid h-8 w-8 place-items-center rounded-[9px] bg-accent-btn text-white" aria-hidden>
        <Droplets size={18} />
      </span>
      <div className="min-w-0 leading-tight">
        <div className="text-[14.5px] font-semibold tracking-tight text-ink">Invernadero IoT</div>
        <div className="text-[11.5px] text-ink-3">Monitoreo y riego automático</div>
      </div>
    </div>
  )
}

function NavList({ user, alerts }: { user: ShellUser; alerts: { open: number; critical: number } }) {
  return (
    <nav aria-label="Principal" className="flex flex-col gap-0.5">
      {NAV.filter((n) => !n.permission || can(user.role, n.permission)).map((n) => (
        <NavLink
          key={n.href}
          href={n.href}
          label={n.label}
          badge={n.badge === 'alerts' ? alerts.open : undefined}
          badgeTone={alerts.critical > 0 ? 'crit' : 'neutral'}
        >
          {n.icon}
        </NavLink>
      ))}
    </nav>
  )
}

function UserBlock({ user }: { user: ShellUser }) {
  return (
    <div className="flex items-center gap-2.5 rounded-xl border border-line bg-surface p-2.5">
      <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-accent-wash text-[12px] font-bold text-ink" aria-hidden>{initials(user.name)}</span>
      <div className="min-w-0 flex-1 leading-tight">
        <div className="truncate text-[13px] font-semibold text-ink" title={user.name}>{user.name}</div>
        <div className="truncate text-[11.5px] text-ink-3">{ROLE_LABELS[user.role]}</div>
      </div>
      <ThemeToggle />
      <form action={logoutAction}>
        <button type="submit" className="btn btn-ghost btn-sm" aria-label="Cerrar sesión" title="Cerrar sesión">
          <LogOut size={16} aria-hidden />
        </button>
      </form>
    </div>
  )
}

/** Estructura común de las páginas autenticadas: menú lateral (escritorio) o barra superior (móvil). */
export function AppShell({ user, alerts, children }: { user: ShellUser; alerts: { open: number; critical: number }; children: React.ReactNode }) {
  return (
    <div className="min-h-dvh lg:grid lg:grid-cols-[248px_1fr]">
      <aside className="sticky top-0 hidden h-dvh flex-col justify-between gap-6 border-r border-line bg-page px-3 py-4 lg:flex">
        <div className="flex flex-col gap-6">
          <Brand />
          <NavList user={user} alerts={alerts} />
        </div>
        <UserBlock user={user} />
      </aside>

      <div className="min-w-0">
        <MobileNav brand={<Brand />} nav={<NavList user={user} alerts={alerts} />} userBlock={<UserBlock user={user} />} alertCount={alerts.open} />
        <main id="contenido" className="mx-auto w-full max-w-[1320px] px-4 pb-16 pt-5 sm:px-6 lg:px-8 lg:pt-7">
          {children}
        </main>
      </div>
    </div>
  )
}
