import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { connect } from '../../src/lib/db/config'
import type { Db } from '../../src/lib/db/types'
import { syncOnce } from '../../scripts/lib/sync-core'
import { bootstrapFromRemote } from '../../scripts/lib/bootstrap-core'
import { app } from './helpers'

/**
 * Sincronización Pi → Supabase, probada con DOS bases de un mismo servidor PostgreSQL: la de siempre («local» = la Pi) y una
 * temporal que hace de «Supabase» (con las migraciones 0001–0006, que es lo que tiene Supabase). Necesita el administrador del
 * servidor (DATABASE_ADMIN_USER/PASSWORD) para crear y borrar la base temporal, y solo corre contra un servidor LOCAL:
 *   docker compose up -d postgres   y   DATABASE_HOST=127.0.0.1 DATABASE_PORT=55432 …
 */
const H = process.env.DATABASE_HOST ?? ''
const ADMIN = process.env.DATABASE_ADMIN_USER
const enabled = ['127.0.0.1', 'localhost', 'postgres'].includes(H) && !!ADMIN && !!process.env.DATABASE_ADMIN_PASSWORD

const MIGRATIONS = path.resolve(process.cwd(), '..', 'supabase', 'migrations')
const REMOTE_DB = `iot_sync_remote_${crypto.randomBytes(4).toString('hex')}`
const SEQ_MARK = 987_000_000                        // seq de las lecturas de prueba (para poder borrarlas al final)

const base = () => ({ host: H, port: Number(process.env.DATABASE_PORT ?? 5432) })
const adminOn = (database: string): Db =>
  connect({ ...base(), database, user: ADMIN!, password: process.env.DATABASE_ADMIN_PASSWORD! }, { sslMode: 'disable', max: 2 })

