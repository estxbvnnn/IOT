import type { Metadata } from 'next'
import { Info } from 'lucide-react'
import { DevicesTable } from '@/components/admin/devices-table'
import { PageHeader } from '@/components/admin/page-header'
import { AutoRefresh } from '@/components/ui/auto-refresh'
import { Card } from '@/components/ui/card'
import { Chip } from '@/components/ui/status'
import { getDb } from '@/lib/db'
import { requirePermission } from '@/lib/dal'
import { can } from '@/lib/rbac'
import { listDevices } from '@/lib/services/devices'

export const metadata: Metadata = { title: 'Equipos' }

/** Estado de los nodos y la calidad de su enlace (técnico de mantenimiento y administrador). */
export default async function DevicesPage() {
  const user = await requirePermission('devices:view')
  const now = new Date()
  const devices = await listDevices(getDb(), user, now)
  const canManage = can(user.role, 'devices:manage')
  const online = devices.filter((d) => d.enabled && d.online).length

  return (
    <>
      <PageHeader
        title="Equipos"
        subtitle="Estado de cada nodo, calidad de su enlace y ciclo de vida de sus credenciales."
        actions={<AutoRefresh generatedAt={now.toISOString()} />}
      />

      <div className="mb-4 flex flex-wrap items-center gap-x-4 gap-y-2 text-[13px] text-ink-2">
        <span>
          <strong className="text-[15px] font-semibold text-ink">{online} de {devices.length}</strong> nodos en línea
        </span>
        {!canManage && <Chip tone="off" icon={Info}>Solo lectura</Chip>}
      </div>

      <Card flush title="Nodos del predio" description="Diez nodos ESP32 (uno por invernadero) y el nodo del mástil con el anemómetro.">
        <DevicesTable devices={devices} canManage={canManage} />
      </Card>

      <aside className="card mt-4 flex items-start gap-3 px-[18px] py-4 text-[13px] leading-relaxed text-ink-2" aria-label="Cómo leer esta tabla">
        <Info size={17} className="mt-0.5 shrink-0 text-ink-3" aria-hidden />
        <div className="flex flex-col gap-1.5">
          <p>
            <strong className="text-ink">RSSI</strong> es la potencia de la señal que recibe el nodo, en dBm: mientras más cerca de 0, mejor
            (−60 excelente · −70 buena · −80 regular · −90 débil). <strong className="text-ink">SNR</strong> solo existe en enlaces LoRa y compara la señal
            con el ruido de fondo, en dB: sobre 7 es excelente y bajo −7 es débil.
          </p>
          <p>
            Un nodo aparece <strong className="text-ink">Sin conexión</strong> si no reporta durante máx(90 s, 3 intervalos de reporte): con reporte cada 5 min, a los 15 min.
            «Tramas 24 h» compara las recibidas con las esperadas; un porcentaje bajo con el nodo en línea indica un enlace inestable.
          </p>
          <p>
            La credencial de cada nodo es un token único: el servidor solo guarda su huella (SHA-256), por eso al rotarlo se muestra una única vez.
          </p>
        </div>
      </aside>
    </>
  )
}
