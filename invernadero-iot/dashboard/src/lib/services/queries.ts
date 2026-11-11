import type { Db } from '../db/types'
import { type Actor, ForbiddenError, can, canAccessGreenhouse, scopeOf } from '../rbac'
import { offlineAfterS } from '../alerts/engine'
import { GREENHOUSE_CODE_RE } from '../domain/greenhouse'
import { soilBand } from '../domain/soil'
import {
  type AlertDTO, type GreenhouseStatus, type GreenhouseSummary, type IrrigationEventDTO, type PumpState,
  type RangeKey, RANGE_SPECS, type SeriesBundle, type SiteOverview, type WindSummary, type Point,
} from '../domain/types'
import { listAlerts, sweepOfflineNodes } from './alerts'
import { toThresholdsDTO } from './thresholds'

/**
 * Modelos de lectura del panel. Todas las consultas reciben al usuario y filtran por su alcance:
 * un operador nunca obtiene datos de sectores que no tiene asignados (informe, tabla 11).
 * Cada ida y vuelta a Supabase cuesta ~200 ms, por eso las consultas independientes van en paralelo.
 */

const MAST_INTERVAL_S = 60

interface GhRow {
  id: number; code: string; name: string; crop: string | null; x_m: number; y_m: number; area_m2: number | null
  node_id: number | null; enabled: boolean | null
  ts: Date | null; temp_c: number | null; hum_air: number | null; soil_raw: number | null; soil_pct: number | null
  light_lux: number | null; flow_lmin: number | null; pump_on: boolean | null; pump_state: PumpState | null; pump_run_s: number | null
  cooldown_s: number | null; faults: string[] | null
  soil_on: number; soil_off: number; soil_sat: number; temp_max: number; temp_heat: number; temp_cold: number
  temp_frost: number; hum_air_min: number; hum_air_max: number; pump_max_s: number; pump_wait_s: number
  interval_s: number; auto_enabled: boolean; version: number; updated_at: Date
}

/** Punto de referencia de la subestación (mástil central) para las distancias. */
export interface SiteGeometry { widthM: number; heightM: number; substationX: number; substationY: number }

async function loadGeometry(db: Db): Promise<SiteGeometry & { siteName: string; windWarn: number; windCrit: number; tank: { x: number; y: number } | null }> {
  const [s] = await db<{
    site_name: string; width_m: number; height_m: number; substation_x_m: number; substation_y_m: number
    wind_warn_ms: number; wind_crit_ms: number; tank_x_m: number | null; tank_y_m: number | null
  }[]>`
    select site_name, width_m, height_m, substation_x_m, substation_y_m, wind_warn_ms, wind_crit_ms, tank_x_m, tank_y_m
      from iot.site_settings where id = 1`
  return {
    siteName: s?.site_name ?? 'Predio agrícola', widthM: s?.width_m ?? 100, heightM: s?.height_m ?? 100,
    substationX: s?.substation_x_m ?? 50, substationY: s?.substation_y_m ?? 50,
    windWarn: s?.wind_warn_ms ?? 15, windCrit: s?.wind_crit_ms ?? 25,
    tank: s && s.tank_x_m !== null && s.tank_y_m !== null ? { x: s.tank_x_m, y: s.tank_y_m } : null,
  }
}