describe.skipIf(!enabled)('sincronización Pi → Supabase', () => {
  let admin: Db            // administrador de la base principal («local»)
  let adminRemote: Db      // administrador de la base temporal
  let remote: Db           // rol iot_app sobre la base temporal (igual que en Supabase)
  const count = async (db: Db, table: string, where = 'true'): Promise<number> =>
    (await db.unsafe<{ n: number }[]>(`select count(*)::int as n from iot.${table} where ${where}`))[0]!.n

  beforeAll(async () => {
    const root = adminOn('postgres')
    await root.unsafe(`create database ${REMOTE_DB}`)
    await root.end()
    adminRemote = adminOn(REMOTE_DB)
    await adminRemote.unsafe('create schema if not exists extensions')
    const files = fs.readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql') && f < '0007').sort()   // lo que tiene Supabase
    for (const f of files) await adminRemote.unsafe(fs.readFileSync(path.join(MIGRATIONS, f), 'utf8'))
    remote = connect({ ...base(), database: REMOTE_DB, user: process.env.DATABASE_USER!, password: process.env.DATABASE_PASSWORD! }, { sslMode: 'disable', max: 2 })
    admin = adminOn(process.env.DATABASE_NAME ?? 'postgres')
    // Estado de sincronización limpio: la base temporal es nueva, así que los cursores de ejecuciones anteriores ya no valen.
    await app`update iot.sync_state set last_id = 0, last_ok_at = null, last_error = null`
  })

  afterAll(async () => {
    await admin?.unsafe(`delete from iot.readings where seq >= ${SEQ_MARK}`).catch(() => undefined)
    await admin?.unsafe(`delete from iot.alerts where type like 'sync_test_%'`).catch(() => undefined)
    await admin?.unsafe(`delete from iot.schedules where label = 'sync_test'`).catch(() => undefined)
    await admin?.unsafe(`update iot.sync_state set last_id = 0, last_ok_at = null`).catch(() => undefined)
    await remote?.end({ timeout: 3 }).catch(() => undefined)
    await adminRemote?.end({ timeout: 3 }).catch(() => undefined)
    await admin?.end({ timeout: 3 }).catch(() => undefined)
    const root = adminOn('postgres')
    await root.unsafe(`drop database if exists ${REMOTE_DB} with (force)`).catch(() => undefined)
    await root.end({ timeout: 3 })
  })

  it('la primera copia deja en Supabase las mismas tablas de configuración y todas las lecturas', async () => {
    const r = await syncOnce(app, remote)
    expect(r.ok, JSON.stringify(r)).toBe(true)
    for (const t of ['site_settings', 'app_users', 'greenhouses', 'nodes', 'node_state', 'thresholds', 'user_greenhouses', 'schedules', 'commands', 'irrigation_events', 'alerts', 'readings', 'audit_log']) {
      expect(await count(remote, t), t).toBe(await count(app, t))
      expect(r.tables[t]!.skipped, t).toBeUndefined()
    }
    // Lo que importa para que los nodos sigan funcionando: el hash de su token y los ids se conservan exactos.
    const a = await app<{ id: number; token_hash: Buffer }[]>`select id, token_hash from iot.nodes order by id`
    const b = await remote<{ id: number; token_hash: Buffer }[]>`select id, token_hash from iot.nodes order by id`
    expect(b.map((x) => [x.id, x.token_hash.toString('hex')])).toEqual(a.map((x) => [x.id, x.token_hash.toString('hex')]))
  })

  it('la cadena de hashes de la bitácora queda íntegra en ambos lados', async () => {
    const [l] = await app<{ first_broken_id: number | null }[]>`select * from iot.verify_audit_chain()`
    const [r] = await remote<{ first_broken_id: number | null }[]>`select * from iot.verify_audit_chain()`
    expect(l!.first_broken_id).toBeNull()
    expect(r!.first_broken_id).toBeNull()
    const la = await app<{ hash: Buffer }[]>`select hash from iot.audit_log order by id desc limit 1`
    const ra = await remote<{ hash: Buffer }[]>`select hash from iot.audit_log order by id desc limit 1`
    if (la[0]) expect(ra[0]!.hash.toString('hex')).toBe(la[0].hash.toString('hex'))
  })

  it('repetir la copia no envía nada de nuevo (cursor) y no duplica', async () => {
    const before = await count(remote, 'readings')
    const r = await syncOnce(app, remote)
    expect(r.ok).toBe(true)
    expect(r.tables.readings!.sent).toBe(0)
    expect(r.tables.audit_log!.sent).toBe(0)
    expect(await count(remote, 'readings')).toBe(before)
  })

  it('lo nuevo viaja en el ciclo siguiente: lecturas, alertas y cambios de configuración', async () => {
    const [node] = await app<{ id: number; greenhouse_id: number }[]>`select id, greenhouse_id from iot.nodes where kind = 'greenhouse' order by id limit 1`
    for (let i = 0; i < 5; i++) {
      await app`
        insert into iot.readings (node_id, greenhouse_id, ts, temp_c, hum_air, soil_raw, pump_on, seq)
        values (${node!.id}, ${node!.greenhouse_id}, now() - ${i} * interval '1 second', 21.5, 60, 450, false, ${SEQ_MARK + i})`
    }
    await app`
      insert into iot.alerts (greenhouse_id, node_id, type, severity, message)
      values (${node!.greenhouse_id}, ${node!.id}, 'sync_test_a', 'warning', 'prueba de sincronización')`
    await app`update iot.thresholds set soil_on = 710 where greenhouse_id = ${node!.greenhouse_id}`

    const r = await syncOnce(app, remote)
    expect(r.ok).toBe(true)
    expect(r.tables.readings!.sent).toBe(5)
    expect(await count(remote, 'readings', `seq >= ${SEQ_MARK}`)).toBe(5)
    expect(await count(remote, 'alerts', `type = 'sync_test_a'`)).toBe(1)
    const [t] = await remote<{ soil_on: number }[]>`select soil_on from iot.thresholds where greenhouse_id = ${node!.greenhouse_id}`
    expect(t!.soil_on).toBe(710)
    await app`update iot.thresholds set soil_on = 700 where greenhouse_id = ${node!.greenhouse_id}`   // se deja como estaba
  })

  it('el simulacro (dryRun) cuenta lo que enviaría sin escribir nada: ni en Supabase ni en los cursores', async () => {
    const [node] = await app<{ id: number; greenhouse_id: number }[]>`select id, greenhouse_id from iot.nodes where kind = 'greenhouse' order by id limit 1`
    for (let i = 0; i < 4; i++) {
      await app`
        insert into iot.readings (node_id, greenhouse_id, ts, temp_c, seq)
        values (${node!.id}, ${node!.greenhouse_id}, now(), 18, ${SEQ_MARK + 200 + i})`
    }
    const antesRemoto = await count(remote, 'readings')
    const [c0] = await app<{ last_id: number }[]>`select last_id from iot.sync_state where name = 'readings'`
    const r = await syncOnce(app, remote, { dryRun: true })
    expect(r.ok).toBe(true)
    expect(r.tables.readings!.sent).toBe(4)                                // lo que se enviaría
    expect(await count(remote, 'readings')).toBe(antesRemoto)               // pero no se escribió nada
    const [c1] = await app<{ last_id: number }[]>`select last_id from iot.sync_state where name = 'readings'`
    expect(c1!.last_id).toBe(c0!.last_id)                                   // y el cursor no se movió
    expect((await syncOnce(app, remote)).ok).toBe(true)                     // la copia real después sí las envía
    expect(await count(remote, 'readings', `seq >= ${SEQ_MARK + 200}`)).toBe(4)
  })

  it('un cambio de estado de una alerta (reconocida/resuelta) también llega', async () => {
    await app`update iot.alerts set status = 'resolved', resolved_at = now(), resolved_reason = 'auto' where type = 'sync_test_a'`
    expect((await syncOnce(app, remote)).ok).toBe(true)
    const [a] = await remote<{ status: string }[]>`select status from iot.alerts where type = 'sync_test_a'`
    expect(a!.status).toBe('resolved')
  })

  it('lo que el usuario borra en la Pi (calendarios) también se borra en Supabase', async () => {
    const [g] = await app<{ id: number }[]>`select id from iot.greenhouses order by id limit 1`
    await app`insert into iot.schedules (greenhouse_id, label, days, time_local, duration_s) values (${g!.id}, 'sync_test', '{1,3}', '06:30', 20)`
    await syncOnce(app, remote)
    expect(await count(remote, 'schedules', `label = 'sync_test'`)).toBe(1)
    await app`delete from iot.schedules where label = 'sync_test'`
    await syncOnce(app, remote)
    expect(await count(remote, 'schedules', `label = 'sync_test'`)).toBe(0)
  })

  it('sin conexión con Supabase: el ciclo falla sin romper nada y, al volver, se pone al día lo acumulado', async () => {
    const [node] = await app<{ id: number; greenhouse_id: number }[]>`select id, greenhouse_id from iot.nodes where kind = 'greenhouse' order by id limit 1`
    for (let i = 0; i < 3; i++) {
      await app`
        insert into iot.readings (node_id, greenhouse_id, ts, temp_c, seq)
        values (${node!.id}, ${node!.greenhouse_id}, now(), 19, ${SEQ_MARK + 100 + i})`
    }
    const caido = connect({ host: '127.0.0.1', port: 1, database: REMOTE_DB, user: 'iot_app', password: 'x' }, { sslMode: 'disable', max: 1 })
    const r = await syncOnce(app, caido)
    expect(r.ok).toBe(false)
    expect(r.error).toBeTruthy()
    const [s] = await app<{ last_error: string | null }[]>`select last_error from iot.sync_state where name = '_run'`
    expect(s!.last_error).toBeTruthy()
    expect(await count(remote, 'readings', `seq >= ${SEQ_MARK + 100} and seq < ${SEQ_MARK + 200}`)).toBe(0)

    const ok = await syncOnce(app, remote)
    expect(ok.ok).toBe(true)
    expect(await count(remote, 'readings', `seq >= ${SEQ_MARK + 100} and seq < ${SEQ_MARK + 200}`)).toBe(3)
    const [s2] = await app<{ last_error: string | null }[]>`select last_error from iot.sync_state where name = '_run'`
    expect(s2!.last_error).toBeNull()
  })

  it('una fila que Supabase rechaza por una restricción no detiene a las demás', async () => {
    const [g] = await app<{ id: number }[]>`select id from iot.greenhouses order by id limit 1`
    // En Supabase ya hay una alerta ACTIVA de este tipo con otro id → la de la Pi choca con el índice único parcial.
    await adminRemote`
      insert into iot.alerts (id, greenhouse_id, type, severity, message) overriding system value
      values (900001, ${g!.id}, 'sync_test_b', 'info', 'ya existe en Supabase')`
    await app`insert into iot.alerts (greenhouse_id, type, severity, message) values (${g!.id}, 'sync_test_b', 'info', 'choca')`
    await app`insert into iot.alerts (greenhouse_id, type, severity, message) values (${g!.id}, 'sync_test_c', 'info', 'esta sí pasa')`
    const r = await syncOnce(app, remote)
    expect(r.ok).toBe(true)
    expect(r.tables.alerts!.rejected).toBe(1)
    expect(await count(remote, 'alerts', `type = 'sync_test_c'`)).toBe(1)
    await adminRemote`delete from iot.alerts where id = 900001`
  })

  it('si el esquema de Supabase es distinto, esa tabla se omite y el resto sigue', async () => {
    await adminRemote.unsafe('alter table iot.thresholds add column if not exists extra_prueba int')
    const r = await syncOnce(app, remote)
    expect(r.ok).toBe(true)
    expect(r.tables.thresholds!.skipped).toBeTruthy()
    expect(r.tables.nodes!.skipped).toBeUndefined()
    await adminRemote.unsafe('alter table iot.thresholds drop column extra_prueba')
  })

  it('arranque inicial (Supabase → Pi): copia todo, conserva tokens y hashes, y no pisa una base con datos', async () => {
    const copia = `${REMOTE_DB}_pi`
    const root = adminOn('postgres')
    await root.unsafe(`create database ${copia}`)
    const nueva = adminOn(copia)
    try {
      await nueva.unsafe('create schema if not exists extensions')
      for (const f of fs.readdirSync(MIGRATIONS).filter((x) => x.endsWith('.sql')).sort()) await nueva.unsafe(fs.readFileSync(path.join(MIGRATIONS, f), 'utf8'))
      const r = await bootstrapFromRemote(remote, nueva)
      expect(r.copied.nodes).toBe(await count(remote, 'nodes'))
      for (const t of ['greenhouses', 'app_users', 'readings', 'audit_log', 'alerts']) expect(await count(nueva, t), t).toBe(await count(remote, t))
      const [v] = await nueva<{ first_broken_id: number | null }[]>`select * from iot.verify_audit_chain()`
      expect(v!.first_broken_id).toBeNull()                          // los hashes se copiaron tal cual (triggers apagados)
      const a = await remote<{ token_hash: Buffer }[]>`select token_hash from iot.nodes order by id`
      const b = await nueva<{ token_hash: Buffer }[]>`select token_hash from iot.nodes order by id`
      expect(b.map((x) => x.token_hash.toString('hex'))).toEqual(a.map((x) => x.token_hash.toString('hex')))
      // Las secuencias siguen después de lo copiado: una lectura nueva no choca con las traídas.
      const [n] = await nueva<{ id: number; greenhouse_id: number }[]>`select id, greenhouse_id from iot.nodes where kind = 'greenhouse' limit 1`
      await nueva`insert into iot.readings (node_id, greenhouse_id, ts, seq) values (${n!.id}, ${n!.greenhouse_id}, now(), 1)`
      // Los cursores quedan al final: el servicio «sync» no reenvía lo que ya está en Supabase.
      const [c] = await nueva<{ last_id: number }[]>`select last_id from iot.sync_state where name = 'readings'`
      const [m] = await remote<{ m: number }[]>`select max(id) as m from iot.readings`
      expect(c!.last_id).toBe(m!.m)
      await expect(bootstrapFromRemote(remote, nueva)).rejects.toThrow(/ya tiene/)
    } finally {
      await nueva.end({ timeout: 3 })
      await root.unsafe(`drop database if exists ${copia} with (force)`)
      await root.end({ timeout: 3 })
    }
  })
})
