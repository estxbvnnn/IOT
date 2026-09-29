/**
 * Geometría del predio: dónde caben los invernaderos.
 *
 * Módulo PURO (sin base de datos ni React), compartido por el servidor (valida posiciones), por el mapa
 * (dibuja) y por el formulario de alta (propone un lugar libre). Todo va en METROS, con origen en la esquina
 * superior izquierda del predio; la posición de un invernadero es su CENTRO.
 *
 * La cantidad de invernaderos NO es fija: el predio crece con ellos (ver «Ajustes del predio»), y este módulo
 * es lo que permite ubicar el siguiente sin superponerlo con los demás.
 */

/** Tamaño con que se dibuja cada invernadero (figura 2 del informe). */
export const GH_W = 19
export const GH_H = 11
/** Franja perimetral de árboles: no se propone ningún lugar dentro de ella. */
export const TREE_BAND = 6
/** Separación mínima deseable entre dos invernaderos (m). */
export const GH_GAP = 2
/** Alcance de diseño del gateway (informe, sección de cobertura): a mayor distancia el enlace no está garantizado. */
export const RADIO_DESIGN_RANGE_M = 71

export interface XY {
  x: number
  y: number
}

export interface SiteLayout {
  widthM: number
  heightM: number
  substation: XY
  /** Estanque de agua (opcional). */
  tank: XY | null
}

interface Rect {
  x0: number
  x1: number
  y0: number
  y1: number
}

/** Rango permitido para el CENTRO de un invernadero: el rectángulo completo debe quedar dentro del predio. */
export function centerBounds(site: Pick<SiteLayout, 'widthM' | 'heightM'>): { minX: number; maxX: number; minY: number; maxY: number } {
  return { minX: GH_W / 2, maxX: site.widthM - GH_W / 2, minY: GH_H / 2, maxY: site.heightM - GH_H / 2 }
}

export function insideSite(p: XY, site: Pick<SiteLayout, 'widthM' | 'heightM'>): boolean {
  const b = centerBounds(site)
  return p.x >= b.minX && p.x <= b.maxX && p.y >= b.minY && p.y <= b.maxY
}

/** ¿Se superponen dos invernaderos (con `gap` metros de holgura entre ellos)? */
export function greenhousesOverlap(a: XY, b: XY, gap = 0): boolean {
  return Math.abs(a.x - b.x) < GH_W + gap && Math.abs(a.y - b.y) < GH_H + gap
}

/** Primer elemento de `others` que se superpone con `p`, o null. */
export function findOverlap<T extends XY>(p: XY, others: readonly T[], gap = 0): T | null {
  return others.find((o) => greenhousesOverlap(p, o, gap)) ?? null
}

/** Distancia en línea recta de `p` a la subestación (m, redondeada). */
export function distanceToSubstation(p: XY, substation: XY): number {
  return Math.round(Math.hypot(p.x - substation.x, p.y - substation.y))
}

/**
 * Tamaño mínimo del predio para que quepan estos invernaderos. Sirve para impedir que «Ajustes del predio»
 * deje un invernadero fuera del mapa.
 */
export function requiredSiteSize(greenhouses: readonly XY[]): { widthM: number; heightM: number } {
  let w = 0
  let h = 0
  for (const g of greenhouses) {
    w = Math.max(w, g.x + GH_W / 2)
    h = Math.max(h, g.y + GH_H / 2)
  }
  return { widthM: Math.ceil(w), heightM: Math.ceil(h) }
}

/** Elementos fijos del mapa que un invernadero no debe tapar: la subestación con su rótulo y el estanque. */
function obstacles(site: SiteLayout): Rect[] {
  const { x: sx, y: sy } = site.substation
  const out: Rect[] = [{ x0: sx - 19.5, x1: sx + 19.5, y0: sy - 2.8, y1: sy + 12.4 }]
  if (site.tank) out.push({ x0: site.tank.x - 4.5, x1: site.tank.x + 4.5, y0: site.tank.y - 2.4, y1: site.tank.y + 5.4 })
  return out
}

function hitsObstacle(p: XY, r: Rect, gap: number): boolean {
  return p.x - GH_W / 2 - gap < r.x1 && p.x + GH_W / 2 + gap > r.x0 && p.y - GH_H / 2 - gap < r.y1 && p.y + GH_H / 2 + gap > r.y0
}

/**
 * Propone dónde poner el próximo invernadero: el lugar LIBRE más cercano a la subestación (el enlace de radio
 * se degrada con la distancia, así que el predio crece desde el mástil hacia afuera). Es determinista: ante un
 * empate gana el de más arriba y más a la izquierda. Devuelve null si el predio está lleno.
 *
 * `occupied` son los centros de los invernaderos ACTIVOS (los dados de baja liberan su lugar).
 */
export function suggestPosition(occupied: readonly XY[], site: SiteLayout): XY | null {
  const minX = Math.ceil(TREE_BAND + GH_W / 2 + 1)
  const maxX = Math.floor(site.widthM - TREE_BAND - GH_W / 2 - 1)
  const minY = Math.ceil(TREE_BAND + GH_H / 2 + 1)
  const maxY = Math.floor(site.heightM - TREE_BAND - GH_H / 2 - 1)
  if (minX > maxX || minY > maxY) return null

  // 1 m de paso en predios normales; más grueso en predios enormes para acotar el trabajo (~20 mil candidatos).
  const cells = (maxX - minX + 1) * (maxY - minY + 1)
  const step = Math.max(1, Math.ceil(Math.sqrt(cells / 20_000)))
  const blocked = obstacles(site)

  let best: XY | null = null
  let bestD = Infinity
  for (let y = minY; y <= maxY; y += step) {
    for (let x = minX; x <= maxX; x += step) {
      const p = { x, y }
      const d = Math.hypot(x - site.substation.x, y - site.substation.y)
      if (d >= bestD) continue // no mejora: se evita comprobar choques
      if (occupied.some((o) => greenhousesOverlap(p, o, GH_GAP))) continue
      if (blocked.some((r) => hitsObstacle(p, r, GH_GAP / 2))) continue
      best = p
      bestD = d
    }
  }
  return best
}
