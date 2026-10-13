/**
 * Núcleo de la sincronización Raspberry Pi → Supabase (un solo sentido: la Pi es la dueña de los datos).
 *
 *   PostgreSQL local (Pi)  ──cada SYNC_INTERVAL_S──►  Supabase (copia en la nube)
 *
 * Cómo se copia (todo con el rol «iot_app» de cada lado, el mismo de la aplicación):
 *  - «append»  (readings, audit_log): filas que solo se agregan. Se copia desde el último id enviado (cursor en iot.sync_state)
 *              en lotes; `ON CONFLICT DO NOTHING` hace que repetir un lote sea inofensivo.
 *  - «full»    (tablas pequeñas de configuración y estado): se hace UPSERT de todas las filas en cada ciclo; en las tablas donde
 *              el usuario puede borrar (schedules, user_greenhouses) también se borra en Supabase lo que ya no existe en la Pi.
 *  - «recent»  (commands, irrigation_events, alerts): filas que cambian durante un tiempo y luego quedan finales. Se hace UPSERT de
 *              lo ocurrido desde el último ciclo exitoso (con 1 día de holgura), así tras un corte largo de internet se ponen al día.
 * Las filas viajan como JSON (`jsonb_populate_recordset`): no hay que enumerar columnas ni convertir tipos.
 * Si no hay internet o Supabase falla, el ciclo termina con error y se reintenta en el siguiente; la Pi no se ve afectada.
 */
import type { Db } from '../../src/lib/db/types'

type Mode = 'append' | 'full' | 'recent'

export interface TableSpec {
  table: string
  pk: readonly string[]
  mode: Mode
  /** Tiene columnas «generated always as identity» (se insertan con OVERRIDING SYSTEM VALUE para conservar los ids). */
  identity?: boolean
  /** Solo «recent»: condición SQL sobre la fila `t` y el parámetro $1 (desde cuándo). */
  recent?: string
  /** Solo «full»: borrar en el destino las filas que ya no existen en el origen. */
  prune?: boolean
}

/** En orden de dependencias (primero los «padres» de las claves foráneas). */
export const SPECS: readonly TableSpec[] = [
  { table: 'site_settings', pk: ['id'], mode: 'full' },
  { table: 'app_users', pk: ['id'], mode: 'full' },
  { table: 'greenhouses', pk: ['id'], mode: 'full' },
  { table: 'nodes', pk: ['id'], mode: 'full', identity: true },
  { table: 'node_state', pk: ['node_id'], mode: 'full' },
  { table: 'thresholds', pk: ['greenhouse_id'], mode: 'full' },
  { table: 'user_greenhouses', pk: ['user_id', 'greenhouse_id'], mode: 'full', prune: true },
  { table: 'schedules', pk: ['id'], mode: 'full', prune: true },
  { table: 'commands', pk: ['id'], mode: 'recent', recent: 'greatest(t.created_at, t.confirmed_at, t.delivered_at, t.acked_at) >= $1' },
  {
    table: 'irrigation_events', pk: ['id'], mode: 'recent', identity: true,
    recent: 't.ended_at is null or greatest(t.started_at, t.ended_at) >= $1',
  },
  {
    table: 'alerts', pk: ['id'], mode: 'recent', identity: true,
    recent: "t.status <> 'resolved' or greatest(t.opened_at, t.last_seen_at, t.acknowledged_at, t.resolved_at) >= $1",
  },
  { table: 'readings', pk: ['id'], mode: 'append', identity: true },
  { table: 'audit_log', pk: ['id'], mode: 'append', identity: true },
]

export interface SyncOptions {
  log?: (msg: string) => void
  /** Filas por lote (por defecto 1000). */
  batch?: number
  now?: () => Date
  /** Simulacro: cuenta lo que enviaría SIN escribir nada (ni en Supabase ni en los cursores). Solo lee del destino el esquema. */
  dryRun?: boolean
}

export interface TableReport {
  sent: number
  /** Filas que Supabase rechazó (restricciones); se registran y no detienen el ciclo. */
  rejected: number
  skipped?: string
}

export interface SyncReport {
  ok: boolean
  error?: string
  tables: Record<string, TableReport>
  ms: number
}

