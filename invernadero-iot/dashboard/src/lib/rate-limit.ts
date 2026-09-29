/**
 * Limitador de tasa en memoria (ventana fija). Protege el inicio de sesión y la recepción de telemetría
 * contra ráfagas y fuerza bruta. Es «de mejor esfuerzo»: cada instancia del servidor lleva su propio
 * contador (en serverless o con varias réplicas conviene respaldarlo con una tabla o un servicio compartido).
 * El bloqueo por cuenta (5 fallos → 15 min) sí es global porque vive en la base de datos.
 */
export interface LimitResult {
  ok: boolean
  /** Segundos hasta que se libera la ventana (solo si `ok` es false). */
  retryAfterS: number
  remaining: number
}

export interface Limiter {
  hit(key: string, now?: number): LimitResult
  reset(key: string): void
}

export function createLimiter(opts: { windowMs: number; max: number; maxKeys?: number }): Limiter {
  const hits = new Map<string, { count: number; resetAt: number }>()
  const maxKeys = opts.maxKeys ?? 10_000
  return {
    hit(key, now = Date.now()) {
      let e = hits.get(key)
      if (!e || e.resetAt <= now) {
        if (hits.size >= maxKeys) {
          for (const [k, v] of hits) if (v.resetAt <= now) hits.delete(k)
          if (hits.size >= maxKeys) hits.clear() // último recurso: evitar crecimiento sin límite
        }
        e = { count: 0, resetAt: now + opts.windowMs }
        hits.set(key, e)
      }
      e.count++
      const ok = e.count <= opts.max
      return { ok, retryAfterS: ok ? 0 : Math.max(1, Math.ceil((e.resetAt - now) / 1000)), remaining: Math.max(0, opts.max - e.count) }
    },
    reset(key) {
      hits.delete(key)
    },
  }
}