/** Carga los resúmenes de invernaderos (todos o los indicados) con estado, alertas, sparkline y KPIs del día. */
async function loadGreenhouseSummaries(db: Db, ids: readonly number[] | null, now: Date, geom: SiteGeometry): Promise<GreenhouseSummary[]> {
  const idArray = ids === null ? null : db.array([...ids], 21)
  const since6 = new Date(now.getTime() - 6 * 3600_000)
  const since24 = new Date(now.getTime() - 24 * 3600_000)
  const all = ids === null

  const [rows, alertRows, sparkRows, irrRows, optRows] = await Promise.all([
    db<GhRow[]>`
      select g.id, g.code, g.name, g.crop, g.x_m, g.y_m, g.area_m2,
             n.id as node_id, n.enabled,
             s.ts, s.temp_c, s.hum_air, s.soil_raw, s.soil_pct, s.light_lux, s.flow_lmin, s.pump_on, s.pump_state, s.pump_run_s, s.cooldown_s, s.faults,
             t.soil_on, t.soil_off, t.soil_sat, t.temp_max, t.temp_heat, t.temp_cold, t.temp_frost, t.hum_air_min, t.hum_air_max,
             t.pump_max_s, t.pump_wait_s, t.interval_s, t.auto_enabled, t.version, t.updated_at
        from iot.greenhouses g
        join iot.thresholds t on t.greenhouse_id = g.id
        left join iot.nodes n on n.greenhouse_id = g.id
        left join iot.node_state s on s.node_id = n.id
       where g.archived_at is null
         and (${all}::boolean or g.id = any(${idArray ?? db.array([], 21)}::smallint[]))
       order by g.id`,
    db<{ greenhouse_id: number; severity: 'critical' | 'warning' | 'info'; n: number }[]>`
      select greenhouse_id, severity, count(*)::int as n from iot.alerts
       where status <> 'resolved' and greenhouse_id is not null group by 1, 2`,
    db<{ greenhouse_id: number; b: Date; v: number | null }[]>`
      select greenhouse_id, date_bin('15 minutes', ts, timestamptz '2000-01-01') as b, round(avg(soil_raw))::int as v
        from iot.readings where ts > ${since6} and soil_raw is not null group by 1, 2 order by 1, 2`,
    db<{ greenhouse_id: number; n: number; water: number }[]>`
      select greenhouse_id, count(*)::int as n, coalesce(sum(water_l), 0)::float as water
        from iot.irrigation_events
       where started_at >= (date_trunc('day', ${now}::timestamptz at time zone 'America/Santiago') at time zone 'America/Santiago')
       group by 1`,
    db<{ greenhouse_id: number; p: number }[]>`
      select r.greenhouse_id, avg((r.soil_raw >= t.soil_sat and r.soil_raw < t.soil_on)::int)::float as p
        from iot.readings r join iot.thresholds t on t.greenhouse_id = r.greenhouse_id
       where r.ts > ${since24} and r.soil_raw is not null group by 1`,
  ])

  const alertsBy = new Map<number, { critical: number; warning: number; info: number }>()
  for (const a of alertRows) {
    const cur = alertsBy.get(a.greenhouse_id) ?? { critical: 0, warning: 0, info: 0 }
    cur[a.severity] += a.n
    alertsBy.set(a.greenhouse_id, cur)
  }
  const bucketMs = 15 * 60_000
  const firstBucket = Math.floor(since6.getTime() / bucketMs) * bucketMs
  const sparkBy = new Map<number, Map<number, number | null>>()
  for (const p of sparkRows) {
    const m = sparkBy.get(p.greenhouse_id) ?? new Map<number, number | null>()
    m.set(p.b.getTime(), p.v)
    sparkBy.set(p.greenhouse_id, m)
  }
  const irrBy = new Map(irrRows.map((r) => [r.greenhouse_id, r]))
  const optBy = new Map(optRows.map((r) => [r.greenhouse_id, r.p]))

  return rows.map((r): GreenhouseSummary => {
    const hasNode = r.node_id !== null
    const ageS = r.ts ? Math.max(0, Math.round((now.getTime() - r.ts.getTime()) / 1000)) : null
    const online = ageS !== null && ageS <= offlineAfterS(r.interval_s)
    const al = alertsBy.get(r.id) ?? { critical: 0, warning: 0, info: 0 }
    const status: GreenhouseStatus =
      !hasNode || r.ts === null ? 'nodata' : !online ? 'offline' : al.critical > 0 ? 'critical' : al.warning > 0 ? 'warning' : 'ok'
    const buckets = sparkBy.get(r.id)
    const dx = r.x_m - geom.substationX
    const dy = r.y_m - geom.substationY
    const irr = irrBy.get(r.id)
    const opt = optBy.get(r.id)
    return {
      id: r.id, code: r.code, name: r.name, crop: r.crop, x: r.x_m, y: r.y_m, areaM2: r.area_m2,
      distanceM: Math.round(Math.hypot(dx, dy)), hasNode, nodeEnabled: r.enabled ?? false,
      lastSeen: r.ts?.toISOString() ?? null, ageS, online, status,
      tempC: r.temp_c, humAir: r.hum_air, soilRaw: r.soil_raw, soilPct: r.soil_pct,
      band: r.soil_raw === null ? null : soilBand(r.soil_raw, { sat: r.soil_sat, on: r.soil_on }),
      lightLux: r.light_lux, flowLmin: r.flow_lmin, pumpOn: r.pump_on, pumpState: r.pump_state, pumpRunS: r.pump_run_s, cooldownS: r.cooldown_s,
      faults: r.faults ?? [], openAlerts: al, thresholds: toThresholdsDTO({
        soil_on: r.soil_on, soil_off: r.soil_off, soil_sat: r.soil_sat, temp_max: r.temp_max, temp_heat: r.temp_heat,
        temp_cold: r.temp_cold, temp_frost: r.temp_frost, hum_air_min: r.hum_air_min, hum_air_max: r.hum_air_max,
        pump_max_s: r.pump_max_s, pump_wait_s: r.pump_wait_s, interval_s: r.interval_s, auto_enabled: r.auto_enabled, version: r.version, updated_at: r.updated_at,
      }),
      soilSpark: Array.from({ length: 24 }, (_, i) => buckets?.get(firstBucket + i * bucketMs) ?? null),
      irrigationsToday: irr?.n ?? 0, waterTodayL: Math.round((irr?.water ?? 0) * 10) / 10,
      optimalPct24h: opt === undefined ? null : Math.round(opt * 100),
    }
  })
}

