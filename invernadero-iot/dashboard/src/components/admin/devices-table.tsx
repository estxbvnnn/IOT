import Link from 'next/link'
import { Archive, PowerOff, Radio, TriangleAlert, Wifi, WifiOff } from 'lucide-react'
import { Chip } from '@/components/ui/status'
import { Sparkline } from '@/components/ui/sparkline'
import type { DeviceDTO } from '@/lib/domain/types'
import { fmtAgo, fmtDateTime, fmtDuration, fmtNum } from '@/lib/format'
import { DeviceActions } from './device-actions'
import { SignalBars, fmtDbm, linkQuality } from './link-quality'

const FAULT_LABEL: Record<string, string> = {
  dht: 'DHT22',
  suelo: 'Suelo YL-38',
  luz: 'BH1750',
  viento: 'Anemómetro',
  wifi: 'WiFi',
  reinicio_wdt: 'Reinicio (watchdog)',
  temp_rango: 'Temp. fuera de rango',
  hum_rango: 'Humedad fuera de rango',
  suelo_rango: 'Suelo fuera de rango',
  luz_rango: 'Luz fuera de rango',
  viento_rango: 'Viento fuera de rango',
}

const TRANSPORT_LABEL = { mqtt: 'Directo · MQTT', http: 'Directo · HTTP', espnow: 'Malla ESP-NOW' } as const

/** Cómo llegó la última trama: directa o reenviada por otro nodo, y el JSON tal cual para ver qué campos manda. */
function RouteCell({ d }: { d: DeviceDTO }) {
  if (!d.route) return <span className="text-ink-3">—</span>
  const relayed = d.route.transport === 'espnow' && d.route.via
  return (
    <div className="leading-tight">
      {relayed ? (
        <Chip tone="info" icon={Radio} title="Otro nodo con red subió esta trama en nombre del origen">
          Vía {d.route.via}{d.route.hops !== null ? ` · ${d.route.hops} ${d.route.hops === 1 ? 'salto' : 'saltos'}` : ''}
        </Chip>
      ) : (
        <Chip tone="good" icon={Wifi}>{TRANSPORT_LABEL[d.route.transport]}</Chip>
      )}
      {d.lastJson && (
        <details className="mt-1.5 text-[12px] text-ink-3">
          <summary className="cursor-pointer select-none">Último JSON</summary>
          <pre className="mt-1 max-h-48 max-w-[320px] overflow-auto whitespace-pre-wrap break-all rounded bg-[var(--grid)] p-2 font-mono text-[11px] text-ink-2">
            {JSON.stringify(d.lastJson, null, 1)}
          </pre>
        </details>
      )}
    </div>
  )
}

