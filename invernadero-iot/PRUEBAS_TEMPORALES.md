# Cambios temporales para pruebas (revertir antes de la entrega / producción)

Todo lo de esta lista se dejó así a propósito para poder probar la bomba sin sensores conectados. **Ninguno es la
configuración definitiva.** Marca cada punto cuando lo hayas revertido.

| # | Qué es | Dónde está | Valor de prueba | Valor definitivo | Cómo revertirlo |
|---|---|---|---|---|---|
| 1 | Umbral «Saturado bajo» del invernadero I1 | Base de datos (tabla `thresholds`, I1) · dashboard → I1 → **Umbrales** | `1` | `300` | Umbrales → «Saturado bajo» = 300 → Guardar (o «Restablecer por defecto» + Guardar) |
| 2 | Reporte del nodo cada… de I1 | Ídem (**Umbrales → Reporte del nodo**) | `5 s` (el mínimo; para ir rápido) | `300 s` | Ídem: «Reporte del nodo cada» = 300 → Guardar |
| 3 | Cuenta de súper administrador | Tabla `app_users` · `superadmin@invernadero.local` · migración `0004_superadmin_role.sql` · `dashboard/scripts/db-superadmin.ts` | existe, con riego sin confirmación | no debe existir en producción | Dashboard → **Usuarios** → desactivar la cuenta (o borrar la fila) |
| 5 | Consola por USB (`r`, `p`, `s`) activa | `nododefinitivo.ino` → `CONSOLA_SERIAL` (por defecto `1`) | `1` | `0` (el informe pide deshabilitar el puerto de depuración) | Descomentar `#define CONSOLA_SERIAL 0` y volver a subir |
| 6 | WiFi, IP del servidor y token del nodo escritos en el sketch | `nododefinitivo.ino` → `WIFI_SSID`, `WIFI_PASS`, `SERVER_URL`, `DEVICE_TOKEN` | red de pruebas + IP del PC (`192.168.1.26`) | los de la red y el servidor reales | Editar el bloque y volver a subir; no subir este archivo a un repositorio público |
| 7 | IP del PC permitida en modo desarrollo | `dashboard/next.config.ts` → `allowedDevOrigins` | `['192.168.1.26']` | solo aplica a `npm run dev:lan` (en producción no hace nada) | Quitar la línea o actualizar la IP si cambia |
| 8 | Envío de la pasarela a Supabase y refresco del dashboard muy frecuentes | `dashboard/scripts/gateway.ts` (`GATEWAY_FORWARD_S`, por defecto 2) · `dashboard/scripts/gateway.service` · `dashboard/src/components/ui/auto-refresh.tsx` (`everyMs`, 3 s) | `2 s` | `30–60 s` (envío) y `10 s` (refresco) | Poner `GATEWAY_FORWARD_S=60` en el servicio de la Pi y `everyMs = 10_000` en `auto-refresh.tsx` |
| 9 | Pausas del sketch más cortas | `nododefinitivo.ino` y `nodo_pico_w.ino`: `SUELO_ESTABILIZACION_MS` 40 (antes 300), `SUELO_ENTRE_MUESTRAS_MS` 2 (antes 20), `PERIODO_LOOP_MS` 1 (antes 10), `SEPARACION_MIN_MS` 1200 (antes 2000) | ver arriba | los de antes si la lectura del suelo sale inestable | Volver a 300 / 20 / 10 y subir el sketch |

Notas
- Con el sensor de suelo sin conectar, el nodo informa **falla del sensor** (lectura < 20) y no «suelo saturado». Mientras
  falle, solo funciona el riego manual (el automático queda bloqueado). Cuando conectes el YL-38, la lectura real
  (≈ 350 en agua, ≈ 1000 al aire) devuelve todo a la normalidad.
- Los puntos 1 y 2 quedan registrados en **Bitácora** (`thresholds.update`) con quién y cuándo los cambió.
- Los tests (`npm test`, `npm run test:db`) no dependen de estos valores.

- **Eliminado:** la opción `PRUEBA_SIN_DHT` (el nodo ignoraba la falla del DHT22) ya no existe en los sketches: ahora, sin temperatura válida, el riego automático se bloquea por seguridad.
- **Espera entre riegos = 0 en I1** (antes 300 s): el sistema acepta 0 (con una pausa técnica de 3 s del nodo). Para volver a proteger el motor, ponga 60–300 s en Umbrales de I1.
