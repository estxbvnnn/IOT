import { z } from 'zod'
import type { Db } from '../db/types'
import { inTransaction } from '../db/types'
import { type Actor, assertCan } from '../rbac'
import {
  GREENHOUSE_CODE_HELP, GREENHOUSE_CODE_RE, MAX_GREENHOUSE_ID, defaultGreenhouseCode,
} from '../domain/greenhouse'
import { centerBounds, insideSite, requiredSiteSize } from '../domain/layout'
import type { ManagedGreenhouseDTO, SiteSettingsDTO } from '../domain/types'
import { audit } from './audit'
import { insertNode } from './devices'
import { ValidationError } from './thresholds'

/**
 * Invernaderos ESCALABLES: el administrador da de alta, edita y da de baja invernaderos desde el panel; la
 * cantidad no es fija. Cada alta crea, en una sola transacción, el invernadero, sus umbrales y su nodo (con el
 * token que se muestra UNA vez).
 *
 * Nada se borra: la «baja» es lógica. El historial (lecturas, riegos, alertas, bitácora) se conserva, el nodo
 * queda deshabilitado y el invernadero deja de verse en el panel; se puede reactivar. El rol de la aplicación
 * ni siquiera tiene DELETE sobre estas tablas.
 */

const round1 = (n: number) => Math.round(n * 10) / 10
const round2 = (n: number) => Math.round(n * 100) / 100
const NUM = 'Ingresa un número.'

// ------------------------------------------------------------------ validación

/** Datos editables de un invernadero (el código se elige al crear y no cambia después). */
export const greenhouseFieldsSchema = z.object({
  name: z.string({ error: 'Ingresa el nombre.' }).trim().min(1, 'Ingresa el nombre.').max(80, 'Máximo 80 caracteres.'),
  crop: z.string().trim().max(60, 'Máximo 60 caracteres.').nullish().transform((v) => v || null),
  areaM2: z.number({ error: NUM }).positive('Debe ser mayor que 0.').max(999_999, 'Es demasiado grande.').nullish()
    .transform((v) => (v == null ? null : round2(v))),
  flowLph: z.number({ error: NUM }).positive('Debe ser mayor que 0.').max(999_999, 'Es demasiado grande.').transform(round2),
  x: z.number({ error: NUM }).min(0, 'No puede ser negativa.').max(5000, 'Queda fuera del predio.').transform(round2),
  y: z.number({ error: NUM }).min(0, 'No puede ser negativa.').max(5000, 'Queda fuera del predio.').transform(round2),
})

