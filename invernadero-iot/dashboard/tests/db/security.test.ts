import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { adminDb } from '../../scripts/lib/scriptenv'
import { inTransaction } from '@/lib/db/types'
import { audit } from '@/lib/services/audit'
import { app, inRollback } from './helpers'

/**
 * Modelo de permisos de la base (informe, secciones 12.2 a 12.4):
 * el rol de la aplicación NO puede alterar la bitácora ni hacer DDL; anon/authenticated no ven el esquema.
 */
const expectDenied = async (p: PromiseLike<unknown>, msg = /permission denied|must be owner|inmutable/) => {
  await expect(Promise.resolve(p).then(() => 'permitido', (e: Error) => e.message)).resolves.toMatch(msg)
}

describe('permisos del rol de la aplicación (iot_app)', () => {
  it('escribe en la bitácora (la cadena de hashes funciona con este rol) y la verifica', async () => {
    await inRollback(async (tx) => {
      await audit(tx, { actorLabel: 'prueba', action: 'auth.login', detail: { password: 'no-debe-verse', n: 1 } })
      await audit(tx, { actorLabel: 'prueba', action: 'auth.logout' })
      const rows = await tx<{ prev: string | null; h: string; detail: Record<string, unknown> }[]>`
        select encode(prev_hash, 'hex') as prev, encode(hash, 'hex') as h, detail from iot.audit_log order by id desc limit 2`
      expect(rows[0]!.prev).toBe(rows[1]!.h) // encadenadas
      expect(rows[1]!.detail.password).toBe('[oculto]')
      const [v] = await tx<{ checked: number; first_broken_id: number | null }[]>`select * from iot.verify_audit_chain()`
      expect(v!.first_broken_id).toBeNull()
    })
  })

  it('NO puede modificar ni borrar la bitácora, ni vaciarla', async () => {
    await inRollback(async (tx) => {
      await audit(tx, { actorLabel: 'prueba', action: 'auth.login' })
      await expectDenied(inTransaction(tx, async (s) => { await s`update iot.audit_log set action = 'x'` }))
      await expectDenied(inTransaction(tx, async (s) => { await s`delete from iot.audit_log` }))
      await expectDenied(inTransaction(tx, async (s) => { await s`truncate iot.audit_log` }))
    })
  })

  it('NO puede borrar telemetría ni riegos, ni hacer DDL, ni ejecutar la retención', async () => {
    await inRollback(async (tx) => {
      await expectDenied(inTransaction(tx, async (s) => { await s`delete from iot.readings` }))
      await expectDenied(inTransaction(tx, async (s) => { await s`delete from iot.irrigation_events` }))
      await expectDenied(inTransaction(tx, async (s) => { await s`delete from iot.app_users` }))
      await expectDenied(inTransaction(tx, async (s) => { await s`create table iot.intruso (x int)` }))
      await expectDenied(inTransaction(tx, async (s) => { await s`alter table iot.readings add column x int` }))
      await expectDenied(inTransaction(tx, async (s) => { await s`drop table iot.readings` }))
      await expectDenied(inTransaction(tx, async (s) => { await s`select * from iot.compact_readings()` }))
      await expectDenied(inTransaction(tx, async (s) => { await s`create role otro` }))
    })
  })

  it('no puede leer la tabla de migraciones (RLS sin política) ni el esquema public de otros', async () => {
    const r = await app`select * from iot.schema_migrations`
    expect(r).toHaveLength(0)
  })

  it('el token de los nodos solo existe como SHA-256 en la base', async () => {
    const rows = await app<{ token_hash: Buffer; token_prefix: string }[]>`select token_hash, token_prefix from iot.nodes`
    expect(rows.length).toBeGreaterThan(0)
    for (const r of rows) {
      expect(r.token_hash).toHaveLength(32)
      expect(r.token_prefix).toHaveLength(6)
    }
  })

  it('las contraseñas se guardan con scrypt y jamás en claro', async () => {
    const rows = await app<{ password_hash: string; totp_secret_enc: string | null }[]>`select password_hash, totp_secret_enc from iot.app_users`
    for (const r of rows) expect(r.password_hash).toMatch(/^scrypt\$32768\$8\$1\$/)
  })
})

describe('roles públicos de Supabase (anon / authenticated)', () => {
  const adminEnv = path.resolve(process.cwd(), '.env.admin.local')
  const has = fs.existsSync(adminEnv)
  const run = has ? it : it.skip

  run('no tienen acceso al esquema iot: ni tablas, ni funciones, ni bitácora', async () => {
    const admin = adminDb(1)
    const ROLLBACK = Symbol('rollback')
    try {
      for (const role of ['anon', 'authenticated']) {
        try {
          await admin.begin(async (tx) => {
            await tx.unsafe(`set local role ${role}`)
            for (const q of [
              'select * from iot.greenhouses', 'select * from iot.audit_log', 'select * from iot.app_users',
              'select * from iot.readings', "select iot.verify_audit_chain()", 'insert into iot.alerts (type, severity, message) values (\'x\', \'info\', \'x\')',
            ]) {
              await expectDenied(tx.savepoint((s) => s.unsafe(q)))
            }
            throw ROLLBACK
          })
        } catch (e) {
          if (e !== ROLLBACK) throw e
        }
      }
    } finally {
      await admin.end({ timeout: 5 })
    }
  })

  run('todas las tablas de iot tienen RLS activado y ningún permiso para anon/authenticated', async () => {
    const admin = adminDb(1)
    try {
      const tables = await admin<{ relname: string; rls: boolean }[]>`
        select c.relname, c.relrowsecurity as rls from pg_class c join pg_namespace n on n.oid = c.relnamespace
         where n.nspname = 'iot' and c.relkind = 'r'`
      expect(tables.length).toBeGreaterThanOrEqual(14)
      for (const t of tables) expect(t.rls, `RLS en iot.${t.relname}`).toBe(true)
      const grants = await admin<{ table_name: string; grantee: string }[]>`
        select table_name, grantee from information_schema.role_table_grants
         where table_schema = 'iot' and grantee in ('anon', 'authenticated', 'PUBLIC')`
      expect(grants).toEqual([])
    } finally {
      await admin.end({ timeout: 5 })
    }
  })
})
