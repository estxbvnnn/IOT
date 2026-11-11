# Malla ESP-NOW: los invernaderos se cubren entre sí y solo la Pi sube a la nube

Es el diagrama del proyecto ([`diagrama-objetivo.jpeg`](diagrama-objetivo.jpeg)). Código de las placas: `firmware/malla_espnow/malla_espnow.ino` (mismo sketch, tres perfiles).
Puente con la Pi: `dashboard/scripts/puente-serie.ts`. Pasarela: `dashboard/scripts/gateway.ts` (`POST /relay/<id>`). Envío a la nube: `dashboard/scripts/uplink.ts`.

```
 nodo (PERFIL 0) ──ESP-NOW──► nodo vecino ──ESP-NOW──► CONCENTRADOR (PERFIL 1) ──USB @RX──► puente ──POST /relay/nodo-<origen>──► pasarela ──► PostgreSQL
      ▲              (retransmite, TTL-1)                                                     (X-Via, X-Saltos)                       │      │
      └───────────── respuesta cifrada (misma clave de un solo uso), vuelve por inundación ◄──── @TX ◄── puente ◄────────────────────────┘      └─ uplink cada 5 s ─► AWS
```

## Qué hace cada placa
**Nodo (`PERFIL 0`)**
1. Cada `PERIODO_S` (10 s) arma su JSON (`temp`, `hum_aire`, `suelo_raw`, `flujo_lmin`, `vecinos`, `conc`…), lo cifra **para el servidor** (RSA-2048 + AES-256-GCM de un solo uso; el nodo solo lleva la clave *pública*) y lo **difunde por ESP-NOW** con `ttl = MAX_SALTOS` (3). No usa WiFi: todas las placas comparten el `CANAL` fijo.
2. Espera la respuesta 15 s; reintenta hasta 3 veces.
3. Cualquier mensaje de otro nodo que oiga lo **retransmite** (cada fragmento con `ttl-1`, tras un retardo aleatorio de 5–60 ms). Una caché de 64 entradas `(tipo, origen, seq, fragmento, intento)` evita que los mensajes den vueltas.
4. Cada 30 s emite una **baliza** (`TIPO_HOLA`) que se propaga con TTL; con ellas cada nodo sabe cuántos nodos de la malla se oyen (`vecinos`) y si ve al concentrador (`conc`).

**Concentrador (`PERFIL 1`)**: no mide. Cada mensaje de datos que oye lo reensambla y lo escribe por USB: `@RX <origen> <seq> <intento> <saltos> <via> <mensaje>`. El puente lo sube a la pasarela y devuelve `@TX …`, que el concentrador difunde por la malla hacia el origen. No abre el contenido.

**Nodo con WiFi (`PERFIL 2`, respaldo)**: como el nodo, pero si tiene WiFi y la pasarela responde, sube por HTTP (`POST /relay/nodo-<id>`) y también sube lo de los vecinos. Solo este perfil necesita `config_local.h`.

**Los relevos y el concentrador no abren nada.** Solo la pasarela descifra. La identidad del nodo va dentro del mensaje cifrado (en modo de pruebas, un **identificador** como `nodo-8d572e`; en producción, el token de su invernadero), así que el dato queda en el nodo correcto aunque lo suba otro.

## Formato del paquete (`MAGIA 0xE6`)
`0xE6 | tipo | id(4) | seq(4) | idx(4 bits)+ttl(4 bits) | total(4 bits)+intento(4 bits) | fragmento ≤ 238 B`
`tipo 0x11` = datos hacia el servidor (id = nodo de origen) · `0x12` = respuesta (id = nodo al que va) · `0x13` = baliza (1 byte: bit0 = soy el concentrador). Mensaje máximo: 6 fragmentos (1428 B).

