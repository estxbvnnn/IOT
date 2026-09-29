import type { Db } from '../db/types'
import { inTransaction } from '../db/types'
import { type Actor, assertCan } from '../rbac'
import { generateToken, hashToken } from '../auth/tokens'
import { offlineAfterS } from '../alerts/engine'
import type { DeviceDTO } from '../domain/types'
import { audit } from './audit'
import { ValidationError } from './thresholds'

/** Equipos: estado de enlace para el técnico y ciclo de vida de las credenciales de cada nodo. */

const MAST_INTERVAL_S = 60

export async function listDevices(db: Db, actor: Actor, now = new Date()): Promise<DeviceDTO[]> {
  assertCan(actor, 'devices:view')
  const since24 = new Date(now.getTime() - 24 * 3600_000)
  const since6 = new Date(now.getTime() - 6 * 3600_000)
  const [nodes, counts, spark] = await Promise.all([
    db<{
      id: number; kind: 'greenhouse' | 'mast'; label: string; code: string | null; enabled: boolean; token_prefix: string
      token_rotated_at: Date; fw_version: string | null; ts: Date | null; rssi: number | null; snr: number | null
      uptime_s: number | null; faults: string[] | null; interval_s: number | null
    }[]>`
      select n.id, n.kind, n.label, g.code, n.enabled, n.token_prefix, n.token_rotated_at,
             s.fw_version, s.ts, s.rssi, s.snr, s.uptime_s, s.faults, t.interval_s
        from iot.nodes n
        left join iot.greenhouses g on g.id = n.greenhouse_id
        left join iot.node_state s on s.node_id = n.id
        left join iot.thresholds t on t.greenhouse_id = n.greenhouse_id
       order by (n.kind = 'mast'), g.id`,
    db<{ node_id: number; n: number }[]>`
      select node_id, count(*)::int as n from iot.readings where ts > ${since24} group by node_id`,
    db<{ node_id: number; b: Date; v: number | null }[]>`
      select node_id, date_bin('15 minutes', ts, timestamptz '2000-01-01') as b, round(avg(rssi))::int as v
        from iot.readings where ts > ${since6} and rssi is not null group by 1, 2 order by 1, 2`,
  ])
  const countBy = new Map(counts.map((c) => [c.node_id, c.n]))
  const sparkBy = new Map<number, Map<number, number | null>>()
  for (const p of spark) {
    const m = sparkBy.get(p.node_id) ?? new Map<number, number | null>()
    m.set(p.b.getTime(), p.v)
    sparkBy.set(p.node_id, m)
  }
  const bucketMs = 15 * 60_000
  const firstBucket = Math.floor(since6.getTime() / bucketMs) * bucketMs
  return nodes.map((n) => {
    const intervalS = n.kind === 'mast' ? MAST_INTERVAL_S : (n.interval_s ?? 300)
    const ageS = n.ts ? Math.max(0, Math.round((now.getTime() - n.ts.getTime()) / 1000)) : null
    const expected24h = Math.round((24 * 3600) / intervalS)
    const frames24h = countBy.get(n.id) ?? 0
    const buckets = sparkBy.get(n.id)
    return {
      id: n.id, kind: n.kind, label: n.label, greenhouseCode: n.code, enabled: n.enabled,
      tokenPrefix: n.token_prefix, tokenRotatedAt: n.token_rotated_at.toISOString(), fw: n.fw_version,
      lastSeen: n.ts?.toISOString() ?? null, ageS, online: ageS !== null && ageS <= offlineAfterS(intervalS),
      rssi: n.rssi, snr: n.snr, uptimeS: n.uptime_s, faults: n.faults ?? [], intervalS, frames24h, expected24h,
      linkPct: n.ts ? Math.min(100, Math.round((frames24h / expected24h) * 100)) : null,
      rssiSpark: Array.from({ length: 24 }, (_, i) => buckets?.get(firstBucket + i * bucketMs) ?? null),
    }
  })
}

export interface NewNodeInput {
  kind: 'greenhouse' | 'mast'
  greenhouseId: number | null
  label: string
}

/**
 * Da de alta un nodo y devuelve su token (única vez que existe en claro).
 * Lo usa el seed con la conexión de administración; no se expone en la interfaz.
 */
export async function createNode(db: Db, input: NewNodeInput): Promise<{ id: number; token: string }> {
  const token = generateToken(32)
  return inTransaction(db, async (tx) => {
    const [row] = await tx<{ id: number }[]>`
      insert into iot.nodes (kind, greenhouse_id, label, token_hash, token_prefix)
      values (${input.kind}, ${input.greenhouseId}, ${input.label}, ${hashToken(token)}, ${token.slice(0, 6)})
      returning id`
    await tx`insert into iot.node_state (node_id) values (${row!.id})`
    return { id: row!.id, token }
  })
}

/** Rota la credencial de un nodo: el token anterior deja de funcionar de inmediato. */
export async function rotateNodeToken(db: Db, actor: Actor, nodeId: number, ip: string | null = null): Promise<{ token: string; prefix: string }> {
  assertCan(actor, 'devices:manage')
  const token = generateToken(32)
  const rows = await db<{ label: string }[]>`
    update iot.nodes set token_hash = ${hashToken(token)}, token_prefix = ${token.slice(0, 6)}, token_rotated_at = now()
     where id = ${nodeId} returning label`
  if (rows.length === 0) throw new ValidationError({}, 'Nodo no encontrado.')
  await audit(db, {
    actorId: actor.id, actorLabel: actor.email, actorRole: actor.role, action: 'device.rotate_token',
    target: `node:${nodeId}`, detail: { label: rows[0]!.label, prefix: token.slice(0, 6) }, ip,
  })
  return { token, prefix: token.slice(0, 6) }
}

export async function setNodeEnabled(db: Db, actor: Actor, nodeId: number, enabled: boolean, ip: string | null = null): Promise<void> {
  assertCan(actor, 'devices:manage')
  const rows = await db<{ label: string }[]>`update iot.nodes set enabled = ${enabled} where id = ${nodeId} returning label`
  if (rows.length === 0) throw new ValidationError({}, 'Nodo no encontrado.')
  await audit(db, {
    actorId: actor.id, actorLabel: actor.email, actorRole: actor.role, action: enabled ? 'device.enable' : 'device.disable',
    target: `node:${nodeId}`, detail: { label: rows[0]!.label }, ip,
  })
}
