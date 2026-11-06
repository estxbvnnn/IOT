# Invernadero IoT · monitoreo y riego automático de invernaderos

Implementación funcional del informe **«Diseño de una solución IoT para el monitoreo y riego automático de invernaderos»**
(INACAP · Seguridad IoT · alternativa 2, bajo costo). Incluye el **firmware de la malla ESP-NOW** (un solo `.ino` para todas las placas),
la **pasarela** (Raspberry Pi, o el PC mientras tanto), una **base de datos** (PostgreSQL local con copia a Supabase) y un **dashboard web en
TypeScript** con control de acceso por rol.

## Capturas

| Predio (claro) | Predio (oscuro) |
|---|---|
| ![Predio, tema claro](docs/screenshots/predio-admin-claro-escritorio.png) | ![Predio, tema oscuro](docs/screenshots/predio-admin-oscuro-escritorio.png) |

| Detalle de un invernadero | Móvil |
|---|---|
| ![Detalle del invernadero](docs/screenshots/invernadero-admin-claro-escritorio-completa.png) | ![Predio en el móvil](docs/screenshots/predio-admin-claro-movil.png) |

<sub>Capturas de referencia tomadas durante el desarrollo, con datos **simulados**; la interfaz puede diferir en detalles menores.</sub>

## Estado actual (6 de noviembre de 2026)

**Objetivo:** que todas las placas ejecuten el mismo `.ino` y formen una **malla**. Si un nodo no consigue que el servidor le responda, otro nodo sube sus datos por ESP-NOW. Solo la Raspberry Pi (por ahora, el PC) sube a la nube.

```
nodo sin red ──ESP-NOW──► vecino CON red ──POST /relay/<id>──► pasarela (PC/Pi) ──► PostgreSQL ──(sync cada 5 min)──► Supabase
      ▲                                                                │
      └────────── respuesta cifrada (vuelve por radio) ◄───────────────┘
```

### Qué se hizo
- **Firmware único** `firmware/malla_espnow/malla_espnow.ino` (NodeMCU/ESP8266): cifrado RSA-2048 + AES-256-GCM de extremo a extremo, reenvío por inundación con TTL 3 y detección de duplicados. Los nodos intermedios **no abren** el contenido. Selector `PERFIL` (0 = todas las placas; 1 y 2 = pruebas con dos placas). El WiFi y la IP van en `config_local.h` (fuera de git; plantilla en `config_local.example.h`).
- **Detección del canal:** una placa que no consigue conectar al WiFi busca el router por su nombre y usa **su canal**, para seguir oyendo a los vecinos. Reintenta la conexión cada 30 s.
- **Pasarela:** `POST /relay/<id>` (mismo pipeline que MQTT), con las cabeceras `X-Via` y `X-Saltos`. Cada lectura guarda su ruta (`transport`, `via`, `hops`) — migración `0009_origen_ruta.sql`.
- **Ingesta tolerante:** acepta JSON con campos faltantes o extra (solo `seq` es obligatorio), entiende alias (`temperature`, `humidity`, `soil`…) y guarda lo desconocido en `extra`.
- **Modo abierto de pruebas** (`ACEPTAR_NODOS_NUEVOS=1`): sin tokens, cada identificador nuevo se da de alta solo y se coloca en un hueco libre del mapa (ya no se superponen).
- **Dashboard:** la tabla de *Equipos* muestra la ruta («Directo · HTTP» o «Vía nodo-xxxx · N salto(s)») y el último JSON recibido.
- **El PC hace de Pi** con Docker (`docker-compose.yml`, `.env.pc`) y `scripts/firewall-pasarela-pc.ps1` (abre y **cierra** los puertos 3100 y 3000).
- **Limpieza:** se eliminó el firmware anterior (`nodo_invernadero*`, `test/`, `tools/`). El material de clase y las prácticas viven en `material-clase/` (fuera del proyecto y de git).

### Placas de prueba y MAC
| Placa | MAC | Nombre en el sistema | Notas |
|---|---|---|---|
| Placa 1 (puerto COM6 en las pruebas) | `A4:CF:12:FE:F2:CC` | `nodo-fef2cc` | La que conecta de forma más fiable al WiFi |
| Placa 2 (puerto COM4 en las pruebas) | `FC:F5:C4:8D:57:2E` | `nodo-8d572e` | Tuvo fallos al conectar al arrancar; se usa como la placa «sin red» |
| Placa del compañero (práctica `espnow_cifrado`, en `material-clase/`) | `78:1C:3C:85:BB:C8` | — | Solo para la práctica entre grupos |

