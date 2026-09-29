import { isRole, ROLE_LABELS } from '@/lib/rbac'
import type { AuditRow } from '@/lib/services/audit'
import { fmtDateTimeSec } from '@/lib/format'
import { auditLabel, fmtTarget } from './audit-labels'

/** Detalle en una línea compacta; al abrir, el JSON completo. TODO va como texto: la bitácora incluye datos no confiables. */
function Detail({ detail }: { detail: Record<string, unknown> }) {
  const keys = Object.keys(detail)
  if (keys.length === 0) return <span className="text-ink-3">—</span>
  const compact = JSON.stringify(detail)
  return (
    <details className="group max-w-[300px]">
      <summary className="cursor-pointer list-none text-[12.5px] text-ink-2 marker:hidden [&::-webkit-details-marker]:hidden">
        <span className="block truncate font-mono text-[12px]">{compact.length > 64 ? `${compact.slice(0, 64)}…` : compact}</span>
        <span className="text-[12px] font-semibold text-accent group-open:hidden">ver</span>
        <span className="hidden text-[12px] font-semibold text-accent group-open:inline">ocultar</span>
      </summary>
      <pre className="mt-1.5 max-h-[220px] overflow-auto whitespace-pre-wrap break-words rounded-lg bg-surface-2 p-2.5 font-mono text-[11.5px] leading-snug text-ink">
        {JSON.stringify(detail, null, 2)}
      </pre>
    </details>
  )
}

export function AuditTable({ rows }: { rows: AuditRow[] }) {
  return (
    <div className="overflow-x-auto">
      <table className="tbl min-w-[980px]">
        <thead>
          <tr>
            <th scope="col">Fecha y hora</th>
            <th scope="col">Actor</th>
            <th scope="col">Acción</th>
            <th scope="col">Objetivo</th>
            <th scope="col">Detalle</th>
            <th scope="col">IP</th>
            <th scope="col" title="SHA-256 de la fila, encadenado con el de la anterior (primeros 16 caracteres)">Hash</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} data-audit-id={r.id}>
              <td className="whitespace-nowrap">
                <div className="text-ink">{fmtDateTimeSec(r.ts)}</div>
                <div className="text-[12px] text-ink-3">#{r.id}</div>
              </td>
              <td className="max-w-[220px]">
                <div className="break-all text-ink">{r.actorLabel}</div>
                {r.actorRole && <div className="text-[12px] text-ink-3">{isRole(r.actorRole) ? ROLE_LABELS[r.actorRole] : r.actorRole}</div>}
              </td>
              <td>
                <div className="font-medium text-ink">{auditLabel(r.action)}</div>
                <div className="font-mono text-[11.5px] text-ink-3">{r.action}</div>
              </td>
              <td className="whitespace-nowrap text-ink-2">{fmtTarget(r.target)}</td>
              <td><Detail detail={r.detail} /></td>
              <td className="whitespace-nowrap font-mono text-[12px] text-ink-2">{r.ip ?? '—'}</td>
              <td className="whitespace-nowrap font-mono text-[11.5px] text-ink-3">{r.hash}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
