# Raspberry Pi 5: el sistema completo en la red local (MQTT + PostgreSQL + dashboard + API) y copia a Supabase

La Pi es **todo el sistema** y funciona **sin internet**: los nodos le publican por MQTT, ella guarda en su propia base **PostgreSQL**,
sirve el **dashboard** y una **API REST** a cualquier equipo de la misma red, y **cada 5 minutos copia los datos a Supabase** (la nube).
Si no hay internet, nada se detiene: los datos se acumulan en la Pi y suben solos cuando vuelve la conexión.

```
 NodeMCU (DHT22, YL-38, bomba)            Raspberry Pi 5  (docker compose)                                   Nube
  ┌─────────────────────┐  MQTT :1883  ┌──────────────────────────────────────────────────────┐
  │ publica la trama    │ ───────────► │ mosquitto ─► gateway ─► PostgreSQL local ◄─ dashboard │ ◄── navegador / app (misma red)
  │ invernadero/<id>/tx │ ◄─────────── │   (broker)   (Node)      (iot_app)          :3000     │      http://IP_DE_LA_PI:3000
  └─────────────────────┘ cfg + órdenes│                              │               /api/v1   │      API: /api/v1  (clave Bearer)
                          invernadero/ │                              └── sync cada 5 min ──────┼───HTTPS──► Supabase (copia)
                          <id>/rx      └──────────────────────────────────────────────────────┘
```

La Pi **no riega ni mide**: el nodo decide su riego solo (con o sin Pi). La pasarela reutiliza el código del dashboard (`handleIngest`:
validación, alertas, órdenes de riego y configuración) contra la base local, así que **la respuesta al nodo es siempre la real** y las
órdenes del dashboard le llegan en su siguiente reporte (unos segundos).

| Contenedor | Qué hace | Puerto |
|---|---|---|
| `postgres` | Base de datos local (PostgreSQL 17, mismo esquema que Supabase). **No se publica a la red.** | — |
| `migrate` | Aplica `supabase/migrations/*.sql` y habilita el rol `iot_app`. Corre una vez por arranque y termina. | — |
| `mosquitto` | Broker MQTT con usuario y clave. | 1883 |
| `gateway` | Recibe las tramas (MQTT, o HTTP para nodos sin MQTT), las guarda y responde. Detecta «nodo sin conexión». | 3100 |
| `dashboard` | Interfaz web (login, gráficos, alertas, riego) y **API REST `/api/v1`**. | 3000 |
| `uplink` | **Envía a la nube (AWS) cada 5 s** las lecturas nuevas, por HTTPS y cifradas con la clave pública de AWS (`AWS_UPLINK_URL`, `AWS_PUBLIC_KEY_FILE`). Sin `AWS_UPLINK_URL` queda inactivo. Ver `docs/malla-espnow.md`. | — |
| `puente` (perfil `concentrador`) | Une el **concentrador** (un ESP por USB que oye la malla ESP-NOW) con la pasarela: `CONCENTRADOR_DEV=/dev/ttyUSB0 docker compose --profile concentrador up -d puente`. | — |
| `sync` | Opcional: copia a Supabase cada `SYNC_INTERVAL_S` (300 s). Solo un sentido: Pi → Supabase. | — |

## 1. Instalar en la Raspberry Pi (Raspberry Pi OS de 64 bits)
```bash
# Docker (una sola vez; necesita internet)
curl -fsSL https://get.docker.com | sudo sh && sudo usermod -aG docker $USER   # cierre sesión y vuelva a entrar
# El proyecto: copie la carpeta invernadero-iot/ a la Pi (git, memoria USB o scp), SIN node_modules ni .next
cd ~/invernadero-iot
cp .env.example .env && nano .env      # cambie TODAS las claves (ver más abajo)
```
`.env` (en `invernadero-iot/`) define: `MQTT_USER`/`MQTT_PASS` (Mosquitto), `POSTGRES_PASSWORD` e `IOT_APP_PASSWORD` (base local),
`APP_SECRET` (≥ 32 caracteres; firma las sesiones), y `SUPABASE_DB_*` + `SYNC_INTERVAL_S` (copia a la nube). Genere cada clave con
`openssl rand -base64 24 | tr -d '/+='`. **Nunca** ponga en la Pi las credenciales del administrador de Supabase (`postgres`): `sync` usa solo el rol limitado `iot_app`.

