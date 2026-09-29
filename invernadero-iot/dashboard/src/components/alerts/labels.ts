/** Nombres legibles de los tipos de alerta (los códigos vienen del motor de alertas). */
export const ALERT_TYPE_LABEL: Record<string, string> = {
  soil_dry: 'Suelo seco',
  soil_saturated: 'Suelo saturado',
  temp_high: 'Temperatura alta',
  temp_low: 'Temperatura baja o helada',
  hum_air_high: 'Humedad del aire alta',
  hum_air_low: 'Humedad del aire baja',
  wind_high: 'Viento fuerte',
  sensor_fault: 'Falla de sensor',
  node_offline: 'Nodo sin conexión',
  pump_anomaly: 'Riegos repetidos sin efecto',
}

export function alertTypeLabel(type: string): string {
  return ALERT_TYPE_LABEL[type] ?? type
}
