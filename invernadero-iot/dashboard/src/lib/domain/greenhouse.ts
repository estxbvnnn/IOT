/**
 * Reglas de identificación de un invernadero, compartidas por el servidor, las rutas y los formularios.
 * Módulo PURO (sin base de datos ni React).
 */

/**
 * Código legible de un invernadero (I1, I2, Tomates-Norte…): va en la URL y en el nombre del CSV, por eso es
 * corto y restringido. Debe empezar con una letra. Es único sin distinguir mayúsculas y no cambia después del alta.
 */
export const GREENHOUSE_CODE_RE = /^[A-Za-z][A-Za-z0-9_-]{0,15}$/

export const GREENHOUSE_CODE_HELP = 'Entre 1 y 16 caracteres: letras, números, guion o guion bajo, y debe empezar con una letra.'

/** El identificador interno es un smallint: este es el máximo que admite la base. */
export const MAX_GREENHOUSE_ID = 32767

/**
 * Código automático «I<id>». Si otro invernadero (con un código elegido a mano) ya lo usa, se prueba «I<id>-2»,
 * «I<id>-3»… `taken` contiene los códigos existentes en minúsculas. Devuelve null si no encuentra uno libre.
 */
export function defaultGreenhouseCode(id: number, taken: ReadonlySet<string>): string | null {
  for (let n = 1; n <= 9; n++) {
    const code = n === 1 ? `I${id}` : `I${id}-${n}`
    if (!taken.has(code.toLowerCase())) return code
  }
  return null
}