const avg = (xs: (number | null)[]): number | null => {
  const v = xs.filter((x): x is number => x !== null)
  return v.length === 0 ? null : v.reduce((a, b) => a + b, 0) / v.length
}
const round1 = (n: number | null) => (n === null ? null : Math.round(n * 10) / 10)

/** Panel principal: el predio completo (o los sectores del operador). */
export async function getSiteOverview(db: Db, actor: Actor, now = new Date()): Promise<SiteOverview> {
  if (!can(actor.role, 'site:view')) throw new ForbiddenError()
  const scope = scopeOf(actor)
  const ids = scope.all ? null : scope.ids
  // El barrido de nodos caídos es barato y no debe bloquear el panel si falla.
  await sweepOfflineNodes(db, now).catch(() => 0)
  const geom = await loadGeometry(db)
  const [greenhouses, activeAlerts, mast] = await Promise.all([
    loadGreenhouseSummaries(db, ids, now, geom),
    listAlerts(db, actor, { state: 'active', limit: 200 }),
    db<{ ts: Date | null; wind_ms: number | null }[]>`
      select s.ts, s.wind_ms from iot.nodes n join iot.node_state s on s.node_id = n.id where n.kind = 'mast' and n.enabled limit 1`,
  ])

  const m = mast[0]
  const windAge = m?.ts ? Math.round((now.getTime() - m.ts.getTime()) / 1000) : null
  const windOnline = windAge !== null && windAge <= offlineAfterS(MAST_INTERVAL_S)
  const windMs = windOnline ? (m?.wind_ms ?? null) : null
  const wind: WindSummary = {
    ms: windMs, ageS: windAge, online: windOnline, warn: geom.windWarn, crit: geom.windCrit,
    level: windMs === null ? 'nodata' : windMs >= geom.windCrit ? 'critical' : windMs >= geom.windWarn ? 'warning' : 'ok',
  }

  const count = (s: GreenhouseStatus) => greenhouses.filter((g) => g.status === s).length
  const live = greenhouses.filter((g) => g.online)
  return {
    siteName: geom.siteName, widthM: geom.widthM, heightM: geom.heightM,
    substation: { x: geom.substationX, y: geom.substationY }, tank: geom.tank, generatedAt: now.toISOString(),
    greenhouses, wind, recentAlerts: activeAlerts.slice(0, 8),
    kpis: {
      total: greenhouses.length, ok: count('ok'), warning: count('warning'), critical: count('critical'),
      offline: count('offline'), nodata: count('nodata'),
      pumpsOn: greenhouses.filter((g) => g.online && g.pumpOn === true).length,
      avgTempC: round1(avg(live.map((g) => g.tempC))), avgHumAir: round1(avg(live.map((g) => g.humAir))),
      avgSoilPct: round1(avg(live.map((g) => g.soilPct))),
      irrigationsToday: greenhouses.reduce((a, g) => a + g.irrigationsToday, 0),
      waterTodayL: Math.round(greenhouses.reduce((a, g) => a + g.waterTodayL, 0) * 10) / 10,
      activeAlerts: activeAlerts.length,
    },
  }
}

export interface GreenhouseDetail {
  summary: GreenhouseSummary
  series: SeriesBundle
  alerts: AlertDTO[]
  range: RangeKey
  geometry: SiteGeometry
}

/**
 * Resuelve el código a id (sin distinguir mayúsculas) y comprueba el alcance. Devuelve null si no existe, está
 * dado de baja o no le corresponde al usuario (para ellos «no existe»: no se revela nada).
 */
export async function resolveGreenhouse(db: Db, actor: Actor, code: string): Promise<number | null> {
  if (!can(actor.role, 'greenhouse:view')) return null
  if (!GREENHOUSE_CODE_RE.test(code)) return null
  const [g] = await db<{ id: number }[]>`select id from iot.greenhouses where lower(code) = lower(${code}) and archived_at is null`
  if (!g || !canAccessGreenhouse(actor, g.id)) return null
  return g.id
}

