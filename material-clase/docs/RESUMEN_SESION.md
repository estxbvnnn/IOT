# Resumen de la sesión (6–7 oct 2026) — memoria del proyecto

Proyecto: **invernadero IoT** (dashboard Next.js + Supabase + nodo ESP8266 NodeMCU con DHT22, YL-38 y bomba por relé).
Este archivo resume lo hecho, lo aprendido y lo pendiente. Las credenciales NO están aquí: ver `dashboard/.demo-credentials.md`.

## 1. Estado actual (al terminar la sesión)
- **Funciona de punta a punta:** nodo → servidor → dashboard. El riego manual se ordena desde el dashboard (o por USB con `r`), el nodo lo ejecuta, la bomba corta por tiempo y el dashboard registra el riego.
- **Sin conectar (hardware):** DHT22 y sensor de suelo YL-38. Mañana se prueba con los sensores reales y la planta.
- El nodo I1 reporta cada ~15 s (intervalo de prueba 10 s). Estado `bloq_sensor` mientras el suelo no tenga sensor: bloquea solo el riego **automático**.
- Tests: `npm test` (169 unitarios) y `npm run test:db` (85 de BD) pasan. El sketch compila sin avisos con arduino-cli.

## 2. Qué se construyó / cambió
**Dashboard (`dashboard/`)**
- Rol **`superadmin`** (cuenta de pruebas): todos los permisos del admin + riego manual **sin confirmación en 2 pasos**, sin tope de duración del servidor, reemplaza órdenes pendientes, sesión sin cierre por inactividad. Solo otro superadmin puede crear/modificar uno. Migración `0004_superadmin_role.sql`; script `npm run db:superadmin [-- --reset]`.
- **Interruptor "Riego automático"** por invernadero (`auto_enabled`, migración `0005_auto_riego.sql`; viaja al nodo como `cfg.auto`; componente `auto-irrigation-switch.tsx`, acción `setAutoIrrigationAction`). Solo lo cambian quienes tienen `thresholds:edit`.
- Respuestas JSON de la API con **`Content-Length`** (`src/lib/http.ts`) en vez de chunked.
- `next.config.ts`: `allowedDevOrigins: ['192.168.1.26']` (sin esto los botones no funcionan al abrir por la IP del PC en `dev:lan`).
- Tests nuevos/ajustados: superadmin, auto-riego, sensor de suelo desconectado, y los tests de `queries.test.ts` ahora traen sus propios datos.
- Docs: `docs/contrato-api.md` incluye `cfg.auto`.

**Firmware (`firmware/nododefinitivo/nododefinitivo.ino`, archivo único)**
- Lectura del cuerpo de la respuesta HTTP arreglada (`getString()` + `availableForWrite()`): **antes el nodo leía 0 bytes y nunca aplicaba configuración ni órdenes** (causa raíz de "regar no hace nada").
- Suelo con lectura < `SUELO_RAW_MIN_VALIDO` (20) = **sensor desconectado** (falla `suelo`, `bloq_sensor`), no "saturado".
- `riego_auto` activable desde el dashboard (parámetro `auto` de la cfg, guardado en flash; `CFG_MAGIA` 0xC0F16A03).
- (`PRUEBA_SIN_DHT` fue eliminada el 10 oct 2026, con el DHT22 ya funcionando.)
- **Tabla de estado** por el Monitor Serie cada `TABLA_SERIAL_S` = 10 s (0 = formato antiguo).
- Diagnóstico: `RED: respuesta 200 ilegible (N bytes): ...` si el nodo no puede leer la respuesta.

## 3. Causas raíz encontradas (útil si vuelve a pasar)
| Síntoma | Causa |
|---|---|
| "Regar" no hacía nada en el navegador | Se entraba por `192.168.1.26:3000`; Next en dev bloquea sus recursos (hidratación) para ese origen → `allowedDevOrigins` |
| Órdenes "entregadas" pero nunca ejecutadas; config nunca aplicada | El nodo leía 0 bytes del cuerpo (Print sin `availableForWrite`) |
| Riego manual rechazado "suelo saturado" | Suelo sin sensor leía 4–6 (< `soil_sat`=300); A0 flota con el divisor de la NodeMCU |
| NodeMCU/placa sin puerto COM | Driver FTDI (FT232R) no instalado; Windows Update de drivers desactivado (`SearchOrderConfig=0`). Se instaló con `pnputil` el paquete `CDM-v2.12.36.20` → **COM6** |
| Audit ocultaba un campo `bypass` | El redactor oculta claves que contienen `pass`/`token`/`secret`; usar otro nombre (`sinConfirmacion`) |

