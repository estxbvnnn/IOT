import { Ban, CheckCircle2, KeyRound, Lock, ShieldCheck, ShieldOff, TriangleAlert } from 'lucide-react'
import { Chip } from '@/components/ui/status'
import { fmtAgo, fmtDateTime, fmtHM } from '@/lib/format'
import { ROLE_LABELS } from '@/lib/rbac'
import type { UserDTO } from '@/lib/services/users'
import type { GreenhouseOption } from './greenhouse-options-type'
import { UserRowActions } from './user-row-actions'

export function UsersTable({ users, currentUserId, greenhouses }: { users: UserDTO[]; currentUserId: string; greenhouses: GreenhouseOption[] }) {
  const codeOf = new Map(greenhouses.map((g) => [g.id, g.code]))
  const now = Date.now()
  return (
    <div className="overflow-x-auto">
      <table className="tbl min-w-[1000px]">
        <thead>
          <tr>
            <th scope="col">Usuario</th>
            <th scope="col">Rol</th>
            <th scope="col">Sectores</th>
            <th scope="col">Segundo factor</th>
            <th scope="col">Último acceso</th>
            <th scope="col">Estado</th>
            <th scope="col"><span className="sr-only">Acciones</span></th>
          </tr>
        </thead>
        <tbody>
          {users.map((u) => {
            const locked = u.lockedUntil !== null
            return (
              <tr key={u.id} data-user-email={u.email}>
                <td className="max-w-[260px]">
                  <div className="truncate font-semibold text-ink" title={u.name}>
                    {u.name}
                    {u.id === currentUserId && <span className="ml-1.5 text-[12px] font-normal text-ink-3">(tú)</span>}
                  </div>
                  <div className="truncate text-[12px] text-ink-3" title={u.email}>{u.email}</div>
                </td>
                <td className="whitespace-nowrap text-ink-2">{ROLE_LABELS[u.role]}</td>
                <td>
                  {u.role === 'operator' ? (
                    u.greenhouseIds.length > 0 ? (
                      <div className="flex max-w-[190px] flex-wrap gap-1">
                        {u.greenhouseIds.map((id) => (
                          <span key={id} className="rounded-md border border-line-strong px-1.5 py-px text-[12px] font-semibold text-ink-2">{codeOf.get(id) ?? `#${id}`}</span>
                        ))}
                      </div>
                    ) : (
                      <Chip tone="warn" icon={TriangleAlert}>Sin sectores</Chip>
                    )
                  ) : (
                    <span className="text-ink-3">Todos</span>
                  )}
                </td>
                <td className="whitespace-nowrap">
                  {u.hasTotp ? <Chip tone="good" icon={ShieldCheck}>Activo</Chip> : <Chip tone="off" icon={ShieldOff}>Sin 2FA</Chip>}
                </td>
                <td className="whitespace-nowrap">
                  {u.lastLoginAt ? (
                    <>
                      <div className="text-ink">{fmtAgo(Math.max(0, Math.round((now - new Date(u.lastLoginAt).getTime()) / 1000)))}</div>
                      <div className="text-[12px] text-ink-3">{fmtDateTime(u.lastLoginAt)}</div>
                    </>
                  ) : (
                    <span className="text-ink-3">Nunca</span>
                  )}
                </td>
                <td>
                  <div className="flex flex-col items-start gap-1">
                    {!u.isActive ? (
                      <Chip tone="off" icon={Ban}>Desactivado</Chip>
                    ) : locked ? (
                      <Chip tone="warn" icon={Lock}>Bloqueado hasta {fmtHM(u.lockedUntil!)}</Chip>
                    ) : (
                      <Chip tone="good" icon={CheckCircle2}>Activo</Chip>
                    )}
                    {u.mustChangePassword && <Chip tone="info" icon={KeyRound}>Debe cambiar su clave</Chip>}
                  </div>
                </td>
                <td className="text-right">
                  <UserRowActions
                    user={{ id: u.id, name: u.name, email: u.email, role: u.role, isActive: u.isActive, hasTotp: u.hasTotp, greenhouseIds: u.greenhouseIds }}
                    isSelf={u.id === currentUserId}
                    greenhouses={greenhouses}
                  />
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
