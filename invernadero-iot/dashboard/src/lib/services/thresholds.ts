import { z } from 'zod'
import type { Db } from '../db/types'
import { inTransaction } from '../db/types'
import { type Actor, assertCanOnGreenhouse } from '../rbac'
import type { ThresholdsDTO } from '../domain/types'
import { audit } from './audit'

/**
 * Umbrales de riego y de alertas por invernadero. Los ajusta el agrónomo (o el administrador) y
 * viajan al nodo dentro de `cfg` en la respuesta de cada trama; el nodo los guarda y además aplica
 * sus propios límites duros (ver docs/contrato-api.md §6).
 */

const round1 = (n: number) => Math.round(n * 10) / 10

export const thresholdsSchema = z
  .object({
    soilOn: z.number().int().min(2).max(1023),
    soilOff: z.number().int().min(1).max(1022),
    soilSat: z.number().int().min(0).max(1021),
    tempMax: z.number().min(30).max(60).transform(round1),
    tempHeat: z.number().min(-20).max(60).transform(round1),
    tempCold: z.number().min(-20).max(60).transform(round1),
    tempFrost: z.number().min(-20).max(60).transform(round1),
    humAirMin: z.number().min(0).max(100).transform(round1),
    humAirMax: z.number().min(0).max(100).transform(round1),
    pumpMaxS: z.number().int().min(5).max(120),
    pumpWaitS: z.number().int().min(60).max(3600),
    intervalS: z.number().int().min(5).max(3600),
  })
  .superRefine((t, ctx) => {
    if (!(t.soilSat < t.soilOff && t.soilOff < t.soilOn)) {
      ctx.addIssue({ code: 'custom', path: ['soilOff'], message: 'Debe cumplirse: saturado < apagar < regar (escala 0–1023).' })
    }
    if (!(t.tempFrost < t.tempCold && t.tempCold < t.tempHeat && t.tempHeat <= t.tempMax)) {
      ctx.addIssue({ code: 'custom', path: ['tempHeat'], message: 'Debe cumplirse: helada < frío < calor ≤ máxima de riego.' })
    }
    if (!(t.humAirMin < t.humAirMax)) {
      ctx.addIssue({ code: 'custom', path: ['humAirMin'], message: 'La humedad mínima debe ser menor que la máxima.' })
    }
  })
export type ThresholdsInput = z.infer<typeof thresholdsSchema>

/** Entrada parcial desde la interfaz: solo estructura; los rangos y la coherencia los valida updateThresholds. */
export const thresholdsPatchSchema = z.object({
  soilOn: z.number().finite().optional(),
  soilOff: z.number().finite().optional(),
  soilSat: z.number().finite().optional(),
  tempMax: z.number().finite().optional(),
  tempHeat: z.number().finite().optional(),
  tempCold: z.number().finite().optional(),
  tempFrost: z.number().finite().optional(),
  humAirMin: z.number().finite().optional(),
  humAirMax: z.number().finite().optional(),
  pumpMaxS: z.number().finite().optional(),
  pumpWaitS: z.number().finite().optional(),
  intervalS: z.number().finite().optional(),
}).strict()

export class ValidationError extends Error {
  constructor(public readonly fieldErrors: Record<string, string>, message = 'Revisa los valores ingresados.') {
    super(message)
    this.name = 'ValidationError'
  }
}

interface ThresholdRow {
  soil_on: number
  soil_off: number
  soil_sat: number
  temp_max: number
  temp_heat: number
  temp_cold: number
  temp_frost: number
  hum_air_min: number
  hum_air_max: number
  pump_max_s: number
  pump_wait_s: number
  interval_s: number
  version: number
  updated_at: Date
}

export const toThresholdsDTO = (r: ThresholdRow): ThresholdsDTO => ({
  soilOn: r.soil_on, soilOff: r.soil_off, soilSat: r.soil_sat, tempMax: r.temp_max, tempHeat: r.temp_heat,
  tempCold: r.temp_cold, tempFrost: r.temp_frost, humAirMin: r.hum_air_min, humAirMax: r.hum_air_max,
  pumpMaxS: r.pump_max_s, pumpWaitS: r.pump_wait_s, intervalS: r.interval_s, version: r.version, updatedAt: r.updated_at.toISOString(),
})

const FIELDS = ['soilOn', 'soilOff', 'soilSat', 'tempMax', 'tempHeat', 'tempCold', 'tempFrost', 'humAirMin', 'humAirMax', 'pumpMaxS', 'pumpWaitS', 'intervalS'] as const

export async function updateThresholds(
  db: Db, actor: Actor, greenhouseId: number, patch: Partial<ThresholdsInput>, ip: string | null = null, now = new Date(),
): Promise<ThresholdsDTO> {
  assertCanOnGreenhouse(actor, 'thresholds:edit', greenhouseId)
  return inTransaction(db, async (tx) => {
    const [cur] = await tx<ThresholdRow[]>`select * from iot.thresholds where greenhouse_id = ${greenhouseId} for update`
    if (!cur) throw new ValidationError({}, 'Invernadero no encontrado.')
    const before = toThresholdsDTO(cur)
    const merged = { ...before, ...patch }
    const parsed = thresholdsSchema.safeParse(FIELDS.reduce<Record<string, unknown>>((acc, k) => ({ ...acc, [k]: merged[k] }), {}))
    if (!parsed.success) {
      const fe: Record<string, string> = {}
      for (const i of parsed.error.issues) fe[String(i.path[0] ?? 'form')] ??= i.message
      throw new ValidationError(fe)
    }
    const v = parsed.data
    const changed = FIELDS.filter((k) => v[k] !== before[k])
    if (changed.length === 0) return before
    const [row] = await tx<ThresholdRow[]>`
      update iot.thresholds set
        soil_on = ${v.soilOn}, soil_off = ${v.soilOff}, soil_sat = ${v.soilSat}, temp_max = ${v.tempMax},
        temp_heat = ${v.tempHeat}, temp_cold = ${v.tempCold}, temp_frost = ${v.tempFrost},
        hum_air_min = ${v.humAirMin}, hum_air_max = ${v.humAirMax}, pump_max_s = ${v.pumpMaxS},
        pump_wait_s = ${v.pumpWaitS}, interval_s = ${v.intervalS},
        version = version + 1, updated_at = ${now}, updated_by = ${actor.id}
       where greenhouse_id = ${greenhouseId}
      returning *`
    await audit(tx, {
      actorId: actor.id, actorLabel: actor.email, actorRole: actor.role, action: 'thresholds.update',
      target: `greenhouse:${greenhouseId}`, ip,
      detail: { changes: Object.fromEntries(changed.map((k) => [k, { from: before[k], to: v[k] }])), version: row!.version },
    })
    return toThresholdsDTO(row!)
  })
}
