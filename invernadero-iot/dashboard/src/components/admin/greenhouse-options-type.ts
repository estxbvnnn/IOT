/** Tipo compartido con los componentes de cliente (greenhouse-options.ts es solo de servidor). */
export interface GreenhouseOption {
  id: number
  code: string
  name: string
  /** Dado de baja: solo se incluye si se pide explícitamente (para mostrar su código en las asignaciones antiguas). */
  archived: boolean
}
