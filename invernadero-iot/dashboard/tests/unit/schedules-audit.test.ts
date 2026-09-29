import { describe, expect, it } from 'vitest'
import { isScheduleDue, localParts, parseTimeLocal, scheduleInputSchema } from '@/lib/services/schedules'
import { redact } from '@/lib/services/audit'

describe('hora local del predio (America/Santiago)', () => {
  it('convierte UTC a hora local con día de la semana (UTC-3 en septiembre, horario de verano)', () => {
    // 2026-09-28 es lunes. 13:00 UTC = 10:00 en Santiago (UTC-3).
    expect(localParts(new Date('2026-09-28T13:00:00Z'))).toEqual({ date: '2026-09-28', dow: 1, minutes: 600 })
  })

  it('cruza la medianoche local correctamente', () => {
    // 02:30 UTC del martes 29 = 23:30 del lunes 28 en Santiago.
    expect(localParts(new Date('2026-09-29T02:30:00Z'))).toEqual({ date: '2026-09-28', dow: 1, minutes: 23 * 60 + 30 })
  })

  it('en invierno el desfase es UTC-4', () => {
    // 2026-07-15 es miércoles; 12:00 UTC = 08:00 en Santiago.
    expect(localParts(new Date('2026-07-15T12:00:00Z'))).toEqual({ date: '2026-07-15', dow: 3, minutes: 480 })
  })

  it('parseTimeLocal lee HH:MM y HH:MM:SS', () => {
    expect(parseTimeLocal('06:30')).toBe(390)
    expect(parseTimeLocal('06:30:00')).toBe(390)
    expect(Number.isNaN(parseTimeLocal('mal'))).toBe(true)
  })
})

describe('calendarios de riego: cuándo corresponde ejecutar', () => {
  const sched = { enabled: true, days: [1, 3, 5], timeLocal: '10:00', lastRunDate: null as string | null }
  const at = (iso: string) => new Date(iso)

  it('se ejecuta el día y a la hora programados', () => {
    expect(isScheduleDue(sched, at('2026-09-28T13:00:00Z'))).toBe(true) // lunes 10:00
    expect(isScheduleDue(sched, at('2026-09-28T13:29:00Z'))).toBe(true) // dentro de los 30 min de gracia
  })

  it('no se ejecuta antes de la hora, pasada la gracia, ni en un día no programado', () => {
    expect(isScheduleDue(sched, at('2026-09-28T12:59:00Z'))).toBe(false) // 09:59
    expect(isScheduleDue(sched, at('2026-09-28T13:30:00Z'))).toBe(false) // 10:30, ya venció
    expect(isScheduleDue(sched, at('2026-09-29T13:00:00Z'))).toBe(false) // martes
  })

  it('una sola vez por día', () => {
    expect(isScheduleDue({ ...sched, lastRunDate: '2026-09-28' }, at('2026-09-28T13:05:00Z'))).toBe(false)
    expect(isScheduleDue({ ...sched, lastRunDate: '2026-09-21' }, at('2026-09-28T13:05:00Z'))).toBe(true)
  })

  it('un calendario deshabilitado nunca se ejecuta', () => {
    expect(isScheduleDue({ ...sched, enabled: false }, at('2026-09-28T13:00:00Z'))).toBe(false)
  })

  it('valida la entrada del formulario', () => {
    expect(scheduleInputSchema.safeParse({ days: [3, 1, 1], timeLocal: '06:00', durationS: 20 }).data?.days).toEqual([1, 3])
    expect(scheduleInputSchema.safeParse({ days: [], timeLocal: '06:00', durationS: 20 }).success).toBe(false)
    expect(scheduleInputSchema.safeParse({ days: [1], timeLocal: '25:00', durationS: 20 }).success).toBe(false)
    expect(scheduleInputSchema.safeParse({ days: [1], timeLocal: '06:00', durationS: 500 }).success).toBe(false)
    expect(scheduleInputSchema.safeParse({ days: [7], timeLocal: '06:00', durationS: 20 }).success).toBe(false)
  })
})

describe('la bitácora nunca guarda secretos', () => {
  it('oculta contraseñas, tokens y secretos a cualquier profundidad', () => {
    const out = redact({
      email: 'a@b.cl', password: 'x', nested: { token: 'y', totp_secret: 'z', ok: 1 },
      list: [{ authorization: 'Bearer q', name: 'n' }], Cookie: 'c',
    }) as Record<string, unknown>
    expect(out.email).toBe('a@b.cl')
    expect(out.password).toBe('[oculto]')
    expect(out.nested).toEqual({ token: '[oculto]', totp_secret: '[oculto]', ok: 1 })
    expect(out.list).toEqual([{ authorization: '[oculto]', name: 'n' }])
    expect(out.Cookie).toBe('[oculto]')
  })

  it('acota textos largos, listas grandes y profundidad', () => {
    const out = redact({ big: 'x'.repeat(1000), arr: Array.from({ length: 50 }, (_, i) => i), deep: { a: { b: { c: { d: 1 } } } } }) as Record<string, unknown>
    expect((out.big as string).length).toBeLessThan(400)
    expect((out.arr as unknown[]).length).toBe(20)
    expect(JSON.stringify(out.deep)).toContain('[…]')
  })

  it('maneja null y undefined', () => {
    expect(redact(null)).toBeNull()
    expect(redact(undefined)).toBeNull()
  })
})
