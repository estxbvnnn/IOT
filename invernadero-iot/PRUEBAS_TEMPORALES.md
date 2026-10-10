# Cambios temporales para pruebas (revertir antes de la entrega / producción)

Todo lo de esta lista se dejó así a propósito para poder probar la bomba sin sensores conectados. **Ninguno es la
configuración definitiva.** Marca cada punto cuando lo hayas revertido.

| # | Qué es | Dónde está | Valor de prueba | Valor definitivo | Cómo revertirlo |
|---|---|---|---|---|---|
| 1 | Umbral «Saturado bajo» del invernadero I1 | Base de datos (tabla `thresholds`, I1) · dashboard → I1 → **Umbrales** | `1` | `300` | Umbrales → «Saturado bajo» = 300 → Guardar (o «Restablecer por defecto» + Guardar) |
| 2 | Reporte del nodo cada… de I1 | Ídem (**Umbrales → Reporte del nodo**) | `10 s` | `300 s` | Ídem: «Reporte del nodo cada» = 300 → Guardar |
| 3 | Cuenta de súper administrador | Tabla `app_users` · `superadmin@invernadero.local` · migración `0004_superadmin_role.sql` · `dashboard/scripts/db-superadmin.ts` | existe, con riego sin confirmación | no debe existir en producción | Dashboard → **Usuarios** → desactivar la cuenta (o borrar la fila) |
| 4 | El nodo ignora la falla del DHT22 al decidir el riego | `firmware/nododefinitivo/nododefinitivo.ino` → `#define PRUEBA_SIN_DHT 1` (sección «CONFIGURACION DEL USUARIO») | `1` | `0` (o borrar la línea) | Cambiar a `0` y volver a subir el sketch |
| 5 | Consola por USB (`r`, `p`, `s`) activa | `nododefinitivo.ino` → `CONSOLA_SERIAL` (por defecto `1`) | `1` | `0` (el informe pide deshabilitar el puerto de depuración) | Descomentar `#define CONSOLA_SERIAL 0` y volver a subir |
| 6 | WiFi, IP del servidor y token del nodo escritos en el sketch | `nododefinitivo.ino` → `WIFI_SSID`, `WIFI_PASS`, `SERVER_URL`, `DEVICE_TOKEN` | red de pruebas + IP del PC (`192.168.1.26`) | los de la red y el servidor reales | Editar el bloque y volver a subir; no subir este archivo a un repositorio público |
| 7 | IP del PC permitida en modo desarrollo | `dashboard/next.config.ts` → `allowedDevOrigins` | `['192.168.1.26']` | solo aplica a `npm run dev:lan` (en producción no hace nada) | Quitar la línea o actualizar la IP si cambia |

Notas
- Con el sensor de suelo sin conectar, el nodo informa **falla del sensor** (lectura < 20) y no «suelo saturado». Mientras
  falle, solo funciona el riego manual (el automático queda bloqueado). Cuando conectes el YL-38, la lectura real
  (≈ 350 en agua, ≈ 1000 al aire) devuelve todo a la normalidad.
- Los puntos 1 y 2 quedan registrados en **Bitácora** (`thresholds.update`) con quién y cuándo los cambió.
- Los tests (`npm test`, `npm run test:db`) no dependen de estos valores.
