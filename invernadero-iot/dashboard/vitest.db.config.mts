import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

/**
 * Pruebas contra la base real de Supabase (npm run test:db).
 * Cada prueba corre dentro de una transacción que se revierte: no dejan datos.
 * Requiere haber ejecutado antes `npm run db:migrate` y `npm run db:seed`.
 */
export default defineConfig({
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  test: {
    environment: 'node',
    include: ['tests/db/**/*.test.ts'],
    setupFiles: ['tests/db/setup.ts'],
    testTimeout: 90_000,
    hookTimeout: 90_000,
    fileParallelism: false,
    pool: 'forks',
  },
})
