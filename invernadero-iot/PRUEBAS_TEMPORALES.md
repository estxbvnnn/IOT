# Cambios temporales para pruebas (revertir antes de la entrega / producción)

Todo lo de esta lista se dejó así a propósito para poder probar la bomba sin sensores conectados. **Ninguno es la
configuración definitiva.** Marca cada punto cuando lo hayas revertido.

| # | Qué es | Dónde está | Valor de prueba | Valor definitivo | Cómo revertirlo |
|---|---|---|---|---|---|
| 1 | Umbral «Saturado bajo» del invernadero I1 | Base de datos (tabla `thresholds`, I1) · dashboard → I1 → **Umbrales** | `1` | `300` | Umbrales → «Saturado bajo» = 300 → Guardar (o «Restablecer por defecto» + Guardar) |
| 2 | Reporte del nodo cada… de I1 | Ídem (**Umbrales → Reporte del nodo**) | `5 s` (el mínimo; para ir rápido) | `300 s` | Ídem: «Reporte del nodo cada» = 300 → Guardar |
| 3 | Cuenta de súper administrador | Tabla `app_users` · `superadmin@invernadero.local` · migración `0004_superadmin_role.sql` · `dashboard/scripts/db-superadmin.ts` | existe, con riego sin confirmación | no debe existir en producción | Dashboard → **Usuarios** → desactivar la cuenta (o borrar la fila) |
| 7 | IP del PC permitida en modo desarrollo | `dashboard/next.config.ts` → `allowedDevOrigins` | `['192.168.1.26']` | solo aplica a `npm run dev:lan` (en producción no hace nada) | Quitar la línea o actualizar la IP si cambia |
| 8 | Refresco automático del dashboard muy frecuente (la copia de la Pi a Supabase ya NO es de prueba: 5 min por defecto, `SYNC_INTERVAL_S`) | `dashboard/src/components/ui/auto-refresh.tsx` (`everyMs`, 3 s) | `3 s` | `10 s` | Subir `everyMs` a 10 000 |
| 5 | **Modo abierto de la pasarela** (sin tokens: cualquier identificador crea su invernadero) | `ACEPTAR_NODOS_NUEVOS=1` en `.env.pc` (PC) → `docker-compose.yml` → `dashboard/src/lib/services/open-nodes.ts` | `1` | `0` (cada nodo con su token creado en el dashboard) | Borrar `.env.pc` o poner `ACEPTAR_NODOS_NUEVOS=0` y `docker compose up -d gateway` |
| 6 | Puertos 3100 y 3000 abiertos en el firewall de Windows | Regla «IoT pasarela PC (prueba)» | abierta | cerrada | `.scriptsirewall-pasarela-pc.ps1 -Cerrar` (como administrador); con `-Abrir -Horas N` se cierra sola |
| 9 | WiFi, IP del PC y servidor escritos en el sketch de la malla | `firmware/malla_espnow/malla_espnow.ino` → `WIFI_SSID`, `WIFI_PASS`, `GATEWAY_HOST` | red de pruebas + IP del PC | los de la red y la Pi reales | Editar el bloque y volver a subir; no subir este archivo con la clave del WiFi a un repositorio público |

Notas
- Con el sensor de suelo sin conectar, el nodo informa **falla del sensor** (lectura < 20) y no «suelo saturado». Mientras
  falle, solo funciona el riego manual (el automático queda bloqueado). Cuando conectes el YL-38, la lectura real
  (≈ 350 en agua, ≈ 1000 al aire) devuelve todo a la normalidad.
- Los puntos 1 y 2 quedan registrados en **Bitácora** (`thresholds.update`) con quién y cuándo los cambió.
- Los tests (`npm test`, `npm run test:db`) no dependen de estos valores.

- **Eliminado:** la opción `PRUEBA_SIN_DHT` (el nodo ignoraba la falla del DHT22) ya no existe en los sketches: ahora, sin temperatura válida, el riego automático se bloquea por seguridad.
- **Espera entre riegos = 0 en I1** (antes 300 s): el sistema acepta 0 (con una pausa técnica de 3 s del nodo). Para volver a proteger el motor, ponga 60–300 s en Umbrales de I1.
