import { describe, expect, it } from 'vitest'
import { actorFromApiKey, createApiKey, revokeApiKey } from '../../src/lib/auth/api-key'
import { can } from '../../src/lib/rbac'
import { inRollback, makeUser } from './helpers'

describe('claves de API (iot.api_keys)', () => {
  it('una clave vigente actúa con el rol del usuario y solo se guarda su SHA-256', async () => {
    await inRollback(async (tx) => {
      const u = await makeUser(tx, 'agronomist')
      const k = await createApiKey(tx, u.email, 'prueba')
      expect(k.key.startsWith('iotk_')).toBe(true)
      const r = await actorFromApiKey(tx, k.key)
      expect(r.ok).toBe(true)
      if (!r.ok) return
      expect(r.actor).toMatchObject({ id: u.id, email: u.email, role: 'agronomist', keyId: k.keyId })
      expect(can(r.actor.role, 'thresholds:edit')).toBe(true)
      expect(can(r.actor.role, 'irrigation:command')).toBe(false)           // los mismos permisos que en la interfaz
      const rows = await tx<{ n: number }[]>`select count(*)::int as n from iot.api_keys where token_hash = decode(${Buffer.from(k.key).toString('hex')}, 'hex')`
      expect(rows[0]!.n).toBe(0)                                             // la clave en claro no está en la base
    })
  })

  it('una clave falsa, o con el formato de otra, no entra', async () => {
    await inRollback(async (tx) => {
      expect(await actorFromApiKey(tx, `iotk_${'x'.repeat(43)}`)).toEqual({ ok: false, reason: 'invalid' })
    })
  })

  it('una clave revocada deja de servir (y revocar dos veces no hace nada)', async () => {
    await inRollback(async (tx) => {
      const u = await makeUser(tx, 'operator', { greenhouseIds: [1] })
      const k = await createApiKey(tx, u.email, 'a revocar')
      expect((await actorFromApiKey(tx, k.key)).ok).toBe(true)
      expect(await revokeApiKey(tx, k.keyId)).toBe(true)
      expect(await actorFromApiKey(tx, k.key)).toEqual({ ok: false, reason: 'invalid' })
      expect(await revokeApiKey(tx, k.keyId)).toBe(false)
    })
  })

  it('si el usuario se desactiva, sus claves dejan de servir', async () => {
    await inRollback(async (tx) => {
      const u = await makeUser(tx, 'admin')
      const k = await createApiKey(tx, u.email, 'x')
      await tx`update iot.app_users set is_active = false where id = ${u.id}`
      expect(await actorFromApiKey(tx, k.key)).toEqual({ ok: false, reason: 'invalid' })
      await expect(createApiKey(tx, u.email, 'otra')).rejects.toThrow(/desactivado/)
    })
  })

  it('el súper administrador no puede tener claves (se saltaría las salvaguardas del riego)', async () => {
    await inRollback(async (tx) => {
      const u = await makeUser(tx, 'superadmin')
      await expect(createApiKey(tx, u.email, 'x')).rejects.toThrow(/súper administrador/)
      // aunque una clave se creara por otra vía, el acceso se rechaza
      const token = 'iotk_' + 'B'.repeat(43)
      await tx`insert into iot.api_keys (name, user_id, token_hash) values ('x', ${u.id}, sha256(convert_to(${token}, 'UTF8')))`
      expect(await actorFromApiKey(tx, token)).toEqual({ ok: false, reason: 'forbidden' })
    })
  })

  it('un operador conserva su alcance: solo los sectores asignados', async () => {
    await inRollback(async (tx) => {
      const u = await makeUser(tx, 'operator', { greenhouseIds: [1, 3] })
      const k = await createApiKey(tx, u.email, 'op')
      const r = await actorFromApiKey(tx, k.key)
      expect(r.ok && r.actor.greenhouseIds).toEqual([1, 3])
    })
  })

  it('crear una clave para un usuario inexistente falla con un mensaje claro', async () => {
    await inRollback(async (tx) => {
      await expect(createApiKey(tx, 'nadie@invernadero.local', 'x')).rejects.toThrow(/No existe el usuario/)
    })
  })
})