Primer arranque (construye las imágenes; tarda varios minutos y **necesita internet esta única vez**):
```bash
docker compose up -d --build
docker compose ps                     # postgres, mosquitto, gateway, dashboard: "healthy"; migrate: "Exited (0)"
docker compose logs -f gateway        # "MQTT: conectado… escuchando invernadero/+/tx"
curl http://localhost:3100/api/health # {"ok":true,"baseLocal":...,"tramas":N,...}
```
Todos los contenedores tienen `restart: unless-stopped`: vuelven solos al encender la Pi. Detener: `docker compose down` (los datos viven en
volúmenes y se conservan). Actualizar tras cambiar el código: `docker compose up -d --build`.

### Traer lo que ya existe en Supabase (una sola vez, antes de depender de la Pi)
Para que los **nodos ya programados** (con su token) y los **usuarios** (con su clave) sigan funcionando sin cambios, se copia a la Pi lo que ya hay en Supabase:
```bash
docker compose run --rm bootstrap     # falla si la base local ya tiene datos
# (para REEMPLAZAR lo local por lo de Supabase:  docker compose run --rm bootstrap node --import tsx scripts/sync-bootstrap.ts --force)
```
Desde el siguiente ciclo (≤ 5 min) el servicio `sync` empieza a subir lo nuevo. Sin este paso `sync` **no sube nada** (lo avisa en su registro): una base
local distinta de la de Supabase chocaría con sus ids.
Si es una instalación nueva y Supabase está vacío, el mismo comando sirve (no copia nada y deja todo listo). Si todavía no quiere usar la nube, deje vacías las
variables `SUPABASE_DB_*`: `sync` queda inactivo y la Pi funciona igual en local.

## 2. Usar el dashboard y la API desde la red
- **Dashboard:** `http://IP_DE_LA_PI:3000` (o `http://iot.local:3000`) desde cualquier equipo de la misma red. Entra con los mismos usuarios de siempre.
- **API REST:** `http://IP_DE_LA_PI:3000/api/v1/…`, documentada en [`api-v1.md`](api-v1.md). Se autentica con una clave Bearer que se crea así:
  ```bash
  docker compose run --rm tools crear correo@del-usuario.cl "Mi aplicación"   # muestra la clave UNA sola vez
  docker compose run --rm tools listar
  docker compose run --rm tools revocar <id-de-la-clave>
  ```
- El acceso es por **HTTP en la red local** (`FORCE_HTTPS=false`). No exponga los puertos 3000, 3100 ni 1883 a internet. Si necesita HTTPS (por ejemplo para usarlo
  desde fuera), ponga un proxy inverso con certificado delante y cambie `FORCE_HTTPS` a `"true"` en `docker-compose.yml`.

## 3. En cada nodo (NodeMCU)
1. Los nodos usan `firmware/malla_espnow/malla_espnow.ino` (ver [`malla-espnow.md`](malla-espnow.md)): suben por HTTP a `http://IP_DE_LA_PI:3100/relay/<id>`; en `GATEWAY_HOST` va la IP de la Pi (`hostname -I`; fíjela con una reserva DHCP en el router).
2. En la Pi (modo normal) cree un invernadero por nodo en el dashboard y use su token como identificador; `ACEPTAR_NODOS_NUEVOS` debe quedar en 0. El firmware MQTT anterior (`nododefinitivo`) ya no está en el proyecto; Mosquitto sigue disponible.
3. (Solo si algún nodo usa MQTT) El Monitor Serie debe mostrar `MQTT: conectado a IP:1883 como nodo-xxxxxx`. Si dice `estado -2` el nodo no ve la Pi (red distinta, IP mal escrita o puerto 1883
   bloqueado); `estado 5` es clave rechazada.

