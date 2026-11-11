import { describe, expect, it } from 'vitest'
import type { Db } from '../../src/lib/db/types'
import { handleIngest } from '../../src/lib/services/ingest'
import { frameBuilder, inRollback, plus, T0 } from './helpers'

/** Modo abierto (ACEPTAR_NODOS_NUEVOS=1): una trama con `abierto: true` y el id de chip que traería la ruta /relay. */
function enviar(tx: Db, nombre: string, chip: string | null, seq: number, now: Date) {
  return handleIngest(tx, {
    authorization: `Bearer ${nombre}`,
    rawBody: JSON.stringify(frameBuilder()({ seq })),
    ip: '203.0.113.9',
    now,
    skipSweep: true,
    abierto: true,
    route: { transport: 'espnow', via: 'nodo-fef2cc', hops: 1, device: chip },
  })
}

const invernaderos = (tx: Db) =>
  tx<{ id: number; code: string; name: string; archived: boolean }[]>`
    select id, code, name, (archived_at is not null) as archived from iot.greenhouses
     where code in ('zz-prueba-a', 'zz-prueba-b', 'zz-prueba-c') or name in ('zz-prueba-a', 'zz-prueba-b', 'zz-prueba-c') order by id`

describe('modo abierto · la misma placa con otro nombre NO duplica el invernadero', () => {
  it('cambiar el nombre desde el mismo chip renombra el invernadero y conserva el historial', async () => {
    await inRollback(async (tx) => {
      expect((await enviar(tx, 'zz-prueba-a', 'nodo-aabbcc', 1, T0)).status).toBe(200)
      const antes = await invernaderos(tx)
      expect(antes).toHaveLength(1)

      // Se vuelve a subir el firmware con otro nombre: mismo chip, nombre nuevo.
      expect((await enviar(tx, 'zz-prueba-b', 'nodo-aabbcc', 1, plus(T0, 30))).status).toBe(200)
      const despues = await invernaderos(tx)
      expect(despues).toHaveLength(1)                                   // sin duplicado
      expect(despues[0]).toMatchObject({ id: antes[0]!.id, code: 'zz-prueba-b', name: 'zz-prueba-b', archived: false })

      // Las dos lecturas están en el MISMO invernadero.
      const [n] = await tx<{ n: number }[]>`select count(*)::int as n from iot.readings where greenhouse_id = ${antes[0]!.id}`
      expect(n!.n).toBe(2)
      // Y el nombre viejo ya no abre nada: si llegara de otra placa se daría de alta aparte (no se mezcla).
      const viejo = await tx`select 1 from iot.nodes n where n.token_prefix = 'zz-pru' and n.greenhouse_id = ${antes[0]!.id}`
      expect(viejo).toHaveLength(1)                                     // el mismo nodo, con el token nuevo
    })
  })

  it('chips distintos con nombres distintos siguen siendo invernaderos distintos', async () => {
    await inRollback(async (tx) => {
      await enviar(tx, 'zz-prueba-a', 'nodo-111111', 1, T0)
      await enviar(tx, 'zz-prueba-b', 'nodo-222222', 1, plus(T0, 5))
      expect(await invernaderos(tx)).toHaveLength(2)
    })
  })

  it('sin id de chip (HTTP directo) un nombre nuevo crea un invernadero nuevo, como antes', async () => {
    await inRollback(async (tx) => {
      await enviar(tx, 'zz-prueba-a', null, 1, T0)
      await enviar(tx, 'zz-prueba-b', null, 1, plus(T0, 5))
      expect(await invernaderos(tx)).toHaveLength(2)
    })
  })

  it('si el invernadero del chip está archivado, no se renombra ni se reactiva: se da de alta uno nuevo', async () => {
    await inRollback(async (tx) => {
      await enviar(tx, 'zz-prueba-a', 'nodo-aabbcc', 1, T0)
      await tx`update iot.nodes set enabled = false where token_prefix = 'zz-pru'`
      await tx`update iot.greenhouses set archived_at = now() where code = 'zz-prueba-a'`
      expect((await enviar(tx, 'zz-prueba-b', 'nodo-aabbcc', 1, plus(T0, 30))).status).toBe(200)
      const gh = await invernaderos(tx)
      expect(gh).toHaveLength(2)
      expect(gh.find((g) => g.code === 'zz-prueba-a')!.archived).toBe(true)
      expect(gh.find((g) => g.code === 'zz-prueba-b')!.archived).toBe(false)
    })
  })

  it('un nombre que ya es de otro invernadero no se roba: la trama entra en ese invernadero', async () => {
    await inRollback(async (tx) => {
      await enviar(tx, 'zz-prueba-a', 'nodo-111111', 1, T0)
      await enviar(tx, 'zz-prueba-b', 'nodo-222222', 1, plus(T0, 5))
      // El chip 2 pasa a usar el nombre del chip 1: es un nombre conocido, así que es ese invernadero (igual que sin renombrado).
      expect((await enviar(tx, 'zz-prueba-a', 'nodo-222222', 2, plus(T0, 40))).status).toBe(200)
      expect(await invernaderos(tx)).toHaveLength(2)
    })
  })

  it('registra la acción device.rename en la bitácora', async () => {
    await inRollback(async (tx) => {
      await enviar(tx, 'zz-prueba-a', 'nodo-aabbcc', 1, T0)
      await enviar(tx, 'zz-prueba-c', 'nodo-aabbcc', 1, plus(T0, 30))
      const filas = await tx<{ action: string }[]>`select action from iot.audit_log where action = 'device.rename' order by id desc limit 1`
      expect(filas).toHaveLength(1)
    })
  })
})
