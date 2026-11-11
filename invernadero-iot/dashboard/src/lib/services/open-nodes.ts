import type { Db } from '../db/types'
import { inTransaction } from '../db/types'
import { hashToken } from '../auth/tokens'
import { GREENHOUSE_CODE_RE, defaultGreenhouseCode } from '../domain/greenhouse'
import { GH_GAP, GH_H, suggestPosition } from '../domain/layout'
import { audit } from './audit'

/**
 * MODO DE PRUEBAS · alta automática de nodos (ACEPTAR_NODOS_NUEVOS=1 en la pasarela).
 *
 * Con el modo normal cada nodo necesita un token aleatorio que se crea a mano en el dashboard. Para pruebas (varias placas con
 * el MISMO sketch, otro grupo, etc.) basta un IDENTIFICADOR («GRUPO-A», «nodo-a1b2c3»): la primera trama válida de un
 * identificador desconocido crea su invernadero (con umbrales por defecto) y su nodo. El identificador se guarda con el mismo
 * SHA-256 que un token, así que a partir de ahí todo el resto del sistema funciona igual.
 *
 * NO es seguro para producción: cualquiera que llegue a la pasarela puede darse de alta. Por eso hay un tope de invernaderos.
 */

export const MAX_GREENHOUSES_OPEN_MODE = 60

/** Id de chip válido tal como llega en la ruta del mensaje («nodo-85bbc8»). Cualquier otra cosa no se liga a nada. */
export const DEVICE_RE = /^[A-Za-z0-9_-]{1,40}$/

/**
 * Una placa que ya conocemos (por su id de chip) manda un NOMBRE nuevo: se renombra su invernadero en vez de crear otro.
 * El historial, los umbrales y el lugar en el mapa se conservan. true = se renombró; false = no aplica (chip desconocido,
 * invernadero archivado/deshabilitado, o el nombre ya es de otro) y hay que dar de alta normalmente.
 */
export async function renameOpenNode(db: Db, device: string, identifier: string): Promise<boolean> {
  if (!DEVICE_RE.test(device)) return false
  const hash = hashToken(identifier)
  return inTransaction(db, async (tx) => {
    await tx`select pg_advisory_xact_lock(hashtextextended('iot.greenhouses.create', 0))`
    const [taken] = await tx<{ id: number }[]>`select id from iot.nodes where token_hash = ${hash}`
    if (taken) return false   // el nombre ya existe: es otro nodo, no se mezcla
    const [b] = await tx<{ node_id: number; greenhouse_id: number | null; code: string | null; name: string | null }[]>`
      select n.id as node_id, n.greenhouse_id, g.code, g.name
        from iot.open_devices d
        join iot.nodes n on n.id = d.node_id
        join iot.greenhouses g on g.id = n.greenhouse_id
       where d.device = ${device} and n.enabled and g.archived_at is null
       for update of n`
    if (!b || b.greenhouse_id === null) return false

    // El código (p. ej. «grupo-1») solo cambia si es válido y no lo usa otro invernadero; si no, solo cambia el nombre visible.
    const codes = new Set((await tx<{ c: string }[]>`select lower(code) as c from iot.greenhouses where id <> ${b.greenhouse_id}`).map((r) => r.c))
    const newCode = GREENHOUSE_CODE_RE.test(identifier) && !codes.has(identifier.toLowerCase()) ? identifier : b.code
    await tx`
      update iot.nodes set token_hash = ${hash}, token_prefix = ${identifier.slice(0, 6)}, label = ${`Nodo ${identifier}`.slice(0, 80)}
       where id = ${b.node_id}`
    await tx`update iot.greenhouses set name = ${identifier.slice(0, 80)}, code = ${newCode} where id = ${b.greenhouse_id}`
    await tx`update iot.open_devices set seen_at = now() where device = ${device}`
    await audit(tx, {
      actorLabel: 'sistema', action: 'device.rename', target: `greenhouse:${b.greenhouse_id}`,
      detail: { auto: true, device, anterior: b.code, identifier, code: newCode },
    })
    return true
  })
}

/** Liga un id de chip a un nodo (si ya estaba ligado a otro, pasa a este). */
export async function bindOpenDevice(db: Db, device: string, nodeId: number): Promise<void> {
  if (!DEVICE_RE.test(device)) return
  await db`
    insert into iot.open_devices (device, node_id) values (${device}, ${nodeId})
    on conflict (device) do update set node_id = excluded.node_id, seen_at = now()`
}