const RUN = '_run'
const EPOCH = new Date(0)

async function columnsOf(db: Db, table: string): Promise<string[]> {
  const rows = await db<{ column_name: string }[]>`
    select column_name from information_schema.columns where table_schema = 'iot' and table_name = ${table} order by ordinal_position`
  return rows.map((r) => r.column_name)
}

/** Filas del origen como JSON (un arreglo) más su cantidad. `sql` es una consulta fija de este archivo, nunca datos del usuario. */
async function readJson(local: Db, sql: string, params: unknown[]): Promise<{ n: number; json: string }> {
  const [r] = await local.unsafe<{ n: number; j: string }[]>(
    `select count(*)::int as n, coalesce(jsonb_agg(t), '[]'::jsonb)::text as j from (${sql}) t`, params as never[])
  return { n: r!.n, json: r!.j }
}

function pushSql(s: TableSpec, cols: string[], conflict: 'nothing' | 'update'): string {
  const over = s.identity ? ' overriding system value' : ''
  const onConflict = conflict === 'nothing' || cols.every((c) => s.pk.includes(c))
    ? 'do nothing'
    : `do update set ${cols.filter((c) => !s.pk.includes(c)).map((c) => `"${c}" = excluded."${c}"`).join(', ')}`
  return `insert into iot.${s.table}${over} select * from jsonb_populate_recordset(null::iot.${s.table}, $1::text::jsonb)
          on conflict (${s.pk.map((c) => `"${c}"`).join(', ')}) ${onConflict}`
}

/**
 * Envía un lote. Si el lote completo falla por una restricción (p. ej. dos alertas activas del mismo tipo), se reintenta fila por
 * fila para aislar la mala: las demás pasan y la rechazada se cuenta. Los errores de conexión SÍ se propagan (se aborta el ciclo).
 */
async function push(remote: Db, s: TableSpec, cols: string[], json: string, conflict: 'nothing' | 'update', log: (m: string) => void): Promise<{ sent: number; rejected: number }> {
  const sql = pushSql(s, cols, conflict)
  const rows = JSON.parse(json) as unknown[]
  try {
    await remote.unsafe(sql, [json])
    return { sent: rows.length, rejected: 0 }
  } catch (e) {
    if (!isConstraintError(e)) throw e
  }
  let sent = 0
  let rejected = 0
  for (const row of rows) {
    try {
      await remote.unsafe(sql, [JSON.stringify([row])])
      sent++
    } catch (e) {
      if (!isConstraintError(e)) throw e
      rejected++
      log(`SYNC ${s.table}: fila rechazada por Supabase (${(e as Error).message})`)
    }
  }
  return { sent, rejected }
}

/** Errores de datos (clase 22/23 de PostgreSQL: valores inválidos, claves, unicidad, CHECK) frente a errores de conexión o permisos. */
function isConstraintError(e: unknown): boolean {
  const code = (e as { code?: string }).code
  return typeof code === 'string' && (code.startsWith('23') || code.startsWith('22'))
}

async function getCursor(local: Db, name: string): Promise<number> {
  const [r] = await local<{ last_id: number }[]>`select last_id from iot.sync_state where name = ${name}`
  return r?.last_id ?? 0
}

async function setCursor(local: Db, name: string, lastId: number): Promise<void> {
  await local`
    insert into iot.sync_state (name, last_id) values (${name}, ${lastId})
    on conflict (name) do update set last_id = excluded.last_id`
}

async function pruneRemote(local: Db, remote: Db, s: TableSpec): Promise<number> {
  const key = (r: Record<string, unknown>) => s.pk.map((c) => String(r[c])).join('|')
  const list = s.pk.map((c) => `"${c}"::text as "${c}"`).join(', ')
  const here = new Set((await local.unsafe<Record<string, unknown>[]>(`select ${list} from iot.${s.table}`)).map(key))
  const there = await remote.unsafe<Record<string, unknown>[]>(`select ${list} from iot.${s.table}`)
  let deleted = 0
  for (const r of there) {
    if (here.has(key(r))) continue
    const where = s.pk.map((c, i) => `"${c}"::text = $${i + 1}`).join(' and ')
    await remote.unsafe(`delete from iot.${s.table} where ${where}`, s.pk.map((c) => String(r[c])) as never[])
    deleted++
  }
  return deleted
}