export async function getGreenhouseSeries(db: Db, actor: Actor, greenhouseId: number, range: RangeKey, now = new Date()): Promise<SeriesBundle> {
  if (!can(actor.role, 'history:view') || !canAccessGreenhouse(actor, greenhouseId)) throw new ForbiddenError()
  const spec = RANGE_SPECS[range]
  const from = new Date(now.getTime() - spec.ms)
  const withRssi = can(actor.role, 'devices:view')
  const [pts, events] = await Promise.all([
    db<{ b: Date; temp: number | null; hum: number | null; soil: number | null; soil_pct: number | null; light: number | null; rssi: number | null }[]>`
      select date_bin(make_interval(secs => ${spec.bucketS}), ts, timestamptz '2000-01-01') as b,
             avg(temp_c)::float as temp, avg(hum_air)::float as hum, avg(soil_raw)::float as soil,
             avg(soil_pct)::float as soil_pct, avg(light_lux)::float as light, avg(rssi)::float as rssi
        from iot.readings
       where greenhouse_id = ${greenhouseId} and ts >= ${from} and ts <= ${now}
       group by 1 order by 1`,
    db<{
      id: number; started_at: Date; ended_at: Date | null; duration_s: number | null; trigger: 'auto' | 'manual' | 'schedule'
      end_reason: string | null; water_l: number | null; soil_raw_start: number | null; soil_raw_end: number | null
    }[]>`
      select id, started_at, ended_at, duration_s, trigger, end_reason, water_l, soil_raw_start, soil_raw_end
        from iot.irrigation_events where greenhouse_id = ${greenhouseId} and started_at >= ${from}
       order by started_at desc limit 300`,
  ])
  const pick = (f: (p: (typeof pts)[number]) => number | null, digits: number): Point[] =>
    pts.map((p) => {
      const v = f(p)
      return [p.b.getTime(), v === null ? null : Math.round(v * 10 ** digits) / 10 ** digits]
    })
  return {
    from: from.getTime(), to: now.getTime(), bucketS: spec.bucketS,
    temp: pick((p) => p.temp, 1), humAir: pick((p) => p.hum, 1), soilRaw: pick((p) => p.soil, 0),
    soilPct: pick((p) => p.soil_pct, 1), light: pick((p) => p.light, 0),
    rssi: withRssi ? pick((p) => p.rssi, 0) : null,
    events: events.map((e): IrrigationEventDTO => ({
      id: e.id, startedAt: e.started_at.toISOString(), endedAt: e.ended_at?.toISOString() ?? null, durationS: e.duration_s,
      trigger: e.trigger, endReason: e.end_reason, waterL: e.water_l, soilRawStart: e.soil_raw_start, soilRawEnd: e.soil_raw_end,
    })),
  }
}

export async function getGreenhouseDetail(db: Db, actor: Actor, greenhouseId: number, range: RangeKey, now = new Date()): Promise<GreenhouseDetail> {
  if (!can(actor.role, 'greenhouse:view') || !canAccessGreenhouse(actor, greenhouseId)) throw new ForbiddenError()
  const geom = await loadGeometry(db)
  const [summaries, series, alerts] = await Promise.all([
    loadGreenhouseSummaries(db, [greenhouseId], now, geom),
    getGreenhouseSeries(db, actor, greenhouseId, range, now),
    listAlerts(db, actor, { greenhouseId, state: 'all', limit: 15 }),
  ])
  const summary = summaries[0]
  if (!summary) throw new ForbiddenError('Invernadero no encontrado.')
  return { summary, series, alerts, range, geometry: geom }
}

/** Exportación CSV del historial (permiso export:csv). Devuelve el texto listo para descargar. */
export async function exportReadingsCsv(db: Db, actor: Actor, greenhouseId: number, from: Date, to: Date): Promise<string> {
  if (!can(actor.role, 'export:csv') || !canAccessGreenhouse(actor, greenhouseId)) throw new ForbiddenError()
  const rows = await db<{ ts: Date; temp_c: number | null; hum_air: number | null; soil_raw: number | null; soil_pct: number | null; light_lux: number | null; pump_on: boolean | null }[]>`
    select ts, temp_c, hum_air, soil_raw, soil_pct, light_lux, pump_on from iot.readings
     where greenhouse_id = ${greenhouseId} and ts >= ${from} and ts <= ${to}
     order by ts limit 100000`
  const cell = (v: number | boolean | null) => (v === null ? '' : typeof v === 'boolean' ? (v ? '1' : '0') : String(v))
  const lines = ['timestamp_utc,temperatura_c,humedad_aire_pct,suelo_raw_0_1023,suelo_pct,luz_lux,bomba']
  for (const r of rows) {
    lines.push([r.ts.toISOString(), cell(r.temp_c), cell(r.hum_air), cell(r.soil_raw), cell(r.soil_pct), cell(r.light_lux), cell(r.pump_on)].join(','))
  }
  return `${lines.join('\n')}\n`
}