## 4. Entorno / cómo operar
- Ruta: `C:\Users\matia\Desktop\IOT-main\invernadero-iot\` (`dashboard/`, `firmware/nododefinitivo/`, `supabase/migrations/`, `docs/`).
- Servidor: `cd dashboard && npm run dev:lan` → `http://localhost:3000` o `http://192.168.1.26:3000` (IP del PC por Ethernet; si cambia, actualizar `SERVER_URL` en el sketch y `allowedDevOrigins`).
- BD: Supabase (pooler). Migraciones: `npm run db:migrate`. Tests BD: `npm run test:db` (cada test hace rollback).
- Compilar el sketch: `"%LOCALAPPDATA%\Programs\Arduino IDE\resources\app\lib\backend\resources\arduino-cli.exe" compile --fqbn esp8266:esp8266:nodemcuv2 --warnings all firmware\nododefinitivo` (core esp8266 3.1.2, ArduinoJson 7.4.3, DHT 1.4.7). Subir con el Arduino IDE (placa NodeMCU 1.0, COM6, 115200).
- Cuenta de pruebas: `superadmin@invernadero.local` (clave en `dashboard/.demo-credentials.md`).
- WiFi del nodo en el sketch: red `HUAWEI-Vdt4`; token del nodo I1 en el sketch (repositorio PRIVADO).

## 5. Cableado de referencia (del sketch)
- Relé: DC+ → VIN (5 V), DC- → GND, IN → **D6**; potencia: COM y NO (nunca NC); diodo 1N4007 en paralelo con la bomba; jumper del relé en **H**.
- DHT22: DATA → **D5**, VCC → 3V3, GND, 10 kΩ DATA–3V3.
- YL-38: AO → **A0**, VCC → **D7**, GND → GND.

## 6. Valores temporales de prueba (revertir) — ver `PRUEBA_TEMPORALES.md`
I1: `soil_sat` = 1 (definitivo 300), reporte cada 10 s (definitivo 300), `PRUEBA_SIN_DHT = 1` [ELIMINADA] (definitivo 0), consola USB activa, WiFi/IP/token en el sketch, `allowedDevOrigins`, cuenta superadmin. El riego automático de I1 está **desactivado** en el dashboard (activarlo cuando todo esté conectado y la bomba tenga agua).

## 7. Pendiente / siguiente paso (mañana)
1. Conectar DHT22 y YL-38 reales (ver sección 5) y revisar la tabla del Monitor Serie: temperatura/humedad válidas, suelo ≈ 350 en agua y ≈ 1000 al aire.
2. Revertir los valores temporales (sección 6); poner `PRUEBA_SIN_DHT` en 0 y volver a subir el sketch.
3. Probar el **riego automático**: tierra seca (≥ 700) con el interruptor activado → debe regar solo, luego esperar 5 min.
4. Verificar físicamente relé/bomba (clic, LED, giro); no hay protección contra marcha en seco.

## 8. Cosas que NO pude hacer / limitaciones
- El entorno bloqueó dos ediciones: agregar `superadmin` a la lista de roles de `src/lib/env.ts` (solo afecta `MFA_REQUIRED_ROLES`) y una constante `MANUAL_MAX_S` en `irrigation-panel.tsx` (en pantalla el súper admin sigue limitado al máximo del invernadero; el servidor sí lo permite).
- Las pruebas de host de `firmware/test/` no se pueden correr: sus cabeceras (`riego.h`, `envio.h`, `protocolo.h`) no están en el repositorio (solo el archivo único generado).
- Nunca se probó el riego automático con sensores reales.
- Riesgos conocidos del firmware: si la placa se reinicia entre ejecutar una orden y enviar su acuse, el servidor puede reentregarla; sin sensor de nivel no hay protección contra bomba en seco.

## 9. Raspberry Pi Pico W (agregado después) — ELIMINADO el 13 oct 2026 (ver sección 12)
- Sketch nuevo: `firmware/nodo_pico_w/nodo_pico_w.ino`, derivado de `nododefinitivo.ino` (misma lógica de riego, protocolo, tabla Serial y riego automático). Compila con `arduino-cli compile --fqbn rp2040:rp2040:rpipicow` (core `rp2040:rp2040` 6.2.0 de Earle Philhower, instalado en `%LOCALAPPDATA%\Arduino15`).
- Pines: DHT22 → GP2 (pin 4), YL-38 VCC → GP3 (pin 5), YL-38 AO → GP26/ADC0 (pin 31), relé IN → GP6 (pin 9), relé DC+ → VBUS (pin 40), BH1750 SDA/SCL → GP4/GP5.
- Usa el mismo WiFi, SERVER_URL y DEVICE_TOKEN del NodeMCU: usar UNA sola placa a la vez (o crear otro nodo/token).
- Un Raspberry Pi 4/5/Zero (Linux) NO ejecuta .ino; este sketch es solo para Pico W / Pico 2 W.
- Aún NO probado en la placa real.

