import { describe, expect, it } from 'vitest'
import { parseFrame } from '@/lib/ingest/normalize'
import { sanitizeFrame } from '@/lib/ingest/schema'

describe('flujo de agua (L/min)', () => {
  const frame = (x: Record<string, unknown>) => {
    const r = parseFrame({ seq: 1, ...x })
    if (!r.ok) throw new Error(r.detalle.join('; '))
    return r.frame
  }

  it('se guarda el campo flujo_lmin', () => {
    expect(sanitizeFrame(frame({ flujo_lmin: 1.75 })).flowLmin).toBe(1.75)
  })

  it.each(['flujo', 'flujo_agua', 'caudal', 'caudal_lmin', 'flow', 'flow_lmin', 'flow_rate', 'water_flow'])('entiende el nombre alternativo «%s»', (alias) => {
    expect(sanitizeFrame(frame({ [alias]: 2.5 })).flowLmin).toBe(2.5)
  })

  it('sin el campo queda en null y no es un error', () => {
    expect(sanitizeFrame(frame({})).flowLmin).toBeNull()
  })

  it('un caudal imposible se descarta y se registra la falla, sin perder la trama', () => {
    const s = sanitizeFrame(frame({ flujo_lmin: 999 }))
    expect(s.flowLmin).toBeNull()
    expect(s.faults).toContain('flujo_rango')
  })

  it('el campo ya no cae en «extra»', () => {
    const r = parseFrame({ seq: 1, flujo_lmin: 1, ph: 6 })
    expect(r.ok && r.extra).toEqual({ ph: 6 })
  })
})
