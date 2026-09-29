import type { Metadata } from 'next'
import { Info } from 'lucide-react'
import { listGreenhouseOptions } from '@/components/admin/greenhouse-options'
import { NewUserButton } from '@/components/admin/new-user-dialog'
import { PageHeader } from '@/components/admin/page-header'
import { UsersTable } from '@/components/admin/users-table'
import { Card } from '@/components/ui/card'
import { getDb } from '@/lib/db'
import { requirePermission } from '@/lib/dal'
import { listUsers } from '@/lib/services/users'

export const metadata: Metadata = { title: 'Usuarios' }

/** Gestión de cuentas: solo el administrador (permiso users:manage). */
export default async function UsersPage() {
  const admin = await requirePermission('users:manage')
  const db = getDb()
  const [users, greenhouses] = await Promise.all([listUsers(db, admin), listGreenhouseOptions(db, admin)])
  const active = users.filter((u) => u.isActive).length

  return (
    <>
      <PageHeader
        title="Usuarios"
        subtitle="Cuentas del sistema y sus permisos. Cada rol recibe solo lo que necesita para su función (mínimo privilegio)."
        actions={<NewUserButton greenhouses={greenhouses} />}
      />

      <Card flush title="Cuentas" description={`${users.length} ${users.length === 1 ? 'usuario' : 'usuarios'} · ${active} ${active === 1 ? 'activo' : 'activos'}`}>
        <UsersTable users={users} currentUserId={admin.id} greenhouses={greenhouses} />
      </Card>

      <aside className="card mt-4 flex items-start gap-3 px-[18px] py-4 text-[13px] leading-relaxed text-ink-2" aria-label="Notas sobre la gestión de cuentas">
        <Info size={17} className="mt-0.5 shrink-0 text-ink-3" aria-hidden />
        <div className="flex flex-col gap-1.5">
          <p>
            Las cuentas <strong className="text-ink">no se borran</strong>: se desactivan, para conservar la trazabilidad de sus acciones en la bitácora.
            Las contraseñas iniciales y las restablecidas son aleatorias y se muestran una sola vez.
          </p>
          <p>
            Tras 5 intentos fallidos seguidos una cuenta se bloquea 15 minutos. Si el rol lo exige (variable <code className="font-mono text-[12px]">MFA_REQUIRED_ROLES</code>),
            la persona debe registrar un segundo factor antes de usar el sistema.
          </p>
        </div>
      </aside>
    </>
  )
}
