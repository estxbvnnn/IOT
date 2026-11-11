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
| 5 | **Modo abierto de la pasarela** (sin tokens: cualquier identificador crea su invernadero) | `ACEPTAR_NODOS_NUEVOS=1` en `.env.pc` (PC) y, **desde el 11-nov-2026, en `~/invernadero-iot/.env` de la Raspberry Pi** (respaldo del `.env` anterior: `~/env.respaldo-antes-modo-abierto`) → `docker-compose.yml` → `dashboard/src/lib/services/open-nodes.ts` | `1` | `0` (cada nodo con su token creado en el dashboard) | Borrar `.env.pc` o poner `ACEPTAR_NODOS_NUEVOS=0` y `docker compose up -d gateway` |
| 6 | Puertos 3100 y 3000 abiertos en el firewall de Windows | Regla «IoT pasarela PC (prueba)» | abierta | cerrada | `.\scripts\firewall-pasarela-pc.ps1 -Cerrar` (como administrador); con `-Abrir -Horas N` se cierra sola |
| 9 | WiFi, IP del PC y servidor (solo `PERFIL 2`, nodo con WiFi) | `firmware/malla_espnow/config_local.h` (fuera de git) | red de pruebas + IP del PC | los de la red y la Pi reales | Editar el archivo y volver a subir. Los perfiles 0 y 1 no usan WiFi |
| 10 | Sensores **simulados** en el nodo (temperatura, humedad, suelo y flujo de agua) | `firmware/malla_espnow/malla_espnow.ino` → `armarJson`, `USAR_SENSOR_FLUJO` | valores aleatorios | lecturas reales (DHT22, YL-38, YF-S201 con `USAR_SENSOR_FLUJO 1`) | Reemplazar las lecturas en `armarJson` y volver a subir |
| 11 | «AWS de prueba» y su clave | `npm run aws:mock` · `secrets/aws-mock-*.pem` · `AWS_UPLINK_URL` / `AWS_PUBLIC_KEY_FILE` en el entorno de `uplink` | servidor simulado en el PC (puerto 4010) | la URL real de AWS y su clave pública | Parar `aws:mock`, borrar `secrets/aws-mock-*`, definir las variables reales en `.env` y `docker compose up -d uplink` |
| 12 | Invernaderos de prueba en la base local **del PC** (`GRUPO-A`, `GRUPO-B`, `I-FLUJO`, `I-PUENTE`) | Base local de Docker del PC | existen, con pocas lecturas | no deben existir | Archivarlos desde el dashboard, o `docker compose down -v` para empezar de cero |
| 13 | Invernaderos de las pruebas con placas en la **Pi** (`GrupoSavka`, `Invernadero-DiazRamos` / `I16`) y los ya **archivados** (`I1`–`I10`, `nodo-85bbc8`, `nodo-63c927`, `grupo-1`, `Grupo-3`) | Base de la Pi (`iot.greenhouses`, `archived_at`) | los dos primeros activos | solo los invernaderos reales | Archivar los de prueba desde el dashboard (los archivados se restauran desde la misma pantalla) |
| 14 | Un chip puede renombrar su invernadero (modo abierto) | `dashboard/src/lib/services/open-nodes.ts` (`renameOpenNode`) · tabla `iot.open_devices` (migración `0012`) | activo mientras `ACEPTAR_NODOS_NUEVOS=1` | no existe en el modo normal (cada nodo con su token) | Se apaga solo con `ACEPTAR_NODOS_NUEVOS=0` |
| 15 | Concentrador conectado al **PC** (no a la Pi) con el puente en una terminal | `npm run puente -- COM6` con `GATEWAY_URL=http://<ip-de-la-pi>:3100` | puente manual en el PC | servicio `puente` en la Pi (`CONCENTRADOR_DEV=/dev/ttyUSB0 docker compose --profile concentrador up -d puente`) | Conectar el concentrador a la Pi y arrancar el servicio |
| 16 | **Credenciales versionadas en un repositorio público** (`dashboard/.env.local`, `dashboard/.env.admin.local`) | Commit `3bc8ed9` y ramas `origin/main` y `origin/pi-postgres-local` | contraseñas de Supabase y `APP_SECRET` expuestas | secretos solo en archivos ignorados | Rotar las contraseñas de Supabase (usuario `iot_app` y administrador) y `APP_SECRET`; `git rm --cached` de esos dos archivos; quitar el historial solo si se decide reescribirlo |

Notas
- Con el sensor de suelo sin conectar, el nodo informa **falla del sensor** (lectura < 20) y no «suelo saturado». Mientras
  falle, solo funciona el riego manual (el automático queda bloqueado). Cuando conectes el YL-38, la lectura real
  (≈ 350 en agua, ≈ 1000 al aire) devuelve todo a la normalidad.
- Los puntos 1 y 2 quedan registrados en **Bitácora** (`thresholds.update`) con quién y cuándo los cambió.
- Los tests (`npm test`, `npm run test:db`) no dependen de estos valores.

- **Eliminado:** la opción `PRUEBA_SIN_DHT` (el nodo ignoraba la falla del DHT22) ya no existe en los sketches: ahora, sin temperatura válida, el riego automático se bloquea por seguridad.
- **Espera entre riegos = 0 en I1** (antes 300 s): el sistema acepta 0 (con una pausa técnica de 3 s del nodo). Para volver a proteger el motor, ponga 60–300 s en Umbrales de I1.
