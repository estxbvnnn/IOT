import clsx, { type ClassValue } from 'clsx'

/** Une clases condicionales (envoltorio mínimo de clsx). */
export function cn(...inputs: ClassValue[]): string {
  return clsx(inputs)
}
