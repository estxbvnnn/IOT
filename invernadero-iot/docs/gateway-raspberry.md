# Pasarela (gateway) en la Raspberry Pi 5

```
 NodeMCU / Pico W ──HTTP (red local)──►  Raspberry Pi 5  ──(cada 2 s)──►  Supabase  ◄──  Dashboard
   sensores y bomba        :3100          cola en disco                 (base de datos)     (web)
        ◄── cfg + órdenes (de la última respuesta de Supabase) ──
```

La Pi **no riega ni mide**: recibe las tramas de los nodos, las guarda en disco y cada 2 s las reenvía a Supabase con la
hora real de cada una. Usa **el mismo código del dashboard** (`handleIngest`): validación, alertas, órdenes de riego y
configuración. El nodo no cambia su lógica; solo apunta a la Pi en lugar de al servidor.

## 1. En la Raspberry Pi (Raspberry Pi OS)
```bash
# Node.js 22 o superior
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt install -y nodejs git
# El proyecto (cópielo con git o con una memoria USB) y sus dependencias
cd ~/invernadero-iot/dashboard && npm ci
```
Cree `dashboard/.env.local` con las credenciales de la base (**las del rol `iot_app`**, las mismas del dashboard;
nunca las de administrador `postgres`):
```
DATABASE_HOST=...pooler.supabase.com
DATABASE_PORT=5432
DATABASE_NAME=postgres
DATABASE_USER=iot_app.xxxxxxxx
DATABASE_PASSWORD=...
DATABASE_SSL_MODE=verify
```
Pruebe a mano: `npm run gateway` → "Pasarela escuchando en el puerto 3100".  Compruebe: `curl http://localhost:3100/api/health`.

Para que arranque sola con la Pi: edite las rutas y el usuario de `dashboard/scripts/gateway.service`, cópielo a
`/etc/systemd/system/` y ejecute `sudo systemctl daemon-reload && sudo systemctl enable --now gateway`.
Ver el estado: `journalctl -u gateway -f`.

## 2. En cada nodo
Cambie solo `SERVER_URL` y vuelva a subir el sketch (el token es el mismo de siempre):
```
#define SERVER_URL    "http://IP_DE_LA_PI:3100"
```
Averigüe la IP con `hostname -I` en la Pi. Conviene fijarla (reserva DHCP en el router): si cambia, hay que re-subir los nodos.
El nodo y la Pi deben estar en la **misma red**; en un Wi-Fi de celular o de invitados es posible que no se vean entre sí.

## 3. Variables de la pasarela
| Variable | Por defecto | Qué hace |
|---|---|---|
| `GATEWAY_PORT` | 3100 | Puerto que escuchan los nodos |
| `GATEWAY_FORWARD_S` | 2 | Segundos entre envíos a Supabase (mínimo 1; súbalo a 30–60 si quiere menos tráfico) |
| `GATEWAY_SPOOL` | `./.gateway` | Carpeta de la cola (`cola/`) y de las respuestas guardadas (`respuestas.json`) |

## 4. Qué pasa cuando algo falla
| Situación | Resultado |
|---|---|
| Sin internet / Supabase caído | La Pi sigue recibiendo y guardando (hasta 20 000 tramas); al volver la conexión las envía **en orden y con su hora real** |
| La Pi se reinicia | La cola y la última configuración/órdenes están en disco: no se pierde nada de lo ya recibido |
| La Pi está apagada | Cada nodo sigue **regando solo** con su última configuración y conserva hasta 8 eventos; después los más viejos se pierden |
| Token de nodo inválido | La primera trama recibe 401 (el nodo lo muestra en su Monitor Serie); no se guarda nada |

## 5. Detalles que conviene saber
- **Retraso de las órdenes:** una orden de riego manual hecha en el dashboard llega a la Pi en el siguiente envío (≤ 2 s) y al
  nodo en su siguiente reporte (≤ su intervalo, 5 s en I1): **unos 3–9 s en total**. Igual con los cambios de umbrales y con el
  interruptor del riego automático. Con `GATEWAY_FORWARD_S=60` serían 1–2 min.
- **"En línea" en el dashboard:** se considera sin conexión pasados 90 s (o 3 intervalos del nodo) sin datos nuevos. Con envíos
  cada 2 s sobra margen; si sube `GATEWAY_FORWARD_S` por encima de ~75, el dashboard marcará los nodos como desconectados entre envíos.
- **Hora:** la Pi pone la hora de recepción a cada trama; debe tener la hora correcta (Raspberry Pi OS la sincroniza sola con internet).
- **Seguridad:** la Pi guarda en disco los tokens de los nodos (dentro de la cola) y las credenciales de `iot_app` en `.env.local`.
  Proteja el acceso a la Pi; el puerto 3100 solo necesita ser visible desde la red local (no lo exponga a internet).
- **Primera trama:** la primera de cada nodo (o tras borrar `respuestas.json`) se procesa al momento contra Supabase para entregar
  la configuración real; si no hay internet en ese instante el nodo recibe 503 y reintenta.
- **Pruebas:** `npm test` incluye `tests/unit/gateway.test.ts` (15 pruebas, sin base de datos real).

`firmware/nodo_pi5/` (la Pi como nodo de riego con sus propios sensores) **no se usa** en esta arquitectura.
