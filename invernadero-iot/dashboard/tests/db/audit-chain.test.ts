import { describe, expect, it } from 'vitest'
import { afterAll, beforeAll } from 'vitest'
import { audit } from '../../src/lib/services/audit'
import type { Db } from '../../src/lib/db/types'
import { appDb } from '../../scripts/lib/scriptenv'
import { app } from './helpers'

/**
 * La cadena de hashes de la bitácora debe seguir íntegra aunque varias transacciones escriban A LA VEZ (p. ej. 10 nodos que se
 * presentan en el mismo instante, o un inicio de sesión mientras llega una trama). Antes de la migración 0008 el id se asignaba ANTES del
 * bloqueo del trigger y el «último registro» se buscaba por id, así que dos inserciones simultáneas bifurcaban la cadena y
 * `verify_audit_chain()` acusaba una alteración que no existía.
 *
 * Estas inserciones SE CONFIRMAN (la bitácora es solo-agregar y concurrente por naturaleza), por eso solo corre contra una base local de pruebas.
 */
const H = process.env.DATABASE_HOST ?? ''
const local = ['127.0.0.1', 'localhost', 'postgres'].includes(H)

describe.skipIf(!local)('bitácora: la cadena soporta escrituras concurrentes', () => {
  let many: Db
  beforeAll(() => { many = appDb(24) })                     // muchas conexiones: la carrera dura microsegundos y hay que provocarla
  afterAll(async () => { await many.end({ timeout: 5 }) })

  it('600 inserciones simultáneas (con 24 conexiones) dejan la cadena íntegra', async () => {
    const N = 600
    await Promise.all(
      Array.from({ length: N }, (_, i) =>
        audit(many, { actorLabel: `concurrencia:${i % 7}`, action: 'test.concurrent', target: `n:${i}`, detail: { i }, ip: null })),
    )
    const [v] = await app<{ checked: number; first_broken_id: number | null }[]>`select * from iot.verify_audit_chain()`
    expect(v!.first_broken_id).toBeNull()
    const [n] = await app<{ n: number }[]>`select count(*)::int as n from iot.audit_log where action = 'test.concurrent'`
    expect(n!.n).toBeGreaterThanOrEqual(N)
  })

  it('el id sigue el orden real de la cadena (cada registro apunta al hash del anterior por id)', async () => {
    const rows = await app<{ id: number; hash: Buffer; prev_hash: Buffer | null }[]>`select id, hash, prev_hash from iot.audit_log order by id`
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i]!.prev_hash?.toString('hex'), `registro ${rows[i]!.id}`).toBe(rows[i - 1]!.hash.toString('hex'))
    }
  })
})
