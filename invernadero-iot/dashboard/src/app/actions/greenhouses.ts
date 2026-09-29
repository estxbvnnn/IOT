'use server'

import { refresh } from 'next/cache'
import { z } from 'zod'
import { type ActionResult, fail, run } from '@/lib/actions/result'
import { getDb } from '@/lib/db'
import { getRequestMeta, requireUser } from '@/lib/dal'
import { MAX_GREENHOUSE_ID } from '@/lib/domain/greenhouse'
import type { ManagedGreenhouseDTO, SiteSettingsDTO } from '@/lib/domain/types'
import {
  type ArchiveSummary, type CreatedGreenhouse, archiveGreenhouse, createGreenhouse, restoreGreenhouse,
  updateGreenhouse, updateSiteSettings,
} from '@/lib/services/greenhouses'

/**
 * Administración de invernaderos (la cantidad NO es fija) y ajustes del predio. Solo el administrador
 * (permiso greenhouses:manage): cada acción vuelve a verificar la sesión y el permiso en el servicio, porque las
 * acciones del servidor se pueden invocar directamente con un POST aunque la interfaz no muestre el botón.
 */

const ghId = z.number().int().min(1).max(MAX_GREENHOUSE_ID)

/** Alta: crea el invernadero, sus umbrales y su nodo. El token del nodo se devuelve UNA sola vez. */
export async function createGreenhouseAction(input: unknown): Promise<ActionResult<CreatedGreenhouse>> {
  const admin = await requireUser()
  const meta = await getRequestMeta()
  const res = await run(() => createGreenhouse(getDb(), admin, input, meta.ip))
  if (res.ok) refresh()
  return res
}

export async function updateGreenhouseAction(id: number, input: unknown): Promise<ActionResult<ManagedGreenhouseDTO>> {
  const admin = await requireUser()
  if (!ghId.safeParse(id).success) return fail('Invernadero inválido.')
  const meta = await getRequestMeta()
  const res = await run(() => updateGreenhouse(getDb(), admin, id, input, meta.ip))
  if (res.ok) refresh()
  return res
}

/** Baja lógica: se conserva todo el historial y se puede reactivar. */
export async function archiveGreenhouseAction(id: number): Promise<ActionResult<ArchiveSummary>> {
  const admin = await requireUser()
  if (!ghId.safeParse(id).success) return fail('Invernadero inválido.')
  const meta = await getRequestMeta()
  const res = await run(() => archiveGreenhouse(getDb(), admin, id, meta.ip))
  if (res.ok) refresh()
  return res
}

export async function restoreGreenhouseAction(id: number): Promise<ActionResult<{ changed: boolean }>> {
  const admin = await requireUser()
  if (!ghId.safeParse(id).success) return fail('Invernadero inválido.')
  const meta = await getRequestMeta()
  const res = await run(() => restoreGreenhouse(getDb(), admin, id, meta.ip))
  if (res.ok) refresh()
  return res
}

export async function updateSiteSettingsAction(input: unknown): Promise<ActionResult<SiteSettingsDTO>> {
  const admin = await requireUser()
  const meta = await getRequestMeta()
  const res = await run(() => updateSiteSettings(getDb(), admin, input, meta.ip))
  if (res.ok) refresh()
  return res
}