/** Tabla de nodos: estado de enlace y ciclo de vida de la credencial. Solo lectura salvo que `canManage`. */
export function DevicesTable({ devices, canManage }: { devices: DeviceDTO[]; canManage: boolean }) {
  return (
    <div className="overflow-x-auto">
      <table className="tbl min-w-[1300px]">
        <thead>
          <tr>
            <th scope="col">Nodo</th>
            <th scope="col">Estado</th>
            <th scope="col">Firmware</th>
            <th scope="col">Ruta</th>
            <th scope="col">Última trama</th>
            <th scope="col">Enlace (RSSI · SNR · 6 h)</th>
            <th scope="col">Tramas 24 h</th>
            <th scope="col">Encendido</th>
            <th scope="col">Fallas</th>
            <th scope="col">Credencial</th>
            {canManage && <th scope="col"><span className="sr-only">Acciones</span></th>}
          </tr>
        </thead>
        <tbody>
          {devices.map((d) => {
            const q = linkQuality(d.rssi, d.snr)
            return (
              <tr key={d.id} data-node-id={d.id}>
                <td className="whitespace-nowrap">
                  <div className="font-semibold text-ink">{d.label}</div>
                  <div className="text-[12px] text-ink-3">
                    {d.greenhouseCode && d.greenhouseArchived ? (
                      <span>{d.greenhouseCode} (dado de baja)</span>
                    ) : d.greenhouseCode ? (
                      <Link href={`/greenhouses/${d.greenhouseCode}`} className="underline decoration-line-strong underline-offset-2 hover:decoration-accent">{d.greenhouseCode}</Link>
                    ) : (
                      'Predio (viento)'
                    )}
                    {' · '}reporta cada {fmtDuration(d.intervalS)}
                  </div>
                </td>
                <td className="whitespace-nowrap">
                  {d.greenhouseArchived ? (
                    <Chip tone="off" icon={Archive}>Invernadero dado de baja</Chip>
                  ) : !d.enabled ? (
                    <Chip tone="off" icon={PowerOff}>Deshabilitado</Chip>
                  ) : d.online ? (
                    <Chip tone="good" icon={Wifi}>En línea</Chip>
                  ) : (
                    <Chip tone="off" icon={WifiOff}>Sin conexión</Chip>
                  )}
                </td>
                <td className="whitespace-nowrap font-mono text-[12.5px] text-ink-2">{d.fw ?? '—'}</td>
                <td><RouteCell d={d} /></td>
                <td className="whitespace-nowrap">
                  <div className="text-ink">{fmtAgo(d.ageS)}</div>
                  <div className="text-[12px] text-ink-3">{d.lastSeen ? fmtDateTime(d.lastSeen) : 'nunca'}</div>
                </td>
                <td>
                  <div className="flex items-center gap-3">
                    <SignalBars level={q.level} dim={!d.online} />
                    <div className="min-w-[96px] leading-tight">
                      <div className="whitespace-nowrap font-medium text-ink">{fmtDbm(d.rssi)}</div>
                      <div className="whitespace-nowrap text-[12px] text-ink-3">
                        {q.label}{d.snr !== null ? ` · SNR ${fmtNum(d.snr, 1)} dB` : ''}
                      </div>
                    </div>
                    <Sparkline values={d.rssiSpark} domain={[-100, -40]} color="var(--s7)" width={84} height={26} label={`RSSI de ${d.label} en las últimas 6 horas`} />
                  </div>
                </td>
                <td className="whitespace-nowrap">
                  <div className="text-ink">
                    {d.frames24h} / {d.expected24h}
                    {d.linkPct !== null && <span className="ml-1.5 text-ink-2">({d.linkPct} %)</span>}
                  </div>
                  <div className="mt-1 h-[4px] w-[96px] overflow-hidden rounded-full" style={{ background: 'var(--grid)' }} role="img" aria-label={`${d.linkPct ?? 0} % de las tramas esperadas`}>
                    <div className="h-full rounded-full" style={{ width: `${d.linkPct ?? 0}%`, background: 'var(--ink-2)' }} />
                  </div>
                </td>
                <td className="whitespace-nowrap text-ink-2">{d.uptimeS !== null && d.online ? fmtDuration(d.uptimeS) : '—'}</td>
                <td>
                  {d.faults.length === 0 ? (
                    <span className="text-ink-3">Ninguna</span>
                  ) : (
                    <div className="flex max-w-[190px] flex-wrap gap-1">
                      {d.faults.map((f) => (
                        <Chip key={f} tone="warn" icon={TriangleAlert}>{FAULT_LABEL[f] ?? f}</Chip>
                      ))}
                    </div>
                  )}
                </td>
                <td className="whitespace-nowrap">
                  <div className="font-mono text-[12.5px] text-ink">{d.tokenPrefix}…</div>
                  <div className="text-[12px] text-ink-3">rotado {fmtDateTime(d.tokenRotatedAt)}</div>
                </td>
                {canManage && (
                  <td className="text-right">
                    <DeviceActions nodeId={d.id} label={d.label} enabled={d.enabled} archived={d.greenhouseArchived} />
                  </td>
                )}
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
