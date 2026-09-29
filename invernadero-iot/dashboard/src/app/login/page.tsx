import type { Metadata } from 'next'
import { redirect } from 'next/navigation'
import { Droplets, ShieldCheck } from 'lucide-react'
import { safeNextPath } from '@/lib/auth/constants'
import { getCurrentUser } from '@/lib/dal'
import { LoginForm } from './login-form'

export const metadata: Metadata = { title: 'Ingresar' }

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  // Si ya hay una sesión válida, no se muestra el formulario.
  if (await getCurrentUser()) redirect('/')
  const { next } = await searchParams
  return (
    <main className="grid min-h-dvh place-items-center px-4 py-10">
      <div className="w-full max-w-[400px]">
        <div className="mb-6 flex items-center gap-3">
          <span className="grid h-11 w-11 place-items-center rounded-xl bg-accent-btn text-white" aria-hidden>
            <Droplets size={24} />
          </span>
          <div>
            <h1 className="text-[20px] font-semibold tracking-tight text-ink">Invernadero IoT</h1>
            <p className="text-[13px] text-ink-3">Monitoreo y riego automático · 10 invernaderos</p>
          </div>
        </div>
        <div className="card p-6">
          <h2 className="mb-1 text-[16px] font-semibold text-ink">Ingresar al panel</h2>
          <p className="mb-5 text-[13px] text-ink-3">Usa la cuenta que te entregó el administrador del sistema.</p>
          <LoginForm next={safeNextPath(next)} />
        </div>
        <p className="mt-4 flex items-start gap-2 text-[12px] leading-snug text-ink-3">
          <ShieldCheck size={15} className="mt-px shrink-0" aria-hidden />
          Cada acción queda registrada en una bitácora inmutable. Tras varios intentos fallidos la cuenta se bloquea unos minutos.
        </p>
      </div>
    </main>
  )
}