La malla (`malla_espnow`) **no usa MAC**: difunde a todos. Solo la práctica `espnow_cifrado` y el firmware anterior usaban `SOCIO_MAC`. En los dispositivos de prueba, el identificador de cada placa sale de su chip (`nodo-<últimos 6 hex de la MAC>`).

### Cómo probar la malla con dos placas
1. En `invernadero-iot`: `docker compose --env-file .env --env-file .env.pc up -d postgres migrate gateway dashboard` y abre el puerto con `.\scripts\firewall-pasarela-pc.ps1 -Abrir` (como administrador).
2. Copia `firmware/malla_espnow/config_local.example.h` a `config_local.h` y pon tu WiFi (2,4 GHz) y la IP del PC.
3. Sube el mismo archivo a las dos placas con `PERFIL 0`.
4. En el celular (punto de acceso), **bloquea la MAC de una placa**: pasa a radio y la otra sube sus datos. Verás «Vía nodo-xxxx · 1 salto» en *Equipos*. Desbloquéala para ver que vuelve a «Directo».

Guía completa y cómo revertirlo todo: [`docs/malla-espnow.md`](docs/malla-espnow.md) y [`PRUEBAS_TEMPORALES.md`](PRUEBAS_TEMPORALES.md).

### Qué falta
- **La malla aún no es estable.** Con dos placas reales una lectura cruzó por radio con 1 salto, pero después las lecturas de la placa bloqueada dejaron de llegar. Falta ver el Monitor Serie de la placa que sube para saber si no oye los fragmentos, no los sube o falla la respuesta.
- **Salida serie corrupta:** durante la transmisión por radio el Monitor Serie se llena de caracteres repetidos. Parece cable/alimentación USB, sin confirmar; hay que probar otro cable o un puerto con buena alimentación.
- **Más de un salto** no está probado: se necesita una tercera placa.
- **Sensores reales:** el firmware de la malla envía datos **simulados** (`armarJson`). Falta integrar DHT22, YL-38 y la bomba (el firmware anterior con sensores está en el historial de git y en `material-clase/`).
- **Raspberry Pi real:** todo se probó con el PC como pasarela. Falta desplegar en la Pi (`scripts/deploy-pi.ps1`), usar el modo normal con tokens (`ACEPTAR_NODOS_NUEVOS=0`) y revisar el firewall.
- **Migración `0009` en Supabase:** está aplicada solo en la base local. Si no se aplica en Supabase, el servicio `sync` omite `readings`.
- **Pruebas de base de datos:** los tests nuevos de `tests/db` (ruta, ingesta tolerante, alta abierta) no se han ejecutado contra PostgreSQL. Los 227 tests unitarios pasan.
- **Seguridad antes de producción:** `POST /relay` no pide autenticación HTTP y el modo abierto acepta cualquier identificador (tope de 60 invernaderos). Hay que cerrarlos antes de entregar (ver `PRUEBAS_TEMPORALES.md`).
- **Datos de prueba:** quedan invernaderos de pruebas anteriores (`GRUPO-A`, `GRUPO-B`) sin datos; se pueden borrar.
- **Reporte de los nodos:** las placas de prueba envían cada 10 s, pero el dashboard espera 300 s por defecto, así que «Tramas 24 h» muestra porcentajes engañosos.

## Qué incluye

