import { AppShell } from '@/components/layout/app-shell'
import { getDb } from '@/lib/db'
import { requireUser } from '@/lib/dal'
import { can } from '@/lib/rbac'
import { countOpenAlerts } from '@/lib/services/alerts'

/**
 * Estructura de las páginas autenticadas. Aquí solo se exige estar autenticado (y se permite el paso a la
 * página de cuenta si falta cumplir la política); CADA PÁGINA vuelve a verificar su propio permiso, porque en
 * el App Router los layouts no se re-ejecutan al navegar entre páginas.
 */
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser({ allowRestricted: true })
  const alerts = can(user.role, 'alerts:view') ? await countOpenAlerts(getDb(), user) : { open: 0, critical: 0 }
  return (
    <AppShell user={{ name: user.name, email: user.email, role: user.role }} alerts={alerts}>
      {children}
    </AppShell>
  )
}
