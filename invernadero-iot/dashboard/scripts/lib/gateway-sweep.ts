import type { Db } from '../../src/lib/db/types'
import { sweepOfflineNodes } from '../../src/lib/services/alerts'

/** Barrido de «nodo sin conexión» (en el dashboard solo corre si alguien lo abre o llega una trama directa). */
export async function alertsSweep(db: Db): Promise<void> {
  await sweepOfflineNodes(db, new Date())   // con su limite interno (1 vez cada 20 s)
}
