import Link from 'next/link'
import { AlertTriangle, ArrowLeft, CircleDashed, Download, Power, WifiOff } from 'lucide-react'
import { AutoRefresh } from '@/components/ui/auto-refresh'
import { StatusChip } from '@/components/ui/status'
import { cn } from '@/lib/cn'
import type { GreenhouseSummary, RangeKey } from '@/lib/domain/types'
import { fmtAgo, fmtDateTime, fmtNum } from '@/lib/format'

/** Códigos de falla que informa el nodo (docs/contrato-api.md §2) con su nombre para personas. */
const FAULT_LABEL: Record<string, string> = {
  dht: 'sensor DHT22 (temperatura y humedad del aire)',
  suelo: 'sensor de suelo YL-38',
  luz: 'sensor de luz BH1750',
  viento: 'anemómetro',
  wifi: 'conexión WiFi',
  reinicio_wdt: 'reinicio por el watchdog',
  temp_rango: 'temperatura fuera de rango físico',
  hum_rango: 'humedad del aire fuera de rango físico',
  suelo_rango: 'lectura de suelo fuera de rango físico',
  luz_rango: 'lectura de luz fuera de rango físico',
  viento_rango: 'viento fuera de rango físico',
}

type BannerTone = 'warn' | 'off' | 'crit'

function Banner({ tone, icon: Icon, children }: { tone: BannerTone; icon: React.ComponentType<{ size?: number; className?: string; 'aria-hidden'?: boolean }>; children: React.ReactNode }) {
  return (
    <div
      role="status"
      className={cn(
        'flex items-start gap-2.5 rounded-xl px-3.5 py-2.5 text-[13px] leading-snug text-ink',
        tone === 'warn' ? 'bg-warn-wash' : tone === 'crit' ? 'bg-crit-wash' : 'bg-off-wash',
      )}
    >
      <Icon size={17} className={cn('mt-px shrink-0', tone === 'warn' ? 'text-warn-ink' : tone === 'crit' ? 'text-crit' : 'text-ink-3')} aria-hidden />
      <div>{children}</div>
    </div>
  )
}

interface HeaderProps {
  summary: GreenhouseSummary
  /** El usuario tiene permiso export:csv. */
  canExport: boolean
  range: RangeKey
  /** Instante de generación de la página (alimenta el «Actualizado hace…»). */
  generatedAt: string
}

/** Encabezado del invernadero: identidad, estado, última lectura y avisos sobre el nodo. */
export function GreenhouseHeader({ summary: s, canExport, range, generatedAt }: HeaderProps) {
  const faults = s.faults.map((f) => FAULT_LABEL[f] ?? f)
  return (
    <header className="flex flex-col gap-3">
      <div>
        <Link href="/" className="inline-flex items-center gap-1.5 rounded-md py-1 text-[13px] font-medium text-ink-2 hover:text-ink">
          <ArrowLeft size={15} aria-hidden /> Predio
        </Link>
      </div>

      <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <h1 className="text-[26px] font-semibold leading-tight tracking-tight text-ink">{s.name}</h1>
            <span className="rounded-md bg-off-wash px-2 py-0.5 text-[12.5px] font-bold tracking-wide text-ink">{s.code}</span>
            <StatusChip status={s.status} />
          </div>
          <p className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[13px] text-ink-3">
            {s.crop && <span className="font-medium text-ink-2">{s.crop}</span>}
            {s.areaM2 !== null && <><Dot />{fmtNum(s.areaM2, 0)} m²</>}
            <Dot />{fmtNum(s.distanceM, 0)} m de la subestación
            <Dot />
            {s.lastSeen ? (
              <span>Última lectura {fmtAgo(s.ageS)} <span className="hidden sm:inline">({fmtDateTime(s.lastSeen)})</span></span>
            ) : (
              <span>Sin lecturas todavía</span>
            )}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <AutoRefresh generatedAt={generatedAt} />
          {canExport && (
            <a href={`/api/export/${s.code}?range=${range}`} className="btn btn-sm" title="Descargar el historial del rango elegido en formato CSV">
              <Download size={15} aria-hidden /> Exportar CSV
            </a>
          )}
        </div>
      </div>

      {!s.hasNode && (
        <Banner tone="off" icon={CircleDashed}>Este invernadero no tiene un nodo asignado, por lo que no llegan datos.</Banner>
      )}
      {s.hasNode && !s.nodeEnabled && (
        <Banner tone="warn" icon={Power}>El nodo está <strong>deshabilitado</strong>: el servidor rechaza sus tramas hasta que un administrador lo habilite.</Banner>
      )}
      {s.hasNode && s.nodeEnabled && s.status === 'nodata' && (
        <Banner tone="off" icon={CircleDashed}>Aún no se reciben datos de este nodo. Cuando envíe su primera trama aparecerán aquí.</Banner>
      )}
      {s.hasNode && s.nodeEnabled && s.lastSeen !== null && !s.online && (
        <Banner tone="off" icon={WifiOff}>
          <strong>Sin conexión:</strong> el nodo no reporta {fmtAgo(s.ageS)}. Los valores de abajo son los <strong>últimos conocidos</strong>.
          El riego automático sigue funcionando con la última configuración guardada en el propio nodo.
        </Banner>
      )}
      {s.online && faults.length > 0 && (
        <Banner tone="warn" icon={AlertTriangle}>
          <strong>El nodo informa fallas:</strong> {faults.join('; ')}. Con una falla del sensor el riego automático se bloquea por seguridad.
        </Banner>
      )}
    </header>
  )
}

function Dot() {
  return <span aria-hidden className="text-ink-3/60">·</span>
}