export const createGreenhouseSchema = greenhouseFieldsSchema.extend({
  /** Vacío = automático («I<n>»). */
  code: z.preprocess(
    (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
    z.string().trim().regex(GREENHOUSE_CODE_RE, GREENHOUSE_CODE_HELP).optional(),
  ),
  /** Copia los umbrales de otro invernadero (id) en lugar de usar los valores por defecto. */
  copyThresholdsFrom: z.number().int().min(1).max(MAX_GREENHOUSE_ID).nullish().transform((v) => v ?? null),
})

export const siteSettingsSchema = z
  .object({
    siteName: z.string({ error: 'Ingresa el nombre.' }).trim().min(1, 'Ingresa el nombre.').max(80, 'Máximo 80 caracteres.'),
    widthM: z.number({ error: NUM }).min(20, 'Mínimo 20 m.').max(5000, 'Máximo 5.000 m.').transform(round1),
    heightM: z.number({ error: NUM }).min(20, 'Mínimo 20 m.').max(5000, 'Máximo 5.000 m.').transform(round1),
    substationX: z.number({ error: NUM }).min(0, 'No puede ser negativa.').max(5000, 'Queda fuera del predio.').transform(round1),
    substationY: z.number({ error: NUM }).min(0, 'No puede ser negativa.').max(5000, 'Queda fuera del predio.').transform(round1),
    tankX: z.number({ error: NUM }).min(0, 'No puede ser negativa.').max(5000, 'Queda fuera del predio.').nullish()
      .transform((v) => (v == null ? null : round1(v))),
    tankY: z.number({ error: NUM }).min(0, 'No puede ser negativa.').max(5000, 'Queda fuera del predio.').nullish()
      .transform((v) => (v == null ? null : round1(v))),
  })
  .superRefine((s, ctx) => {
    if (s.substationX > s.widthM) ctx.addIssue({ code: 'custom', path: ['substationX'], message: 'La subestación debe quedar dentro del predio.' })
    if (s.substationY > s.heightM) ctx.addIssue({ code: 'custom', path: ['substationY'], message: 'La subestación debe quedar dentro del predio.' })
    if ((s.tankX === null) !== (s.tankY === null)) {
      ctx.addIssue({ code: 'custom', path: [s.tankX === null ? 'tankX' : 'tankY'], message: 'Indica X e Y del estanque, o deja ambos vacíos.' })
    }
    if (s.tankX !== null && s.tankX > s.widthM) ctx.addIssue({ code: 'custom', path: ['tankX'], message: 'El estanque debe quedar dentro del predio.' })
    if (s.tankY !== null && s.tankY > s.heightM) ctx.addIssue({ code: 'custom', path: ['tankY'], message: 'El estanque debe quedar dentro del predio.' })
  })

function parseOrThrow<S extends z.ZodType>(schema: S, raw: unknown): z.output<S> {
  const parsed = schema.safeParse(raw)
  if (!parsed.success) {
    const fe: Record<string, string> = {}
    for (const i of parsed.error.issues) fe[String(i.path[0] ?? 'form')] ??= i.message
    throw new ValidationError(fe)
  }
  return parsed.data
}

const fmtM = (n: number) => n.toLocaleString('es-CL', { maximumFractionDigits: 1 })

/** El rectángulo del invernadero debe quedar completo dentro del predio (si no, el mapa lo recortaría). */
function assertInside(x: number, y: number, site: { widthM: number; heightM: number }): void {
  if (insideSite({ x, y }, site)) return
  const b = centerBounds(site)
  const fe: Record<string, string> = {}
  if (x < b.minX || x > b.maxX) fe.x = `Entre ${fmtM(b.minX)} y ${fmtM(b.maxX)} m para que quepa en el predio.`
  if (y < b.minY || y > b.maxY) fe.y = `Entre ${fmtM(b.minY)} y ${fmtM(b.maxY)} m para que quepa en el predio.`
  throw new ValidationError(fe, 'La posición queda fuera del predio.')
}

/** Nombre de la restricción única violada (SQLSTATE 23505), o null si el error es otro. */
function uniqueViolation(e: unknown): string | null {
  if (typeof e !== 'object' || e === null) return null
  const err = e as { code?: string; constraint_name?: string }
  return err.code === '23505' ? (err.constraint_name ?? '') : null
}

// ------------------------------------------------------------------ lectura

interface ManagedRow {
  id: number
  code: string
  name: string
  crop: string | null
  x_m: number
  y_m: number
  area_m2: number | null
  flow_lph: number
  archived_at: Date | null
  created_at: Date
  node_id: number | null
  node_enabled: boolean | null
  token_prefix: string | null
  last_seen: Date | null
}

const toManaged = (r: ManagedRow): ManagedGreenhouseDTO => ({
  id: r.id, code: r.code, name: r.name, crop: r.crop, x: r.x_m, y: r.y_m, areaM2: r.area_m2, flowLph: r.flow_lph,
  archived: r.archived_at !== null, archivedAt: r.archived_at?.toISOString() ?? null, createdAt: r.created_at.toISOString(),
  node: r.node_id === null ? null : {
    id: r.node_id, enabled: r.node_enabled ?? false, tokenPrefix: r.token_prefix ?? '', lastSeen: r.last_seen?.toISOString() ?? null,
  },
})

function selectManaged(db: Db, id: number | null) {
  return db<ManagedRow[]>`
    select g.id, g.code, g.name, g.crop, g.x_m, g.y_m, g.area_m2, g.flow_lph, g.archived_at, g.created_at,
           n.id as node_id, n.enabled as node_enabled, n.token_prefix, s.ts as last_seen
      from iot.greenhouses g
      left join iot.nodes n on n.greenhouse_id = g.id
      left join iot.node_state s on s.node_id = n.id
     where (${id}::int is null or g.id = ${id})
     order by (g.archived_at is not null), g.id`
}

/** Todos los invernaderos (activos primero, luego los dados de baja) para la página de administración. */
export async function listManagedGreenhouses(db: Db, actor: Actor): Promise<ManagedGreenhouseDTO[]> {
  assertCan(actor, 'greenhouses:manage')
  return (await selectManaged(db, null)).map(toManaged)
}

interface SiteRow {
  site_name: string
  width_m: number
  height_m: number
  substation_x_m: number
  substation_y_m: number
  tank_x_m: number | null
  tank_y_m: number | null
}

const toSite = (s: SiteRow | undefined): SiteSettingsDTO => ({
  siteName: s?.site_name ?? 'Predio agrícola',
  widthM: s?.width_m ?? 100,
  heightM: s?.height_m ?? 100,
  substation: { x: s?.substation_x_m ?? 50, y: s?.substation_y_m ?? 50 },
  tank: s && s.tank_x_m !== null && s.tank_y_m !== null ? { x: s.tank_x_m, y: s.tank_y_m } : null,
})

const SITE_COLS = (db: Db) => db`site_name, width_m, height_m, substation_x_m, substation_y_m, tank_x_m, tank_y_m`

export async function getSiteSettings(db: Db, actor: Actor): Promise<SiteSettingsDTO> {
  assertCan(actor, 'greenhouses:manage')
  const [s] = await db<SiteRow[]>`select ${SITE_COLS(db)} from iot.site_settings where id = 1`
  return toSite(s)
}

// ------------------------------------------------------------------ alta

export interface CreatedGreenhouse {
  greenhouse: ManagedGreenhouseDTO
  /** Token del nodo: existe en claro SOLO en esta respuesta (la base guarda su SHA-256). */
  token: string
}

export async function createGreenhouse(db: Db, actor: Actor, raw: unknown, ip: string | null = null): Promise<CreatedGreenhouse> {
  assertCan(actor, 'greenhouses:manage')
  const input = parseOrThrow(createGreenhouseSchema, raw)
  try {
    return await inTransaction(db, async (tx) => {
      // Las altas se serializan: el id nuevo es max(id) + 1 y dos altas simultáneas no deben elegir el mismo.
      // (postgres.js encadena estas sentencias por la misma conexión: una sola ida y vuelta a Supabase.)
      const [, siteRows, maxRows, codeRows, srcRows] = await Promise.all([
        tx`select pg_advisory_xact_lock(hashtextextended('iot.greenhouses.create', 0))`,
        tx<{ width_m: number; height_m: number }[]>`select width_m, height_m from iot.site_settings where id = 1`,
        tx<{ id: number }[]>`select coalesce(max(id), 0)::int + 1 as id from iot.greenhouses`,
        tx<{ c: string }[]>`select lower(code) as c from iot.greenhouses`,
        input.copyThresholdsFrom === null
          ? Promise.resolve([] as { greenhouse_id: number }[])
          : tx<{ greenhouse_id: number }[]>`select greenhouse_id from iot.thresholds where greenhouse_id = ${input.copyThresholdsFrom}`,
      ])

      assertInside(input.x, input.y, { widthM: siteRows[0]?.width_m ?? 100, heightM: siteRows[0]?.height_m ?? 100 })
      if (input.copyThresholdsFrom !== null && srcRows.length === 0) {
        throw new ValidationError({ copyThresholdsFrom: 'Ese invernadero no existe.' })
      }
      const id = maxRows[0]!.id
      if (id > MAX_GREENHOUSE_ID) throw new ValidationError({}, `Se alcanzó el máximo de ${MAX_GREENHOUSE_ID.toLocaleString('es-CL')} invernaderos.`)

      const taken = new Set(codeRows.map((r) => r.c))
      let code: string
      if (input.code !== undefined) {
        if (taken.has(input.code.toLowerCase())) throw new ValidationError({ code: 'Ya existe un invernadero con ese código.' })
        code = input.code
      } else {
        const auto = defaultGreenhouseCode(id, taken)
        if (auto === null) throw new ValidationError({ code: 'No se pudo asignar un código automático: escribe uno.' })
        code = auto
      }

      // El invernadero, sus umbrales (por defecto o copiados) y su nodo, en orden y en una sola tanda.
      // postgres.js ejecuta cada consulta al «tocarla» (then o execute). `insertNode` es una función async y
      // arrancaría ANTES que las consultas que aún no se tocaron, así que estas se lanzan con .execute() en el
      // orden correcto: el invernadero tiene que existir antes que sus hijos (clave foránea).
      const insGreenhouse = tx`
        insert into iot.greenhouses (id, code, name, crop, x_m, y_m, area_m2, flow_lph)
        values (${id}, ${code}, ${input.name}, ${input.crop}, ${input.x}, ${input.y}, ${input.areaM2}, ${input.flowLph})`.execute()
      const insThresholds = tx`insert into iot.thresholds (greenhouse_id) values (${id})`.execute()
      const insNode = insertNode(tx, { kind: 'greenhouse', greenhouseId: id, label: `Nodo ${code}` })
      const copyThresholds = input.copyThresholdsFrom === null
        ? null
        : tx`
            update iot.thresholds t set
              soil_on = s.soil_on, soil_off = s.soil_off, soil_sat = s.soil_sat, temp_max = s.temp_max,
              temp_heat = s.temp_heat, temp_cold = s.temp_cold, temp_frost = s.temp_frost,
              hum_air_min = s.hum_air_min, hum_air_max = s.hum_air_max, pump_max_s = s.pump_max_s,
              pump_wait_s = s.pump_wait_s, interval_s = s.interval_s
             from iot.thresholds s
            where t.greenhouse_id = ${id} and s.greenhouse_id = ${input.copyThresholdsFrom}`.execute()
      const [, , node] = await Promise.all([insGreenhouse, insThresholds, insNode, copyThresholds])

      // La bitácora va AL FINAL: el bloqueo de su cadena de hashes se toma siempre en último lugar.
      await audit(tx, {
        actorId: actor.id, actorLabel: actor.email, actorRole: actor.role, action: 'greenhouse.create',
        target: `greenhouse:${id}`, ip,
        detail: {
          code, name: input.name, crop: input.crop, x: input.x, y: input.y, areaM2: input.areaM2, flowLph: input.flowLph,
          copyThresholdsFrom: input.copyThresholdsFrom, nodeId: node.id,
        },
      })

      return {
        greenhouse: {
          id, code, name: input.name, crop: input.crop, x: input.x, y: input.y, areaM2: input.areaM2, flowLph: input.flowLph,
          archived: false, archivedAt: null, createdAt: new Date().toISOString(),
          node: { id: node.id, enabled: true, tokenPrefix: node.token.slice(0, 6), lastSeen: null },
        },
        token: node.token,
      }
    })
  } catch (e) {
    const constraint = uniqueViolation(e)
    if (constraint === null) throw e
    if (constraint.includes('code')) throw new ValidationError({ code: 'Ya existe un invernadero con ese código.' })
    throw new ValidationError({}, 'Otra persona creó un invernadero al mismo tiempo. Inténtalo de nuevo.')
  }
}

// ------------------------------------------------------------------ edición

const EDITABLE = ['name', 'crop', 'areaM2', 'flowLph', 'x', 'y'] as const

export async function updateGreenhouse(db: Db, actor: Actor, id: number, raw: unknown, ip: string | null = null): Promise<ManagedGreenhouseDTO> {
  assertCan(actor, 'greenhouses:manage')
  const input = parseOrThrow(greenhouseFieldsSchema, raw)
  return inTransaction(db, async (tx) => {
    // «for no key update»: no bloquea a las tramas de los nodos, que solo toman «for key share» sobre esta fila.
    const [curRows, siteRows] = await Promise.all([
      tx<{ code: string; name: string; crop: string | null; x_m: number; y_m: number; area_m2: number | null; flow_lph: number }[]>`
        select code, name, crop, x_m, y_m, area_m2, flow_lph from iot.greenhouses where id = ${id} for no key update`,
      tx<{ width_m: number; height_m: number }[]>`select width_m, height_m from iot.site_settings where id = 1`,
    ])
    const cur = curRows[0]
    if (!cur) throw new ValidationError({}, 'Invernadero no encontrado.')
    assertInside(input.x, input.y, { widthM: siteRows[0]?.width_m ?? 100, heightM: siteRows[0]?.height_m ?? 100 })

    const before = { name: cur.name, crop: cur.crop, areaM2: cur.area_m2, flowLph: cur.flow_lph, x: cur.x_m, y: cur.y_m }
    const changes: Record<string, { from: unknown; to: unknown }> = {}
    for (const k of EDITABLE) if (before[k] !== input[k]) changes[k] = { from: before[k], to: input[k] }

    if (Object.keys(changes).length > 0) {
      await tx`
        update iot.greenhouses
           set name = ${input.name}, crop = ${input.crop}, area_m2 = ${input.areaM2}, flow_lph = ${input.flowLph},
               x_m = ${input.x}, y_m = ${input.y}
         where id = ${id}`
      await audit(tx, {
        actorId: actor.id, actorLabel: actor.email, actorRole: actor.role, action: 'greenhouse.update',
        target: `greenhouse:${id}`, detail: { code: cur.code, changes }, ip,
      })
    }
    const [row] = await selectManaged(tx, id)
    return toManaged(row!)
  })
}

// ------------------------------------------------------------------ baja y reactivación

export interface ArchiveSummary {
  /** false si ya estaba dado de baja (la operación es idempotente). */
  changed: boolean
  alertsResolved: number
  commandsCancelled: number
  schedulesDisabled: number
  irrigationsClosed: number
}

/**
 * Da de baja un invernadero: deja de verse en el panel y su nodo se deshabilita (el servidor rechaza sus tramas).
 * Se resuelven sus alertas, se cancelan sus órdenes pendientes y se desactivan sus calendarios. El historial NO se toca.
 * OJO: el nodo físico sigue regando de forma autónoma con su última configuración hasta que se apague o desconecte.
 */
export async function archiveGreenhouse(db: Db, actor: Actor, id: number, ip: string | null = null): Promise<ArchiveSummary> {
  assertCan(actor, 'greenhouses:manage')
  return inTransaction(db, async (tx) => {
    const [g] = await tx<{ code: string; archived_at: Date | null }[]>`
      select code, archived_at from iot.greenhouses where id = ${id} for no key update`
    if (!g) throw new ValidationError({}, 'Invernadero no encontrado.')
    if (g.archived_at !== null) return { changed: false, alertsResolved: 0, commandsCancelled: 0, schedulesDisabled: 0, irrigationsClosed: 0 }

    // Un riego que quedó «abierto» se cierra ahora (duración acotada): si se reactivara más tarde, el primer reporte
    // lo cerraría con horas o días de duración y falsearía el consumo de agua.
    const dur = tx`least(120, greatest(0, round(extract(epoch from (now() - e.started_at)))::int))`
    // Mismo orden de escritura que la recepción de tramas (riegos, alertas, órdenes…), para no cruzar bloqueos.
    const [irrigations, alerts, commands, schedules] = await Promise.all([
      tx`
        update iot.irrigation_events e
           set duration_s = ${dur}, ended_at = e.started_at + make_interval(secs => ${dur}), end_reason = 'desconocido',
               water_l = round(${dur}::numeric / 3600 * g.flow_lph, 3)
          from iot.greenhouses g
         where g.id = e.greenhouse_id and e.greenhouse_id = ${id} and e.ended_at is null`,
      tx`
        update iot.alerts set status = 'resolved', resolved_at = now(), resolved_reason = 'manual'
         where greenhouse_id = ${id} and status <> 'resolved'`,
      tx`
        update iot.commands set status = 'cancelled'
         where greenhouse_id = ${id} and status in ('awaiting_confirmation', 'queued', 'delivered')`,
      tx`update iot.schedules set enabled = false where greenhouse_id = ${id} and enabled`,
      tx`update iot.nodes set enabled = false where greenhouse_id = ${id}`,
      tx`update iot.greenhouses set archived_at = now() where id = ${id}`,
    ])
    const summary: ArchiveSummary = {
      changed: true, alertsResolved: alerts.count, commandsCancelled: commands.count,
      schedulesDisabled: schedules.count, irrigationsClosed: irrigations.count,
    }
    await audit(tx, {
      actorId: actor.id, actorLabel: actor.email, actorRole: actor.role, action: 'greenhouse.archive',
      target: `greenhouse:${id}`, detail: { code: g.code, ...summary }, ip,
    })
    return summary
  })
}

/** Reactiva un invernadero dado de baja: vuelve al panel y se habilita su nodo. Los calendarios quedan desactivados. */
export async function restoreGreenhouse(db: Db, actor: Actor, id: number, ip: string | null = null): Promise<{ changed: boolean }> {
  assertCan(actor, 'greenhouses:manage')
  return inTransaction(db, async (tx) => {
    const [g] = await tx<{ code: string; archived_at: Date | null }[]>`
      select code, archived_at from iot.greenhouses where id = ${id} for no key update`
    if (!g) throw new ValidationError({}, 'Invernadero no encontrado.')
    if (g.archived_at === null) return { changed: false }
    await Promise.all([
      tx`update iot.nodes set enabled = true where greenhouse_id = ${id}`,
      tx`update iot.greenhouses set archived_at = null where id = ${id}`,
    ])
    await audit(tx, {
      actorId: actor.id, actorLabel: actor.email, actorRole: actor.role, action: 'greenhouse.restore',
      target: `greenhouse:${id}`, detail: { code: g.code }, ip,
    })
    return { changed: true }
  })
}

// ------------------------------------------------------------------ ajustes del predio

export async function updateSiteSettings(db: Db, actor: Actor, raw: unknown, ip: string | null = null): Promise<SiteSettingsDTO> {
  assertCan(actor, 'greenhouses:manage')
  const input = parseOrThrow(siteSettingsSchema, raw)
  return inTransaction(db, async (tx) => {
    const [siteRows, active] = await Promise.all([
      tx<SiteRow[]>`select ${SITE_COLS(tx)} from iot.site_settings where id = 1 for update`,
      tx<{ x_m: number; y_m: number }[]>`select x_m, y_m from iot.greenhouses where archived_at is null`,
    ])

    // Achicar el predio no puede dejar invernaderos fuera del mapa.
    const need = requiredSiteSize(active.map((g) => ({ x: g.x_m, y: g.y_m })))
    const fe: Record<string, string> = {}
    if (input.widthM < need.widthM) fe.widthM = `Debe ser de al menos ${need.widthM} m para que quepan los invernaderos actuales.`
    if (input.heightM < need.heightM) fe.heightM = `Debe ser de al menos ${need.heightM} m para que quepan los invernaderos actuales.`
    if (Object.keys(fe).length > 0) throw new ValidationError(fe)

    const before = toSite(siteRows[0])
    const next: SiteSettingsDTO = {
      siteName: input.siteName, widthM: input.widthM, heightM: input.heightM,
      substation: { x: input.substationX, y: input.substationY },
      tank: input.tankX === null || input.tankY === null ? null : { x: input.tankX, y: input.tankY },
    }
    const changes: Record<string, { from: unknown; to: unknown }> = {}
    const cmp = (k: string, a: unknown, b: unknown) => { if (JSON.stringify(a) !== JSON.stringify(b)) changes[k] = { from: a, to: b } }
    cmp('siteName', before.siteName, next.siteName)
    cmp('widthM', before.widthM, next.widthM)
    cmp('heightM', before.heightM, next.heightM)
    cmp('substation', before.substation, next.substation)
    cmp('tank', before.tank, next.tank)
    if (Object.keys(changes).length === 0) return before

    await tx`
      insert into iot.site_settings (id, site_name, width_m, height_m, substation_x_m, substation_y_m, tank_x_m, tank_y_m)
      values (1, ${next.siteName}, ${next.widthM}, ${next.heightM}, ${next.substation.x}, ${next.substation.y},
              ${next.tank?.x ?? null}, ${next.tank?.y ?? null})
      on conflict (id) do update set
        site_name = excluded.site_name, width_m = excluded.width_m, height_m = excluded.height_m,
        substation_x_m = excluded.substation_x_m, substation_y_m = excluded.substation_y_m,
        tank_x_m = excluded.tank_x_m, tank_y_m = excluded.tank_y_m, updated_at = now()`
    await audit(tx, {
      actorId: actor.id, actorLabel: actor.email, actorRole: actor.role, action: 'site.update',
      target: 'site', detail: { changes }, ip,
    })
    return next
  })
}
