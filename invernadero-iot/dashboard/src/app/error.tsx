'use client'

import { TriangleAlert } from 'lucide-react'

/** Error inesperado: no se muestran detalles internos, solo un código de referencia. */
export default function ErrorPage({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <main className="grid min-h-dvh place-items-center px-4">
      <div className="max-w-sm text-center">
        <TriangleAlert size={36} className="mx-auto text-warn-ink" aria-hidden />
        <h1 className="mt-3 text-[20px] font-semibold text-ink">Algo salió mal</h1>
        <p className="mt-1.5 text-[13.5px] text-ink-3">No pudimos cargar esta página. Puede ser un problema pasajero de conexión con la base de datos.</p>
        {error.digest && <p className="mt-2 text-[12px] text-ink-3">Referencia: <code>{error.digest}</code></p>}
        <button type="button" onClick={reset} className="btn btn-primary mt-5">Reintentar</button>
      </div>
    </main>
  )
}