El nodo y la Pi deben estar en la **misma red**. Con `USAR_MQTT 0` el nodo hace POST HTTP a `SERVER_URL` = `http://IP_DE_LA_PI:3100` (la pasarela) o `http://IP_DE_LA_PI:3000` (el dashboard).

### Protocolo MQTT (por si se programa otro nodo)
| Tema | Dirección | Contenido |
|---|---|---|
| `invernadero/<id>/tx` | nodo → Pi | `TOKEN` + salto de línea + trama JSON (la misma de `docs/contrato-api.md`) |
| `invernadero/<id>/rx` | Pi → nodo | `<código HTTP> <Retry-After>` + salto de línea + respuesta JSON (`cfg`, `ordenes`) |

`<id>` son letras, números, `-` o `_` (máx. 40) y solo indica dónde responder; la identidad del nodo es el token. Códigos: 200, 400, 401, 413, 429, 503.

**Cifrado del payload (opcional):** `tx` y `rx` pueden ir en Base64 (`b64:…`) o cifrados con AES-256-GCM (`aes1:…`); ver [`cifrado-mqtt.md`](cifrado-mqtt.md), que también explica cómo escucharlo con Wireshark.

## 4. Variables
| Variable (`.env`) | Por defecto | Qué hace |
|---|---|---|
| `MQTT_USER` / `MQTT_PASS` | — | Clave de Mosquitto (nodos y pasarela) |
| `MQTT_AES_KEY` | vacío | Clave AES-256 (64 hex) compartida con los nodos para cifrar el payload MQTT. Vacío = sin AES |
| `MQTT_CIFRADO` | `permitir` | `permitir` acepta claro, Base64, AES y RSA; `exigir` solo AES o RSA; `exigir-rsa` solo RSA (clave pública/privada, ver `secrets/` y [`cifrado-mqtt.md`](cifrado-mqtt.md) §5) |
| `POSTGRES_PASSWORD` | — | Administrador de la base local (solo lo usan `migrate` y `bootstrap`) |
| `IOT_APP_PASSWORD` | — | Rol `iot_app` de la base local (lo usan gateway, dashboard, sync y tools) |
| `APP_SECRET` | — | Firma de sesiones del dashboard (≥ 32 caracteres) |
| `MFA_REQUIRED_ROLES` | vacío | Roles que deben registrar un segundo factor (p. ej. `admin,owner`) |
| `SYNC_INTERVAL_S` | 300 | Segundos entre copias a Supabase (mínimo 10) |
| `SUPABASE_DB_HOST/PORT/NAME/USER/PASSWORD/SSL_MODE` | vacío | Rol `iot_app` de Supabase. Vacío = copia desactivada |
| `TZ` | America/Santiago | Zona horaria de los contenedores |

## 5. Qué pasa cuando algo falla
| Situación | Resultado |
|---|---|
| **Sin internet** | La Pi sigue recibiendo, guardando, alertando y mostrando todo en la red local. `sync` lo registra y reintenta cada 5 min; al volver la conexión sube **todo lo acumulado**, en orden. |
| Supabase caído o clave inválida | Igual que arriba; el registro de `sync` dice por qué (`docker compose logs sync`). |
| La Pi se reinicia | Los contenedores vuelven solos; la base y la cola de sincronización están en disco: no se pierde nada de lo ya recibido. |
| La Pi está apagada | Cada nodo sigue **regando solo** con su última configuración y conserva hasta 8 eventos; después los más viejos se pierden. |
| Token de nodo inválido | La primera trama recibe 401 (el nodo lo muestra en su Monitor Serie); no se guarda nada. |
| La base local no responde | La pasarela contesta 503 al nodo (reintenta) y `/api/health` responde 503. |