export async function syncOnce(local: Db, remote: Db, opts: SyncOptions = {}): Promise<SyncReport> {
  const log = opts.log ?? (() => undefined)
  const batch = opts.batch ?? 1000
  const now = (opts.now ?? (() => new Date()))()
  const t0 = Date.now()
  const tables: Record<string, TableReport> = {}

  const [prev] = await local<{ last_ok_at: Date | null }[]>`select last_ok_at from iot.sync_state where name = ${RUN}`
  const since = new Date((prev?.last_ok_at ?? EPOCH).getTime() - 86_400_000)

  try {
    for (const s of SPECS) {
      const rep: TableReport = { sent: 0, rejected: 0 }
      tables[s.table] = rep

      const [lc, rc] = [await columnsOf(local, s.table), await columnsOf(remote, s.table)]
      if (lc.join() !== rc.join()) {
        rep.skipped = 'el esquema de Supabase no coincide con el de la Pi (¿faltan migraciones?)'
        log(`SYNC ${s.table}: omitida, ${rep.skipped}`)
        continue
      }

      if (s.mode === 'append') {
        let cursor = await getCursor(local, s.table)
        if (opts.dryRun) {
          rep.sent = (await local.unsafe<{ n: number }[]>(`select count(*)::int as n from iot.${s.table} where id > $1`, [cursor]))[0]!.n
          continue
        }
        for (;;) {
          const { n, json } = await readJson(local, `select * from iot.${s.table} where id > $1 order by id limit ${batch}`, [cursor])
          if (n === 0) break
          const r = await push(remote, s, lc, json, 'nothing', log)
          rep.sent += r.sent
          rep.rejected += r.rejected
          cursor = (JSON.parse(json) as { id: number }[]).at(-1)!.id
          await setCursor(local, s.table, cursor)
          if (n < batch) break
        }
        continue
      }

      const where = s.mode === 'recent' ? `where ${s.recent}` : ''
      const params = s.mode === 'recent' ? [since] : []
      if (opts.dryRun) {
        rep.sent = (await local.unsafe<{ n: number }[]>(`select count(*)::int as n from iot.${s.table} t ${where}`, params as never[]))[0]!.n
        continue
      }
      const { n, json } = await readJson(local, `select * from iot.${s.table} t ${where}`, params)
      for (let i = 0; i < n; i += batch) {
        const part = n <= batch ? json : JSON.stringify((JSON.parse(json) as unknown[]).slice(i, i + batch))
        const r = await push(remote, s, lc, part, 'update', log)
        rep.sent += r.sent
        rep.rejected += r.rejected
      }
      if (s.prune) await pruneRemote(local, remote, s)
    }
  } catch (e) {
    const msg = (e as Error).message
    if (opts.dryRun) return { ok: false, error: msg, tables, ms: Date.now() - t0 }
    await local`
      insert into iot.sync_state (name, last_run_at, last_error) values (${RUN}, ${now}, ${msg})
      on conflict (name) do update set last_run_at = excluded.last_run_at, last_error = excluded.last_error`.catch(() => undefined)
    return { ok: false, error: msg, tables, ms: Date.now() - t0 }
  }

  if (opts.dryRun) return { ok: true, tables, ms: Date.now() - t0 }
  await local`
    insert into iot.sync_state (name, last_run_at, last_ok_at, last_error) values (${RUN}, ${now}, ${now}, null)
    on conflict (name) do update set last_run_at = excluded.last_run_at, last_ok_at = excluded.last_ok_at, last_error = null`
  return { ok: true, tables, ms: Date.now() - t0 }
}

/** Resumen de una línea para el registro: «readings 120, alerts 2, …» (solo las tablas con movimiento). */
export function summarize(r: SyncReport): string {
  const parts = Object.entries(r.tables)
    .filter(([, t]) => t.sent > 0 || t.rejected > 0 || t.skipped)
    .map(([k, t]) => `${k} ${t.sent}${t.rejected ? ` (${t.rejected} rechazadas)` : ''}${t.skipped ? ' (omitida)' : ''}`)
  return parts.length ? parts.join(', ') : 'sin cambios'
}
