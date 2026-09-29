import Link from 'next/link'
import { SearchX } from 'lucide-react'

/** Invernadero inexistente o de un sector al que la cuenta no tiene acceso: mismo mensaje en ambos casos. */
export default function GreenhouseNotFound() {
  return (
    <div className="mx-auto flex max-w-md flex-col items-center gap-2 py-20 text-center">
      <SearchX size={36} className="text-ink-3" aria-hidden />
      <h1 className="text-[20px] font-semibold text-ink">Invernadero no disponible</h1>
      <p className="text-[13.5px] text-ink-3">No existe o tu cuenta no tiene acceso a este sector.</p>
      <Link href="/" className="btn btn-primary mt-4">Volver al predio</Link>
    </div>
  )
}
