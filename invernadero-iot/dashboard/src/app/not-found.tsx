import Link from 'next/link'
import { SearchX } from 'lucide-react'

/** 404: sirve tanto para páginas que no existen como para las que el usuario no tiene permiso de ver. */
export default function NotFound() {
  return (
    <main className="grid min-h-dvh place-items-center px-4">
      <div className="max-w-sm text-center">
        <SearchX size={36} className="mx-auto text-ink-3" aria-hidden />
        <h1 className="mt-3 text-[20px] font-semibold text-ink">Página no disponible</h1>
        <p className="mt-1.5 text-[13.5px] text-ink-3">No existe o tu cuenta no tiene permiso para verla.</p>
        <Link href="/" className="btn btn-primary mt-5">Volver al inicio</Link>
      </div>
    </main>
  )
}
