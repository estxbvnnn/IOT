/**
 * Arranque inicial: copia TODO lo que hay en Supabase (usuarios, invernaderos, nodos con el hash de su token, historial…) a la
 * base local de la Pi. Se hace una sola vez, antes de activar el servicio «sync». Así los nodos ya programados (con su token) y los
 * usuarios (con su clave) siguen funcionando sin cambios.
 *
 * Se escribe en la base local con `session_replication_role = replica` (desactiva los triggers): los hashes encadenados de la bitácora
 * y las demás columnas se copian exactamente como están. Por eso necesita el rol administrador de la base LOCAL.
 */
import type { Db } from '../../src/lib/db/types'

/** Tablas a traer, en orden de dependencias. No se traen las sesiones (cada instancia tiene las suyas). */
export const BOOTSTRAP_TABLES = [
  'site_settings', 'app_users', 'greenhouses', 'nodes', 'node_state', 'thresholds', 'user_greenhouses', 'schedules',
  'commands', 'irrigation_events', 'alerts', 'readings', 'readings_hourly', 'audit_log',
] as const

/** Tablas con cursor por id: tras copiarlas, el servicio «sync» no debe reenviar lo que ya está en Supabase. */
const CURSORS = ['readings', 'audit_log'] as const

interface PageRow { n: number; j: string; last: Record<string, unknown> | null }

export interface BootstrapReport {
  copied: Record<string, number>
}

export interface BootstrapOptions {
  batch?: number
  log?: (msg: string) => void
  /** Borra antes todo lo que haya en la base local (si no, se niega a trabajar sobre una base con datos). */
  force?: boolean
}

export async function bootstrapFromRemote(remote: Db, localAdmin: Db, opts: BootstrapOptions = {}): Promise<BootstrapReport> {
  const batch = opts.batch ?? 2000
  const log = opts.log ?? (() => undefined)

  const existing = (await localAdmin<{ n: number }[]>`select count(*)::int as n from iot.greenhouses`)[0]!.n
  const n = existing
  if (n > 0 && !opts.force) {
    throw new Error(`La base local ya tiene ${n} invernadero(s). Para reemplazar todo con lo de Supabase use --force.`)
  }

  const copied: Record<string, number> = {}
  await localAdmin.begin(async (tx) => {
    await tx`set local session_replication_role = replica`
    if (n > 0) {
      const list = [...BOOTSTRAP_TABLES, 'sessions', 'api_keys', 'sync_state'].map((t) => `iot.${t}`).join(', ')
      await tx.unsafe(`truncate ${list} restart identity cascade`)
    }
    for (const t of BOOTSTRAP_TABLES) {
      const identity = (await tx<{ n: number }[]>`
        select count(*)::int as n from information_schema.columns
         where table_schema = 'iot' and table_name = ${t} and is_identity = 'YES'`)[0]!.n > 0
      const pk = (await tx<{ a: string }[]>`
        select a.attname as a from pg_index i join pg_attribute a on a.attrelid = i.indrelid and a.attnum = any(i.indkey)
         where i.indrelid = ${`iot.${t}`}::regclass and i.indisprimary order by array_position(i.indkey::int2[], a.attnum)`).map((r) => r.a)
      const order = pk.map((c) => `"${c}"`).join(', ')
      let total = 0
      let after: unknown[] | null = null as unknown[] | null
      for (;;) {
        // Paginación por clave primaria (keyset): estable aunque Supabase reciba datos mientras tanto.
        const cond: string = after ? `where (${order}) > (${pk.map((_, i) => `$${i + 1}`).join(', ')})` : ''
        const page: PageRow[] = await remote.unsafe<PageRow[]>(
          `select count(*)::int as n, coalesce(jsonb_agg(t order by ${order}), '[]'::jsonb)::text as j,
                  (jsonb_agg(to_jsonb(t) order by ${order}) -> -1) as last
             from (select * from iot.${t} ${cond} order by ${order} limit ${batch}) t`, (after ?? []) as never[])
        const r: PageRow | undefined = page[0]
        if (!r || r.n === 0) break
        await tx.unsafe(
          `insert into iot.${t}${identity ? ' overriding system value' : ''} select * from jsonb_populate_recordset(null::iot.${t}, $1::text::jsonb)`, [r.j])
        total += r.n
        after = pk.map((c) => (r.last as Record<string, unknown>)[c])
        if (r.n < batch) break
      }
      copied[t] = total
      log(`BOOTSTRAP ${t}: ${total} filas`)

      if (identity) {
        // La siguiente fila nueva debe seguir después de la última copiada.
        await tx.unsafe(
          `select setval(pg_get_serial_sequence('iot.${t}', '${pk[0]}'), greatest(coalesce((select max("${pk[0]}") from iot.${t}), 0), 1),
                  (select count(*) > 0 from iot.${t}))`)
      }
    }
    for (const t of CURSORS) {
      await tx.unsafe(
        `insert into iot.sync_state (name, last_id) values ('${t}', coalesce((select max(id) from iot.${t}), 0))
         on conflict (name) do update set last_id = excluded.last_id`)
    }
    await tx`
      insert into iot.sync_state (name, last_run_at, last_ok_at) values ('_run', now(), now())
      on conflict (name) do update set last_run_at = excluded.last_run_at, last_ok_at = excluded.last_ok_at`
  })
  return { copied }
}
