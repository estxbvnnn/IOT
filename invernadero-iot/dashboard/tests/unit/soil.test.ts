import { describe, expect, it } from 'vitest'
import { DEFAULT_SOIL_LIMITS, SOIL_BAND_INFO, soilBand, soilPct } from '@/lib/domain/soil'

describe('bandas del YL-38 (tabla de la clase, escala 0–1023)', () => {
  it('0–299 = saturado, 300–699 = óptimo, 700–1023 = seco', () => {
    expect(soilBand(0)).toBe('saturado')
    expect(soilBand(299)).toBe('saturado')
    expect(soilBand(300)).toBe('optimo')
    expect(soilBand(500)).toBe('optimo')
    expect(soilBand(699)).toBe('optimo')
    expect(soilBand(700)).toBe('seco')
    expect(soilBand(1023)).toBe('seco')
  })

  it('respeta límites personalizados del agrónomo', () => {
    expect(soilBand(650, { sat: 300, on: 600 })).toBe('seco')
    expect(soilBand(350, { sat: 400, on: 700 })).toBe('saturado')
  })

  it('los límites por defecto son los de la imagen', () => {
    expect(DEFAULT_SOIL_LIMITS).toEqual({ sat: 300, on: 700 })
    expect(SOIL_BAND_INFO.seco.advice).toBe('Regar.')
    expect(SOIL_BAND_INFO.saturado.advice).toBe('No regar.')
  })
})

describe('porcentaje de humedad', () => {
  it('interpola entre aire (0 %) y agua (100 %); a mayor lectura, más seco', () => {
    expect(soilPct(1023)).toBe(0)
    expect(soilPct(0)).toBe(100)
    expect(soilPct(512)).toBeCloseTo(50, 0)
    expect(soilPct(700)).toBeLessThan(soilPct(500))
  })

  it('usa la calibración del nodo y acota a 0–100', () => {
    expect(soilPct(800, 800, 325)).toBe(0)
    expect(soilPct(325, 800, 325)).toBe(100)
    expect(soilPct(900, 800, 325)).toBe(0)
    expect(soilPct(100, 800, 325)).toBe(100)
  })

  it('una calibración inválida no produce NaN', () => {
    expect(soilPct(500, 300, 300)).toBe(0)
  })
})
