# API REST `/api/v1` (Raspberry Pi)

API de lectura y control del invernadero, en la **red local** de la Pi: `http://IP_DE_LA_PI:3000/api/v1`. Todas las respuestas son JSON con `"ok": true|false`
(en error: `{"ok":false,"error":"<código>"}`). Funciona sin internet.

## Autenticación
Dos formas, equivalentes en permisos (los del **usuario** dueño de la clave: rol y sectores, igual que en la interfaz):

1. **Clave de API** (para otras aplicaciones): cabecera `Authorization: Bearer iotk_…`. Se crea en la Pi:
   ```bash
   docker compose run --rm tools crear correo@del-usuario.cl "Mi aplicación"   # muestra la clave UNA sola vez
   docker compose run --rm tools listar
   docker compose run --rm tools revocar <id>
   ```
   La clave actúa como ese usuario; elija uno con el rol justo (dueño/técnico = solo lectura; operador = lectura + riego en sus sectores; admin = todo). El
   súper administrador de pruebas no puede tener claves. En la base solo queda el SHA-256 de la clave.
2. **Sesión del dashboard** (cookie), para que la propia interfaz consuma la API.

Los `POST` deben llevar `Content-Type: application/json`. Límites: 600 peticiones/min por origen y 20 claves inválidas/min.

| Código | Significa |
|---|---|
| 200 / 201 | Correcto / orden registrada |
| 400 | Datos inválidos (`detalle` o `mensaje` lo explican) |
| 401 | Sin clave, clave inválida, o contraseña incorrecta en la confirmación |
| 403 | La clave no tiene permiso para eso |
| 404 | No existe, o no está en el alcance del usuario |
| 409 | Ya hay una orden en curso, o el invernadero no tiene nodo habilitado |
| 410 / 415 / 429 | Orden vencida / falta `Content-Type: application/json` / demasiadas peticiones |

## Lectura
| Método y ruta | Devuelve |
|---|---|
| `GET /api/v1/greenhouses` | Resumen del predio: `kpis`, `wind`, `recentAlerts` y `greenhouses[]` (estado de cada uno: temperatura, humedad, suelo, bomba, en línea, umbrales, alertas abiertas). |
| `GET /api/v1/greenhouses/{code}?range=24h` | Detalle de un invernadero (`I1`…): `summary`, `alerts` y `series`. |
| `GET /api/v1/greenhouses/{code}/readings?range=24h` | Series `temp`, `humAir`, `soilRaw`, `soilPct`, `light` como pares `[ms_epoch, valor]` (promedios por intervalo `bucketS`). |
| `GET /api/v1/greenhouses/{code}/events?range=7d` | Riegos del periodo: inicio, fin, duración, motivo (`auto`/`manual`/`schedule`), agua. |
| `GET /api/v1/greenhouses/{code}/alerts?state=active\|resolved\|all` | Alertas del invernadero (por defecto, las activas). |
| `GET /api/v1/commands/{id}` | Estado de una orden: `awaiting_confirmation` → `queued` → `delivered` → `executed` (o `rejected`/`expired`/`cancelled`). |

`range` ∈ `1h`, `6h`, `24h` (por defecto), `7d`, `30d`.

## Riego manual (confirmación en dos pasos, como en la interfaz)
```bash
# 1) solicitar (NO activa la bomba): 5–120 s, y no más que el máximo configurado del invernadero
curl -X POST -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
     -d '{"durationS": 20}' http://IP_DE_LA_PI:3000/api/v1/greenhouses/I1/irrigation
#    → 201 {"ok":true,"command":{"id":"…","status":"awaiting_confirmation",…}}

# 2) confirmar con la contraseña del usuario dueño de la clave (dentro de la ventana de confirmación)
curl -X POST -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
     -d '{"commandId":"<id>","password":"<contraseña del usuario>"}' http://IP_DE_LA_PI:3000/api/v1/greenhouses/I1/irrigation/confirm
#    → 200 {"ok":true,"command":{"status":"queued",…}}   el nodo la recibe en su siguiente reporte

# detener la bomba (un solo paso: apagar reduce el riesgo)
curl -X POST -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" -d '{}' http://IP_DE_LA_PI:3000/api/v1/greenhouses/I1/stop
```
Cada solicitud, confirmación y parada queda en la bitácora con el usuario y su IP. El nodo mantiene sus propias protecciones (tiempo máximo, espera entre riegos,
bloqueo por temperatura): una orden puede ser rechazada por el nodo (`rejected`).

## Notas
- Los datos son los de la base **local** de la Pi (la copia en Supabase se actualiza cada 5 min y no se consulta por esta API).
- `lastSeen`, `ageS` y `online` indican si el nodo reportó hace poco (90 s o 3 intervalos).
- La recepción de tramas de los nodos (`POST /api/ingest`, MQTT) es otro protocolo: ver [`contrato-api.md`](contrato-api.md).
