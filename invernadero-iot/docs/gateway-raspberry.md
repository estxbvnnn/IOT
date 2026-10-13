# Raspberry Pi 5: Mosquitto + pasarela hacia Supabase (Docker)

Es la arquitectura del esquema de la pizarra: **Paso 1** NodeMCU → Raspberry Pi por **MQTT (Mosquitto)**; **Paso 2** Raspberry Pi → nube por
**HTTP/HTTPS**.

```
 NodeMCU (DHT22, YL-38, bomba)                Raspberry Pi 5  (docker compose)                       Nube
  ┌────────────────────────┐   MQTT :1883   ┌───────────────────────────────────────┐  HTTPS/TLS  ┌──────────────┐
  │ publica la trama       │ ─────────────► │ mosquitto ──► gateway ──► cola en disco│ ──────────► │  Supabase    │ ◄── Dashboard
  │ invernadero/<id>/tx    │ ◄───────────── │   (broker)     (Node/TS)   (sobrevive) │  (Postgres) │  (base)      │     (web)
  └────────────────────────┘  cfg + órdenes └───────────────────────────────────────┘             └──────────────┘
                              invernadero/<id>/rx
```

La Pi **no riega ni mide**: recibe las tramas, las guarda en disco (es la «base local» del esquema: una cola que resiste cortes de
internet y de luz) y las reenvía a Supabase con la hora real de cada una. La pasarela **reutiliza el código del dashboard**
(`handleIngest`): validación, alertas, órdenes de riego y configuración. Por eso es Node/TypeScript y no un script Python aparte.

## 1. En la Raspberry Pi (Raspberry Pi OS de 64 bits)
```bash
# Docker (una sola vez)
curl -fsSL https://get.docker.com | sudo sh && sudo usermod -aG docker $USER   # cierre sesión y vuelva a entrar
# El proyecto (git o memoria USB)
cd ~/invernadero-iot
```
Dos archivos de configuración:
- **`invernadero-iot/.env`**: `MQTT_USER` y `MQTT_PASS`, la clave de Mosquitto. (Hay un `.env.example`; cambie la clave.)
- **`dashboard/.env.local`**: credenciales del rol `iot_app` de Supabase (`DATABASE_HOST`, `DATABASE_USER`, `DATABASE_PASSWORD`,
  `DATABASE_SSL_MODE=verify`…). Nunca las del administrador `postgres`.

Arranque (construye la imagen la primera vez, unos minutos):
```bash
docker compose up -d --build
docker compose ps                     # mosquitto y gateway deben decir "healthy"
docker compose logs -f gateway        # "MQTT: conectado… escuchando invernadero/+/tx"
curl http://localhost:3100/api/health
```
Los contenedores tienen `restart: unless-stopped`: vuelven solos al encender la Pi (Docker arranca con el sistema). Detener:
`docker compose down` (la cola y la clave de Mosquitto viven en volúmenes y se conservan). Actualizar tras un `git pull`:
`docker compose up -d --build`.

Prueba sin nodo (con un token falso debe responder `401`, lo que demuestra broker + pasarela + Supabase):
```bash
docker compose exec -T mosquitto sh -c 'mosquitto_sub -u $MQTT_USER -P $MQTT_PASS -t invernadero/prueba/rx -C 1 -W 15 &
  sleep 1; printf "TOKEN_FALSO
{\"v\":1}" | mosquitto_pub -u $MQTT_USER -P $MQTT_PASS -t invernadero/prueba/tx -s; wait'
```

## 2. En cada nodo (NodeMCU)
1. Arduino IDE: instale la biblioteca **PubSubClient** (Nick O'Leary).
2. En la CONFIGURACION DEL USUARIO de `nododefinitivo.ino`: `USAR_MQTT 1`, `MQTT_HOST` = IP de la Pi (`hostname -I`; fíjela con una
   reserva DHCP en el router), `MQTT_USER`/`MQTT_PASS` = los de `.env`, y el `DEVICE_TOKEN` de siempre. Suba el sketch.
3. El Monitor Serie debe mostrar `MQTT: conectado a IP:1883 como nodo-xxxxxx`. Si dice `estado -2` el nodo no ve la Pi (red distinta, IP
   mal escrita o puerto 1883 bloqueado); `estado 5` es clave rechazada.

El nodo y la Pi deben estar en la **misma red**. Con `USAR_MQTT 0` el nodo sigue pudiendo hacer POST HTTP a la pasarela (`http://IP_DE_LA_PI:3100`).

### Protocolo MQTT (por si se programa otro nodo)
| Tema | Dirección | Contenido |
|---|---|---|
| `invernadero/<id>/tx` | nodo → Pi | `TOKEN` + salto de línea + trama JSON (la misma de `docs/contrato-api.md`) |
| `invernadero/<id>/rx` | Pi → nodo | `<código HTTP> <Retry-After>` + salto de línea + respuesta JSON (`cfg`, `ordenes`) |

`<id>` son letras, números, `-` o `_` (máx. 40) y solo indica dónde responder; la identidad del nodo es el token. Códigos: 200, 400, 401, 413, 429, 503.

## 3. Variables de la pasarela
| Variable | Por defecto | Qué hace |
|---|---|---|
| `GATEWAY_PORT` | 3100 | Puerto HTTP (nodos sin MQTT y `/api/health`) |
| `MQTT_URL` / `MQTT_USER` / `MQTT_PASS` | (docker-compose) | Broker Mosquitto; sin `MQTT_URL` la pasarela solo atiende HTTP |
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
  Proteja el acceso a la Pi; los puertos 1883 (MQTT) y 3100 solo necesitan ser visibles desde la red local (no los exponga a internet). MQTT va sin cifrar pero con clave; si la red no es de confianza, añada TLS a Mosquitto.
- **Primera trama:** la primera de cada nodo (o tras borrar `respuestas.json`) se procesa al momento contra Supabase para entregar
  la configuración real; si no hay internet en ese instante el nodo recibe 503 y reintenta.
- **Pruebas:** `npm test` incluye `tests/unit/gateway.test.ts` (15 pruebas, sin base de datos real).

`firmware/nodo_pi5/` (la Pi como nodo de riego con sus propios sensores) **no se usa** en esta arquitectura.