## En el dashboard
- `POST /relay/<id>` acepta la **misma carga que iría por MQTT** (claro, Base64, AES o `rsa1:`) y responde con el texto que iría a `…/rx`. Con `X-Via` queda como transporte `espnow`.
- El ingest es **tolerante** (ver `docs/contrato-api.md` §7): solo `seq` es obligatorio, entiende nombres alternativos (`temperature`, `caudal`, `soil`…), conserva lo que no conoce en `extra` y descarta —sin rechazar la trama— lo opcional mal formado.
- Cada lectura guarda `transport` (`mqtt` | `http` | `espnow`), `via`, `hops`, `boot`, `extra` y `flow_lmin`; el último JSON completo queda en `node_state.raw`. La tabla de **Equipos** muestra «Directo» o «Vía nodo-xxxx · N salto(s)»; el detalle de cada invernadero y la tabla del predio muestran el **flujo de agua**.
- Migraciones: `0009_origen_ruta.sql` (ruta), `0010_flujo_agua.sql` (flujo), `0011_uplink_nube.sql` (avance del envío a la nube), `0012_dispositivos_abiertos.sql` (chip → nodo en modo abierto; no se sincroniza). Las columnas nuevas van al final y en el mismo orden: si una base copia con `sync` y no las tiene, `readings` se omite con un aviso.

## Envío a la nube (Pi → AWS, cada 5 s)
Servicio `uplink`: toma las lecturas nuevas (`iot.readings`) y las manda en lotes JSON por HTTPS a `AWS_UPLINK_URL`, **cifradas con la clave pública de AWS** (mismo formato `rsa1:`; tema autenticado `invernadero/uplink/pi`). Solo quien tenga la clave privada de AWS puede abrirlas.
El cursor (`iot.uplink_state`) avanza solo si AWS responde 2xx; si no hay internet, reintenta el mismo lote y no se pierde nada. Variables: `AWS_UPLINK_URL`, `AWS_UPLINK_API_KEY` (cabecera `x-api-key`), `AWS_PUBLIC_KEY_FILE`, `UPLINK_INTERVAL_S` (5), `UPLINK_BATCH` (200).
Sin `AWS_UPLINK_URL` queda inactivo. `npm run aws:mock` levanta una «AWS de mentira» (puerto 4010) que descifra y guarda lo recibido en `secrets/aws-mock-recibido.jsonl`.
El formato de cada lectura del lote está en `dashboard/scripts/lib/uplink-core.ts` (`toReading`): si la API real pide otros nombres de campo, se cambia ahí.

## Probar con el PC en lugar de la Raspberry Pi
1. Arranque Docker Desktop. En `invernadero-iot`:
   `docker compose --env-file .env --env-file .env.pc up -d --build postgres migrate gateway dashboard`
   (`.env.pc` es solo del PC, está fuera de git y activa `ACEPTAR_NODOS_NUEVOS=1`).
2. **Placas** (no necesitan WiFi): sube `PERFIL 1` a una (concentrador, por USB al PC) y `PERFIL 0` a las demás. El `CANAL` debe ser igual en todas.
3. **Puente** (en `dashboard/`): `npm run puente -- COM4` (el puerto del concentrador; cierre antes el Monitor Serie). Debe decir `Concentrador conectado`.
4. **La clave pública pegada en `malla_espnow.ino` debe ser la del servidor que recibe** (la privada vive solo allí, en `secrets/mqtt-rsa-private.pem`, fuera de git; `docker compose` la monta). Desde el 11-nov-2026 el `.ino` lleva la pública de la **Raspberry Pi** (huella `89a778731578188e`, la que muestra el registro de su pasarela); antes llevaba la del PC (`8def8cac15aa45cb`). Para cambiarla: `node firmware/malla_espnow/pegar-claves.mjs firmware/malla_espnow/malla_espnow.ino --socio publica-del-servidor.pem`. Si no coinciden, la pasarela responde 400 y las placas nunca reciben respuesta. En modo de pruebas el registro de la pasarela dice `MODO ABIERTO` y `RSA-2048 (clave privada cargada …)`.
5. **Sin tokens**: cada grupo pone su nombre en `#define NOMBRE_NODO "grupo-2"` (distinto en cada placa; vacío = `nodo-<chipid>` automático); el nodo se da de alta solo en el dashboard (un invernadero por identificador). **Si cambia el nombre de una placa y la vuelve a subir, no se duplica**: la pasarela recuerda qué chip (`nodo-xxxxxx`, el de la ruta `/relay`) es cuál (tabla `iot.open_devices`, migración 0012) y renombra su invernadero conservando el historial, los umbrales y el lugar en el mapa (bitácora: «Nodo renombrado»). Excepciones: si el invernadero de ese chip está archivado se crea uno nuevo (no se reactiva solo), y si el nombre nuevo ya es de otro invernadero, la trama entra en ese. Dos placas con el mismo nombre son el mismo invernadero.
6. **Firewall** solo si usa `PERFIL 2` (WiFi) u otros equipos hacen POST a la pasarela: `.\scripts\firewall-pasarela-pc.ps1 -Abrir` (PowerShell como administrador; solo red privada y subred local); estado con `-Estado`; **revertir** con `-Cerrar`. El puente corre en el mismo PC y usa `localhost`: no necesita abrir nada.
7. **Nube de prueba**: `npm run aws:mock` y, con `AWS_UPLINK_URL=http://host.docker.internal:4010/ingest` y `AWS_PUBLIC_KEY_FILE=/run/secrets/aws-mock-public.pem` en el entorno, `docker compose --env-file .env --env-file .env.pc up -d uplink`.
8. **Al terminar** (revertir todo): `-Cerrar` del firewall (si lo abrió), `docker compose --env-file .env --env-file .env.pc down`, borrar `.env.pc` (o `ACEPTAR_NODOS_NUEVOS=0`) y parar `aws:mock`. El modo abierto acepta cualquier identificador y **no debe usarse en producción**.

