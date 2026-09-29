import type { Metadata } from 'next'
import Link from 'next/link'
import { ArrowRight, CheckCircle2, KeyRound, ShieldAlert } from 'lucide-react'
import { listGreenhouseOptions } from '@/components/admin/greenhouse-options'
import { PageHeader } from '@/components/admin/page-header'
import { PasswordForm } from '@/components/admin/password-form'
import { TotpCard } from '@/components/admin/totp-card'
import { Card } from '@/components/ui/card'
import { SESSION_IDLE_S } from '@/lib/auth/service'
import { getDb } from '@/lib/db'
import { requireUser } from '@/lib/dal'
import { fmtDuration } from '@/lib/format'
import { ROLE_LABELS } from '@/lib/rbac'

export const metadata: Metadata = { title: 'Mi cuenta' }

type SearchParams = Promise<Record<string, string | string[] | undefined>>
const one = (v: string | string[] | undefined): string => (Array.isArray(v) ? (v[0] ?? '') : (v ?? ''))

function Banner({ tone, icon: Icon, title, children }: { tone: 'crit' | 'good'; icon: React.ComponentType<{ size?: number; className?: string; 'aria-hidden'?: boolean }>; title: string; children?: React.ReactNode }) {
  return (
    <div role={tone === 'crit' ? 'alert' : 'status'} className={`mb-4 flex items-start gap-3 rounded-xl border px-4 py-3 ${tone === 'crit' ? 'border-crit bg-crit-wash' : 'border-good bg-good-wash'}`}>
      <Icon size={20} className={`mt-0.5 shrink-0 ${tone === 'crit' ? 'text-crit' : 'text-good'}`} aria-hidden />
      <div className="text-[13.5px] leading-snug text-ink">
        <p className="font-semibold">{title}</p>
        {children && <p className="mt-0.5 text-ink-2">{children}</p>}
      </div>
    </div>
  )
}

/**
 * Cuenta propia. Es la ÚNICA página accesible cuando la política exige antes registrar el segundo factor o
 * cambiar la contraseña inicial (requireUser con allowRestricted): el resto del panel redirige aquí.
 */
export default async function AccountPage({ searchParams }: { searchParams: SearchParams }) {
  const user = await requireUser({ allowRestricted: true })
  const sp = await searchParams
  const motivo = one(sp.motivo)
  const sectors = user.role === 'operator' ? await listGreenhouseOptions(getDb(), user) : []

  const restricted = user.mustEnrollMfa || user.mustChangePassword
  const cameForPolicy = motivo === 'mfa' || motivo === 'clave'

  return (
    <>
      <PageHeader
        title="Mi cuenta"
        subtitle="Tus datos, tu contraseña y el segundo factor de verificación."
        actions={
          restricted ? null : (
            <Link href="/" className="btn">Ir al panel <ArrowRight size={15} aria-hidden /></Link>
          )
        }
      />

      {user.mustEnrollMfa && (
        <Banner tone="crit" icon={ShieldAlert} title="Tu rol exige segundo factor: actívalo para continuar.">
          Mientras no lo actives, el resto del panel permanece bloqueado. Configúralo en la tarjeta «Segundo factor» de más abajo.
        </Banner>
      )}
      {user.mustChangePassword && (
        <Banner tone="crit" icon={KeyRound} title="Debes cambiar tu contraseña inicial.">
          La contraseña que te entregó el administrador es temporal. Cámbiala en la tarjeta «Contraseña» para poder usar el panel.
        </Banner>
      )}
      {!restricted && cameForPolicy && (
        <Banner tone="good" icon={CheckCircle2} title="Listo: cumpliste el requisito de seguridad.">
          Ya puedes usar el panel con normalidad.
        </Banner>
      )}

      <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.25fr)]">
        <Card title="Tus datos" id="cuenta-datos">
          <dl className="grid grid-cols-[110px_1fr] gap-x-4 gap-y-2.5 text-[13.5px]">
            <dt className="text-ink-3">Nombre</dt>
            <dd className="font-medium text-ink">{user.name}</dd>
            <dt className="text-ink-3">Correo</dt>
            <dd className="break-all text-ink">{user.email}</dd>
            <dt className="text-ink-3">Rol</dt>
            <dd className="text-ink">{ROLE_LABELS[user.role]}</dd>
            <dt className="text-ink-3">Sectores</dt>
            <dd className="text-ink">
              {user.role === 'operator' ? (
                sectors.length > 0 ? (
                  <span className="flex flex-wrap gap-1">
                    {sectors.map((s) => (
                      <span key={s.id} className="rounded-md border border-line-strong px-1.5 py-px text-[12px] font-semibold text-ink-2" title={s.name}>{s.code}</span>
                    ))}
                  </span>
                ) : (
                  'Ninguno asignado'
                )
              ) : (
                'Todos los invernaderos'
              )}
            </dd>
            <dt className="text-ink-3">Sesión</dt>
            <dd className="text-ink-2">Se cierra tras {fmtDuration(SESSION_IDLE_S[user.role])} sin actividad y, en todo caso, a las 12 h.</dd>
          </dl>
        </Card>

        <div className="flex flex-col gap-4">
          <Card title="Contraseña" id="cuenta-clave" description="Cambiarla cierra tus otras sesiones abiertas (esta se conserva).">
            <PasswordForm />
          </Card>
          <Card title="Segundo factor (TOTP)" id="cuenta-mfa" description="Un código de 6 dígitos que cambia cada 30 segundos, generado por una app en tu teléfono.">
            <TotpCard hasTotp={user.hasTotp} mfaRequired={user.mfaRequired} />
          </Card>
        </div>
      </div>
    </>
  )
}