## 6. Detalles que conviene saber
- **Hora (importante sin internet):** la Pi pone la hora de recepción a cada trama. Sin internet no puede sincronizar su reloj y, al apagarse, se atrasa.
  Soluciones: (a) conectar a la Pi 5 una **pila de respaldo del reloj** (conector J5) y activar su carga con `dtparam=rtc_bbat_vchg=3000000` en `/boot/firmware/config.txt`; o
  (b) apuntar `chrony` al router/servidor NTP de la red local. Con la hora mal, los gráficos y la detección «sin conexión» salen desfasados.
- **«En línea» en el dashboard:** se considera sin conexión pasados 90 s (o 3 intervalos del nodo) sin datos nuevos.
- **Copia a Supabase:** un solo sentido (Pi → Supabase). Lo que se cambie directamente en Supabase se pisa en el siguiente ciclo. Se copian lecturas, riegos, órdenes,
  alertas, bitácora, umbrales, calendarios, usuarios e invernaderos; no se copian las sesiones ni las claves de API. Detalle del método en `dashboard/scripts/lib/sync-core.ts`.
- **Seguridad:** la base local no se publica a la red. En la Pi quedan los hashes de los tokens de los nodos y las credenciales de `iot_app` (de Supabase y local) en `.env`:
  proteja el acceso a la Pi (`chmod 600 .env`). MQTT va sin cifrar pero con clave; si la red no es de confianza, añada TLS a Mosquitto.
- **Pruebas:** `npm test` (unitarias, incluye la pasarela) y, con un PostgreSQL local (`docker compose up -d postgres` con el puerto publicado y las variables `DATABASE_*`),
  `npm run test:db` (incluye `tests/db/sync.test.ts`: copia a Supabase, cursor, borrados, corte de red y arranque inicial).

## 7. La Pi del proyecto (estado del 11-nov-2026) y cómo se actualiza
- **Acceso:** `ssh iot@iot.local` (con clave; la IP era `10.221.230.220`, pero cambia). Con la IP directa SSH puede decir «Host key verification failed» si esa IP no está en `known_hosts`; usa el nombre `iot.local`. Proyecto en `~/invernadero-iot`.
- **Servicios en marcha:** `postgres`, `mosquitto`, `gateway`, `dashboard`, `uplink` y `sync` (6 contenedores, los cuatro primeros con healthcheck). El `puente` (concentrador) **no** corre en la Pi todavía: se ejecutó desde un PC.
- **`.env` de la Pi:** tiene `ACEPTAR_NODOS_NUEVOS='1'` (modo abierto de pruebas) y `MQTT_CIFRADO` en `permitir`. Respaldos del 11-nov: `~/env.respaldo-antes-modo-abierto` y `~/backup-iot-20261111-antes-de-actualizar.sql.gz`.
- **Claves:** `secrets/mqtt-rsa-private.pem` y `mqtt-rsa-public.pem` (solo en la Pi). El `.ino` lleva la pública; la huella `89a778731578188e` aparece en el registro de la pasarela al arrancar.
- **Actualizar el código** (sin tocar `secrets/` ni `.env`), desde el PC, en la raíz de `invernadero-iot`:
  ```bash
  tar cf - <archivos cambiados> | ssh iot@iot.local "cd ~/invernadero-iot && tar xf -"
  ssh iot@iot.local "cd ~/invernadero-iot && docker compose up -d --build migrate gateway dashboard"
  ```
  `migrate` aplica las migraciones nuevas (mira su registro: `docker compose logs migrate`). La reconstrucción tarda unos minutos y la pasarela se reinicia (los nodos reintentan solos).
- **Comprobar:** `curl http://iot.local:3100/api/health` (`tramas`, `ultimaTrama`) y `http://iot.local:3000`.
- **Consultar la base:** `docker compose exec postgres psql -U postgres -d iot -c "select code, name from iot.greenhouses where archived_at is null"`. Los invernaderos se **archivan** (columna `archived_at`, igual que el botón del dashboard), no se borran.