## Mapa del predio
En modo abierto cada nodo nuevo se coloca en el hueco libre más cercano a la subestación (la misma regla que la pantalla *Invernaderos*, `suggestPosition`); si el predio se llena, crece hacia abajo. Nunca se superponen ni se salen del mapa.

### Escenarios con 2 placas (nodo N y concentrador C)
| # | Configuración | Qué debe pasar |
|---|---|---|
| 1 | N con `PERFIL 0`, C con `PERFIL 1`, puente en marcha | N: `>> RADIO envio…` y luego `<< respuesta recibida (por la malla)`. Puente: `<< nodo-… (1 salto…) → pasarela` y `>> respuesta…`. Equipos: «Vía nodo-concentrador · 1 salto». |
| 2 | Apague el concentrador | N: `sin respuesta… reintento` ×3 y «lo doy por perdido»; no hay otra ruta. |
| 3 | Pare el puente y vuélvalo a arrancar | El concentrador repite `@HOLA` cada 20 s; el puente lo reconoce y sigue. |
| 4 | N con `PERFIL 2` y WiFi | Sube directo («Directo · HTTP»); sin red cae a la radio. |
Con 2 placas solo se prueba **1 salto**. El reenvío con varios saltos (`reenvio fragmento…`) se probaría con una tercera placa entre N y C.

## Límites (léalos antes de confiar en esto)
- **Probado en placas solo en pequeño (11-nov-2026):** un concentrador y dos nodos, 1 salto. La ruta placa → radio → concentrador → USB → puente → pasarela de la Pi → base de datos funcionó (las lecturas quedan con `transport=espnow`, `via`, `hops=1`). **No confirmado:** que la respuesta vuelva siempre al nodo (una placa repitió un `seq` tres veces) y el reenvío con varios saltos (`reenvio fragmento…`); con 10 nodos queda por ver la saturación de la radio.
- Hace falta **al menos un concentrador** conectado a la Pi. Si falla, ningún dato llega.
- Todas las placas deben usar el **mismo canal**; con WiFi (`PERFIL 2`) manda el canal del router.
- Una trama que llegue **después** de otra con `seq` mayor (ruta lenta) se descarta como duplicada (`seq <= last_seq`).
- Difusión sin confirmación de entrega por fragmento: si se pierde uno, el origen reintenta el mensaje completo (hasta 3 veces). Con 10 nodos hay que vigilar la saturación de la radio.
- `POST /relay` no pide autenticación HTTP: quien llegue al puerto 3100 puede enviar cargas. Con `ACEPTAR_NODOS_NUEVOS=0` hace falta un token válido dentro; en modo abierto basta cualquier identificador (límite de 60 invernaderos autocreados). Con `MQTT_CIFRADO=exigir-rsa` además deben ir cifradas con la clave pública. No exponga el puerto fuera de la red local.
- Los nodos no tienen par de claves propio (el diagrama lo sugiere): cifran con la clave pública de la Pi y abren la respuesta con la clave de un solo uso.