## 10. Arquitectura decidida el 7 oct: NodeMCU → Raspberry Pi 5 (gateway) → Supabase — REEMPLAZADA el 13 oct 2026 (ver sección 12)
- Decidido con el usuario: la **Pi 5 es solo gateway** (no riega ni mide); recibe las tramas de la NodeMCU, las guarda y **cada 60 s las escribe directo en Supabase** (rol `iot_app`).
- Implementado en `dashboard/scripts/gateway.ts` + `scripts/lib/gateway-core.ts` (reutiliza `handleIngest` del dashboard: validación, alertas, órdenes, cfg; conserva la hora real de cada trama con `now`). Cola en disco (`.gateway/cola`), respuestas (cfg + órdenes) en `.gateway/respuestas.json`. Comando: `npm run gateway` (puerto 3100). Guía: `docs/gateway-raspberry.md`; servicio: `dashboard/scripts/gateway.service`.
- Pendiente del usuario: en la Pi instalar Node 22, copiar el proyecto, crear `dashboard/.env.local` (credenciales `iot_app`), arrancar `npm run gateway`, y en la NodeMCU cambiar `SERVER_URL` a `http://IP_DE_LA_PI:3100` y re-subir el sketch.
- Las órdenes/umbrales desde el dashboard tardan 1–2 min en llegar al nodo (envío de 60 s + intervalo del nodo). "En línea" del dashboard aguanta envíos de hasta ~75 s.
- Tests: `tests/unit/gateway.test.ts` (15, con ingest simulado: no toca Supabase). Total unitarios: 184.
- `firmware/nodo_pi5/` (Pi como nodo con DHT22/YL-38 DO/relé) queda **sin uso** en esta arquitectura; sus 25 pruebas pasan (`python -m unittest test_nodo_pi5`).

## 11. Cambios del 10 oct 2026
- Esperas del sketch más cortas (loop 1 ms, medición del suelo ~60 ms), pasarela cada 2 s, refresco del dashboard cada 3 s.
- El riego automático no arranca durante los primeros 20 s tras encender (`ARRANQUE_SIN_RIEGO_S`).
- Espera entre riegos permitida en 0 (migración `0006_espera_sin_minimo.sql`; el nodo mantiene una pausa técnica de 3 s). I1 quedó con espera 0.
- Eliminada `PRUEBA_SIN_DHT`.

## 12. Cambio de arquitectura del 13 oct 2026: la Pi es el sistema completo (Postgres local + dashboard + API) y copia a Supabase cada 5 min
- Flujo: NodeMCU --MQTT--> Mosquitto --> pasarela --> **PostgreSQL local de la Pi** <-- dashboard Next.js (:3000, API `/api/v1`); el servicio `sync` copia a Supabase cada 300 s (un solo sentido). **Funciona sin internet** en la red local.
- La pasarela ya no tiene cola en disco ni caché: procesa cada trama al instante con `handleIngest` contra la base local (`scripts/gateway.ts`, `scripts/lib/gateway-core.ts`). El nodo recibe su cfg/órdenes reales en cada trama.
- Nuevo: `docker-compose.yml` (postgres, migrate, mosquitto, gateway, dashboard, sync + herramientas `bootstrap` y `tools`), `dashboard/Dockerfile.dashboard`, `Dockerfile.gateway`, migración `0007_api_keys_sync.sql` (claves de API y cursores de sincronización).
- Sincronización: `scripts/sync.ts` + `scripts/lib/sync-core.ts`; arranque inicial `scripts/sync-bootstrap.ts` (copia lo de Supabase a la Pi conservando tokens de nodos, usuarios y hashes de la bitácora). `sync` no sube nada hasta que se haga el arranque inicial.
- API REST: `src/app/api/v1/**`, `src/lib/api/v1.ts`, `src/lib/auth/api-key.ts`, script `npm run api:key`. Documentada en `docs/api-v1.md`. Las claves actúan con el rol y alcance de un usuario.
- Eliminado: `firmware/nodo_pico_w/`, `firmware/nodo_pi5/` y `dashboard/scripts/gateway.service`. Se conserva el resto del firmware ("por ahora").
- Pruebas: unitarias de la pasarela reescritas; `tests/db/sync.test.ts` (10 pruebas con una segunda base temporal como «Supabase»). Las ~85 pruebas de BD pasan (84 + 1 sensible a los datos sembrados) en un PostgreSQL 17 común, no solo en Supabase.
- Guía: `docs/gateway-raspberry.md`. Pendiente conocido: hora de la Pi sin internet (pila del RTC o chrony).
- **Ronda de pruebas previa a la entrega (13 oct, noche):** resultados completos en `docs/pruebas.md`. Hallazgo importante: la cadena de hashes de la bitácora se bifurcaba con escrituras concurrentes (defecto de la 0001); corregido con la migración `0008_audit_chain_concurrency.sql` y la prueba `tests/db/audit-chain.test.ts`. Supabase NO tiene la 0008 (no la necesita para la copia). Nuevos: `dashboard/scripts/e2e.ts` (63 comprobaciones de la interfaz), `SYNC_DRY_RUN=1`, `scripts/{deploy-pi,demo-pc,prueba-hardware}.ps1`, `docs/entrega.md` (runbook, guion de demo, plan B). Totales: 190 unitarias, 105 de BD, 70 de firmware.