| Carpeta | Qué es |
|---|---|
| `firmware/malla_espnow/` | **El firmware de TODAS las placas (NodeMCU/ESP8266), un solo `.ino`**: cifra cada medición (RSA-2048 + AES-GCM), la sube por WiFi a la pasarela o, si no hay red, la difunde por **ESP-NOW** para que la suba un vecino (malla con hasta 3 saltos). Guía: [`docs/malla-espnow.md`](docs/malla-espnow.md). Los sensores del sketch son simulados (`armarJson`). |
| `docker-compose.yml`, `docker/` | **La Raspberry Pi** (o el PC) como sistema completo en la red local: Mosquitto + pasarela + PostgreSQL + dashboard + API y copia a Supabase. Guía: [`docs/gateway-raspberry.md`](docs/gateway-raspberry.md). |
| `dashboard/` | Aplicación web **Next.js 16 + React 19 + TypeScript estricto**: API de recepción de los nodos, paneles por rol, gráficos, alertas, órdenes de riego, bitácora. |
| `supabase/migrations/` | Esquema SQL (PostgreSQL 17): tablas, permisos mínimos, bitácora inmutable. |
| `docs/` | [`gateway-raspberry.md`](docs/gateway-raspberry.md) (la Pi), [`api-v1.md`](docs/api-v1.md) (API REST del dashboard), [`contrato-api.md`](docs/contrato-api.md) (protocolo nodo ↔ servidor), [`malla-espnow.md`](docs/malla-espnow.md) (la malla), [`seguridad.md`](docs/seguridad.md) (controles del informe → código). |
| `scripts/` | `firewall-pasarela-pc.ps1` (abre/**cierra** los puertos 3100 y 3000 para probar con el PC), `deploy-pi.ps1`, `demo-pc.ps1`. |

**¿Por qué TypeScript?** Es el lenguaje con mejor relación entre productividad, seguridad de tipos y ecosistema para un panel web:
los mismos tipos viajan del acceso a datos a la interfaz, y el compilador (modo `strict`) detecta errores antes de ejecutar. El
firmware queda en C++ (Arduino) porque el ESP32 lo exige.

## Arquitectura

La **Raspberry Pi 5** es el sistema completo y **funciona sin internet** (todo en la red local); cada 5 minutos copia los datos a Supabase.

```
 NodeMCU (ESP8266) ×N                Raspberry Pi 5 (docker compose)                                              Nube
 DHT22 · YL-38 · relé → bomba   MQTT   ┌───────────────────────────────────────────────────────┐
 riega solo aunque no haya red ──────▶ │ mosquitto ─▶ gateway ─▶ PostgreSQL local ◀─ dashboard │ ◀── navegador / apps (misma red)
                               ◀────── │  (broker)    (Node)      (rol iot_app)       :3000     │      http://IP_DE_LA_PI:3000
                              cfg + órdenes                            │            + API /api/v1│      API REST con clave Bearer
                                       │                               └── sync cada 5 min ──────┼──HTTPS──▶ Supabase (copia, 1 sentido)
                                       └───────────────────────────────────────────────────────┘
```

Las cuatro capas del informe se conservan: **percepción y acción** (nodos), **red** (MQTT en la red local en lugar de LoRaWAN, ver más abajo),
**procesamiento** (pasarela + reglas + alertas + base local) y **aplicación** (dashboard y API en la Pi). El riego **no depende de la Pi**: cada nodo decide
con su propia lectura y aplica límites duros (corte a 30 s, espera de 5 min, bloqueo por temperatura); el servidor solo ajusta umbrales y envía órdenes manuales.
Detalle, instalación y qué pasa cuando algo falla: [`docs/gateway-raspberry.md`](docs/gateway-raspberry.md) · API: [`docs/api-v1.md`](docs/api-v1.md).

> El dashboard también puede correr suelto en un PC contra Supabase (`npm run dev`, abajo): es el modo de desarrollo y de demostración con el simulador.

## Puesta en marcha

Requisitos: **Node.js ≥ 22.12** y el archivo `env.txt` de Supabase (ya está junto a esta carpeta).

```bash
npm install          # instala las dependencias de dashboard/
npm run setup        # crea .env.local, migra la base y siembra el predio de ejemplo (10 invernaderos), usuarios demo y nodos (sin datos simulados)
npm run dev          # http://localhost:3000   (también sirve `npm start`)
```

Estos comandos se pueden ejecutar **desde esta carpeta o desde `dashboard/`**: los de la raíz delegan en `dashboard/` (`npm start` en la raíz
levanta el servidor de desarrollo; la versión de producción es `npm run build` y luego `npm run start:prod`).

* **Cuentas demo** (una por rol, con contraseña aleatoria): `dashboard/.demo-credentials.md`.
* **Datos en vivo sin hardware**: en otra terminal, `npm run demo` (simula los nodos sembrados y el mástil, con un guion de alertas).
  Variantes: `npm run simulate -- --speed 120`, `--scenario heat|fault|offline|wind|dry|irrigate`, `--only I1,I3`, y
  `--add I11=<token>` para simular un invernadero creado desde el panel.
  `npm run demo` usa `--fast`: fija «Reporte del nodo» en 15 s para ver alertas en minutos y lo **restaura a 300 s al salir con Ctrl+C**
  (si cierras la terminal a la fuerza, vuelve a dejarlo en 300 s desde el panel de umbrales de cada invernadero).
* **Con placas reales (Arduino IDE)**: levanta la pasarela en el PC (`docker compose --env-file .env --env-file .env.pc up -d postgres migrate gateway dashboard`),
  abre `firmware/malla_espnow/malla_espnow.ino`, completa `WIFI_SSID`, `WIFI_PASS` y `GATEWAY_HOST` (IP del PC) y sube **el mismo archivo a todas las placas**.
  Paso a paso, pruebas y cómo revertirlo todo: [`docs/malla-espnow.md`](docs/malla-espnow.md).

Hasta que un nodo reporte por primera vez, el panel muestra «Sin datos»; si un nodo deja de reportar, pasa a «Sin conexión» a los 15 min.
**El simulador escribe en la MISMA base que los nodos reales**: no lo uses junto con ESP32 reales. Si lo usaste, limpia con
`npm run db:reset-data -- --yes` (borra telemetría, riegos, órdenes y alertas; conserva usuarios, invernaderos, umbrales y nodos con sus tokens).

## Roles y permisos

Implementados en `dashboard/src/lib/rbac.ts` (matriz de la tabla 11 del informe) y verificados en cada página, acción y consulta.

| Rol | Puede |
|---|---|
| Dueño | Ver el predio, alertas e historial de **todos** los sectores; exportar CSV. Solo lectura. |
| Administrador | Todo: usuarios, **invernaderos (alta, edición y baja)**, ajustes del predio, tokens de nodos, umbrales, riego, bitácora. |
| Ingeniero agrónomo | Analizar historial, ajustar umbrales, programar calendarios de riego, reconocer alertas. |
| Operador de campo | Ver alertas y **accionar el riego solo en sus sectores asignados** (confirmación en 2 pasos). |
| Técnico | Solo lectura: calidad de enlace (RSSI/SNR), estado de equipos y bitácora. Nunca acciona actuadores. |

## La cantidad de invernaderos no es fija

Los 10 del informe son solo el predio de ejemplo. El administrador maneja los invernaderos desde **Invernaderos** (menú lateral):

* **Nuevo invernadero**: nombre, cultivo, superficie, caudal de la bomba y posición en el mapa (clic en el mapa o el botón «Sugerir un lugar
  libre», que propone el sitio libre más cercano a la subestación). En una sola operación se crean el invernadero, sus umbrales (por defecto
  o copiados de otro) y su **nodo con su token**, que se muestra una vez. El código (`I11`, o el que elijas) es único y no cambia.
* **Editar** los datos y la posición, **Ajustes del predio** (tamaño del mapa, subestación, estanque) para que el predio crezca con los invernaderos.
* **Dar de baja / Reactivar**: nada se borra. Un invernadero dado de baja conserva todo su historial, sale del panel y su nodo queda
  deshabilitado (el servidor rechaza sus tramas). El nodo físico sigue regando de forma autónoma hasta que se apague.
* Un invernadero nuevo no lo ve ningún operador hasta que se le asigne en **Usuarios**. No hay un máximo práctico (hasta 32.767).
* Todo queda en la bitácora (`greenhouse.create`, `.update`, `.archive`, `.restore` y `site.update`).

La migración es `supabase/migrations/0003_scalable_greenhouses.sql` (se aplica con `npm run db:migrate`).

## Cómo está integrado Supabase

* **La conexión directa del `env.txt` (`db.<ref>.supabase.co`) solo tiene IPv6**, y muchas redes (incluida la de esta máquina) no
  la alcanzan. Por eso `npm run setup` descubre el *pooler* IPv4 del proyecto (`aws-0-us-west-2.pooler.supabase.com:5432`) y
  conecta por ahí, con **TLS verificado** contra la CA de Supabase (incrustada en `src/lib/db/supabase-ca.ts`).
* **La aplicación no usa el rol `postgres`.** Usa `iot_app`, con permisos mínimos: sobre la bitácora solo puede `INSERT`/`SELECT`.
  La clave de `postgres` vive en `dashboard/.env.admin.local` y solo la leen los scripts de migración y semilla.
* **Todo está en el esquema privado `iot`**, que la API pública de Supabase no expone, con RLS activado y sin permisos para
  `anon`/`authenticated`. Para verlo en Supabase: *Table Editor → esquema `iot`*.
* La base **nunca se consulta desde el navegador**; solo el servidor (Server Components, acciones y la ruta `/api/ingest`).

## Seguridad (resumen)

Contraseñas con scrypt · bloqueo tras 5 fallos · sesiones en base con expiración por rol (administrador 30 min) · TOTP opcional y
exigible por rol (`MFA_REQUIRED_ROLES`) · cookies `HttpOnly` + `SameSite=Lax` · CSP con nonce · un token por nodo (solo se guarda su
SHA-256) con anti-repetición · validación de rangos · órdenes de riego con doble confirmación · **bitácora inmutable con hash
encadenado y verificación desde la interfaz**. El detalle, control por control del informe, está en [`docs/seguridad.md`](docs/seguridad.md).

## Pruebas

```bash
cd dashboard
npm run typecheck   # TypeScript estricto
npm test            # 190 pruebas unitarias (controlador de riego, alertas, TOTP, scrypt, RBAC, pasarela MQTT/HTTP, claves de API…)
npm run test:db     # 103 pruebas de integración contra PostgreSQL (cada una se revierte): esquema, permisos, ingesta, órdenes, bitácora,
                    # claves de API y la sincronización con Supabase (segunda base temporal). Funcionan en cualquier PostgreSQL 17, no solo Supabase:
                    #   docker compose up -d postgres  (con el puerto publicado en 127.0.0.1) y las variables DATABASE_* / DATABASE_ADMIN_*
npm run e2e -- --url http://127.0.0.1:3000 --users cuentas.json   # interfaz web en Edge/Chrome: cada rol, riego en 2 pasos, CSV, bitácora (63 comprobaciones)
```
Resultados completos de la última ronda (incluye caídas de servicios, seguridad, arm64 y prueba con 10 nodos a la vez): [`docs/pruebas.md`](docs/pruebas.md).

## Decisiones y hallazgos sobre el informe

1. **Transporte**: el informe usa LoRaWAN → ChirpStack → MQTT → ThingsBoard. Aquí el último tramo es **HTTP(S) → API del dashboard →
   Supabase**, porque es lo que se puede probar con una placa y WiFi. El *payload* no cambia si se vuelve a LoRaWAN.
2. **Escala del YL-38**: se usa la de la imagen de la clase (**0–1023**: 0–300 saturado, 300–700 óptimo, 700–1023 seco). El ESP32
   mide en 12 bits (0–4095) y el firmware lo lleva a 10 bits. Riega con lectura ≥ 700 y se detiene en ≤ 500.
3. **Mini bomba** de la imagen (2,5–6 V, 80–120 L/h) en lugar de la bomba de 1/2 HP del informe, siempre con fuente propia y relé.
4. **Regla de «activaciones anómalas»** (tabla 10): con corte a 30 s y una sonda con retardo, casi todos los riegos terminan por
   tiempo máximo, así que «3 cortes seguidos» habría alertado siempre. La señal correcta es *tres riegos automáticos seguidos con
   menos de 15 min entre sí* (el suelo vuelve a secarse enseguida).
5. **Pines en placa Heltec V2**: el informe declara «probado en Heltec WiFi LoRa 32 V2», pero cinco de sus pines (GPIO 26, 4, 34, 25 y 21)
   chocan con el radio LoRa, la pantalla, el LED y `Vext` de esa placa; el firmware trae un mapa alternativo. Evidencia, tomada del
   archivo de pines del core de Espressif, en [`docs/hardware.md`](docs/hardware.md).
6. **Fuera de alcance del código** (son infraestructura): VLAN/cortafuegos MikroTik, VPN WireGuard, certificados de cliente X.509,
   elemento seguro ATECC608A y respaldo diario cifrado. Ver la sección correspondiente de `docs/seguridad.md`.

## Antes de producción

* Sirve el dashboard **detrás de HTTPS** y define `FORCE_HTTPS=true` (cookies `Secure`, HSTS). El firmware debe usar `https://`.
* Despliega **cerca de la base** (Oregón, `us-west-2`): cada consulta a Supabase cuesta ~200 ms desde Chile; una trama tarda ~1,2 s
  en régimen estable y hasta ~5 s tras un período inactivo. En serverless usa el pooler en modo transacción (`DATABASE_PORT=6543`).
* Activa el 2FA obligatorio: `MFA_REQUIRED_ROLES=admin,owner`.
* **Rota la contraseña de `postgres`** (está en `env.txt` y en `dashboard/.env.admin.local`) y borra el `env.txt` cuando termines.
  Cambia o desactiva las cuentas demo (`Usuarios → Desactivar`).
* Este repositorio incluye archivos con credenciales (`env.txt`, `dashboard/.env.local`, `dashboard/.env.admin.local`, `dashboard/.demo-*`):
  **mantenlo PRIVADO** y no lo publiques ni lo compartas fuera del equipo.
* Programa `npm run db:retention` (90 días de datos crudos, luego promedios horarios) o `pg_cron`.

## Limitaciones conocidas

* El límite de intentos de inicio de sesión por IP es por instancia (en memoria); el bloqueo por cuenta sí es global.
* Por defecto **no hay datos simulados**. Para una demostración: `npm run db:seed -- --history 48` (historial sintético) y `npm run demo` (datos en vivo).
* Una sola réplica del servidor en el diseño actual; el barrido de «nodo fuera de línea» corre al recibir tramas y al abrir el panel.