/** true = el nodo existe (recién creado o ya estaba); false = no se pudo (tope alcanzado o sin código libre). */
export async function registerOpenNode(db: Db, identifier: string, device: string | null = null): Promise<boolean> {
  const hash = hashToken(identifier)
  return inTransaction(db, async (tx) => {
    // Mismo candado que createGreenhouse: dos altas simultáneas no deben elegir el mismo id.
    await tx`select pg_advisory_xact_lock(hashtextextended('iot.greenhouses.create', 0))`
    const [exists] = await tx<{ id: number }[]>`select id from iot.nodes where token_hash = ${hash}`
    if (exists) return true

    const [info] = await tx<{ next_id: number; n: number }[]>`
      select coalesce(max(id), 0)::int + 1 as next_id, count(*)::int as n from iot.greenhouses`
    if (!info || info.n >= MAX_GREENHOUSES_OPEN_MODE) return false
    const taken = new Set((await tx<{ c: string }[]>`select lower(code) as c from iot.greenhouses`).map((r) => r.c))
    const id = info.next_id
    const code = GREENHOUSE_CODE_RE.test(identifier) && !taken.has(identifier.toLowerCase()) ? identifier : defaultGreenhouseCode(id, taken)
    if (code === null) return false

    // Posición: el lugar libre más cercano a la subestación, igual que propone la pantalla «Invernaderos». Si el predio está
    // lleno se alarga hacia abajo (como al agregar invernaderos a mano) en vez de montar uno sobre otro.
    const [site] = await tx<{ width_m: number; height_m: number; sx: number; sy: number; tx: number | null; ty: number | null }[]>`
      select width_m, height_m, substation_x_m as sx, substation_y_m as sy, tank_x_m as tx, tank_y_m as ty
        from iot.site_settings where id = 1 for update`
    // numeric(6,1) puede llegar como texto: todo se convierte a número.
    const occupied = (await tx<{ x: number; y: number }[]>`select x_m as x, y_m as y from iot.greenhouses where archived_at is null`)
      .map((o) => ({ x: Number(o.x), y: Number(o.y) }))
    const widthM = Number(site?.width_m ?? 100)
    let heightM = Number(site?.height_m ?? 100)
    const substation = { x: Number(site?.sx ?? 50), y: Number(site?.sy ?? 50) }
    const tank = site && site.tx !== null && site.ty !== null ? { x: Number(site.tx), y: Number(site.ty) } : null
    let pos = suggestPosition(occupied, { widthM, heightM, substation, tank })
    while (pos === null && heightM + GH_H + GH_GAP <= 5000) {
      heightM += GH_H + GH_GAP
      pos = suggestPosition(occupied, { widthM, heightM, substation, tank })
    }
    if (pos === null) return false
    // El predio solo se escribe si creció (o si aún no tiene fila: la app usa 100 × 100 por defecto y el mapa debe coincidir).
    if (!site || heightM !== Number(site.height_m)) {
      await tx`
        insert into iot.site_settings (id, width_m, height_m, substation_x_m, substation_y_m)
        values (1, ${widthM}, ${heightM}, ${substation.x}, ${substation.y})
        on conflict (id) do update set height_m = excluded.height_m, updated_at = now()`
    }
    await tx`
      insert into iot.greenhouses (id, code, name, crop, x_m, y_m, area_m2, flow_lph)
      values (${id}, ${code}, ${identifier.slice(0, 80)}, null, ${pos.x}, ${pos.y}, 20, 100)`
    await tx`insert into iot.thresholds (greenhouse_id) values (${id})`
    const [created] = await tx<{ id: number }[]>`
      insert into iot.nodes (kind, greenhouse_id, label, token_hash, token_prefix)
      values ('greenhouse', ${id}, ${`Nodo ${identifier}`.slice(0, 80)}, ${hash}, ${identifier.slice(0, 6)})
      returning id`
    if (device && DEVICE_RE.test(device) && created) {
      await tx`
        insert into iot.open_devices (device, node_id) values (${device}, ${created.id})
        on conflict (device) do update set node_id = excluded.node_id, seen_at = now()`
    }
    await audit(tx, { actorLabel: 'sistema', action: 'device.create', target: `greenhouse:${id}`, detail: { auto: true, identifier, code } })
    return true
  })
}
