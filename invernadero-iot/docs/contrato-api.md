# Contrato nodo ↔ servidor (protocolo v1)

Este documento es la **fuente de verdad** del protocolo entre el nodo del invernadero
(`firmware/malla_espnow`, y el simulador) y el servidor (`dashboard`, ruta `POST /api/ingest`).
El firmware, el simulador y el dashboard se implementan contra este contrato.

Correspondencia con el informe: el informe define el camino
`nodo → LoRaWAN → ChirpStack → MQTT → ThingsBoard → PostgreSQL`. Aquí el último tramo se
reemplaza por **HTTP(S) → API del dashboard → Supabase (PostgreSQL)**. La carga útil (*payload*) es
independiente del transporte: si se vuelve a LoRaWAN, solo cambia quién entrega el JSON.

## 1. Transporte y autenticación

| Ítem | Valor |
|---|---|
| Endpoint | `POST {BASE_URL}/api/ingest` |
| Cabeceras | `Content-Type: application/json` · `Authorization: Bearer <TOKEN_DEL_NODO>` |
| Tamaño máximo | 4 KB (`413` si se excede) |
| Cadencia | la fija el servidor en `cfg.intervalo_s` (informe: 1 lectura cada 5 min = 300 s) |
| Separación mínima | 1 s entre tramas del mismo nodo (`429` + `Retry-After`) |

* **Cada nodo tiene su propio token** (32 bytes aleatorios, base64url). El servidor solo guarda su
  SHA-256; el token se muestra una única vez al dar de alta o rotar el nodo.
* **La identidad del nodo sale del token, nunca del cuerpo.** Un nodo no puede escribir datos de otro
  (equivale al «cada dispositivo solo publica en su propio tópico» del informe, tabla 11).
* `GET {BASE_URL}/api/health` → `200 {"ok":true}` sin autenticación, para probar conectividad.

## 2. Trama de telemetría (request)

```json
{
  "v": 1,
  "fw": "1.0.0",
  "boot": 3735928559,
  "seq": 42,
  "up": 12630,
  "temp": 24.3,
  "hum_aire": 61.2,
  "suelo_raw": 512,
  "luz": 18234,
  "viento": null,
  "bomba": 0,
  "riego_s": 0,
  "est": "idle",
  "esp": 0,
  "rssi": -61,
  "snr": null,
  "fallas": [],
  "ev": [
    { "t": "pump_on",  "why": "auto",       "ago": 95 },
    { "t": "pump_off", "why": "tiempo_max", "ago": 65, "dur": 30 }
  ],
  "acks": [
    { "id": "0b6c1a52-7c1e-4f0e-9a0c-2f3e7a9d1c11", "estado": "ejecutada", "detalle": "regando 20 s" }
  ]
}
```

| Campo | Tipo | Obligatorio | Descripción |
|---|---|---|---|
| `v` | int | sí | Versión del protocolo. Debe ser `1`. |
| `fw` | string ≤ 16 | sí | Versión del firmware. |
| `boot` | uint32 | sí | Número aleatorio elegido en cada arranque. Acota el contador `seq`. |
| `seq` | uint32 ≥ 1 | sí | Contador de tramas desde el arranque (+1 por trama nueva). Equivale al contador de trama de LoRaWAN. |
| `up` | uint32 | sí | Segundos desde el arranque (*uptime*). |
| `temp` | number \| null | sí | °C del DHT22. `null` si la lectura falló o cayó fuera de −40…80 °C. |
| `hum_aire` | number \| null | sí | % HR del DHT22 (0…100). `null` si falló. |
| `suelo_raw` | int \| null | sí | Lectura del YL-38 **en escala 0…1023** (ver §5). `null` si el sensor falló. |
| `luz` | number \| null | no | Lux del BH1750 (0…65535). Omitir o `null` si no hay sensor. |
| `viento` | number \| null | no | m/s del anemómetro. Solo el nodo del mástil. |
| `flujo_lmin` | number \| null | no | Caudal de agua instantáneo en L/min (0…200; sensor de pulsos tipo YF-S201). Fuera de rango se descarta y se anota la falla `flujo_rango`. |
| `bomba` | 0 \| 1 | sí | `1` = relé cerrado (bomba encendida). |
| `riego_s` | int | no | Segundos que lleva el ciclo de riego en curso (0 si está apagada). |
| `est` | string | no | Estado del controlador: `idle` · `riego` · `espera` · `bloq_temp` · `bloq_sensor` · `saturado`. |
| `esp` | int | no | Segundos que faltan para terminar la espera entre riegos (0 si no hay). |
| `rssi` | int | no | Potencia de señal (dBm). WiFi o LoRa. |
| `snr` | number \| null | no | Relación señal/ruido (dB). Solo enlaces LoRa. |
| `fallas` | string[] | no | Códigos activos: `dht`, `suelo`, `luz`, `viento`, `wifi`, `reinicio_wdt`. |
| `ev` | array | no | Eventos de la bomba ocurridos desde la última trama aceptada (máx. 8). Ver §2.1. |
| `acks` | array | no | Resultado de las órdenes recibidas (máx. 8). Ver §4. |

El nodo **no tiene reloj**: el servidor estampa la hora de llegada. `ago` (segundos antes de esta
trama) permite ubicar un evento que se reporta con retraso.

### 2.1 Eventos de la bomba (`ev`)

```
{ "t": "pump_on",  "why": "auto" | "manual",  "ago": <s>, "cmd": "<uuid opcional>" }
{ "t": "pump_off", "why": "objetivo" | "tiempo_max" | "orden" | "seguridad" | "saturado",
                   "ago": <s>, "dur": <s de riego>, "cmd": "<uuid opcional>" }
```

| `why` (apagado) | Significado |
|---|---|
| `objetivo` | La humedad llegó a `suelo_off` (fin normal del riego automático). |
| `tiempo_max` | Corte de seguridad por `riego_max_s`. Es el final **normal** de un riego (la sonda tarda en «ver» el agua); no es una falla por sí solo. |
| `orden` | Terminó la duración de una orden manual, o se recibió una orden `parar`. |
| `seguridad` | Se cortó por falla del sensor de suelo durante el riego. |
| `saturado` | Se cortó porque el suelo pasó a la banda SATURADO. |

**Alerta de anomalía de la bomba** (informe, tabla 10: «activaciones anómalas repetidas»): el servidor la levanta cuando hay **tres riegos
automáticos seguidos, cada uno iniciado a menos de tres esperas (`3 × espera_s`, 15 min por defecto) del anterior**, porque significa que el
suelo vuelve a secarse enseguida (bomba sin caudal, válvula cerrada, fuga o sensor manipulado). Se despeja sola cuando una lectura llega a
`suelo_off` o menos.

El servidor procesa los eventos de forma **idempotente**: un `pump_on` con un riego ya abierto o un
`pump_off` sin riego abierto se ignoran, de modo que reenviar eventos tras una respuesta perdida es seguro.

## 3. Respuesta (`200 OK`)

```json
{
  "ok": true,
  "t": "2026-09-28T22:52:48Z",
  "cfg": {
    "ver": 3,
    "intervalo_s": 300,
    "suelo_on": 700,
    "suelo_off": 500,
    "suelo_sat": 300,
    "temp_max": 40,
    "riego_max_s": 30,
    "espera_s": 300,
    "auto": 1
  },
  "ordenes": [
    { "id": "0b6c1a52-7c1e-4f0e-9a0c-2f3e7a9d1c11", "tipo": "riego", "dur_s": 20, "vence_s": 240 }
  ]
}
```

* `dup: true` aparece cuando la trama ya había sido recibida (mismo `boot` y `seq` ≤ último aceptado):
  se responde `200` con `cfg`/`ordenes` vigentes **sin reprocesar** el contenido. Así, reintentar tras
  perder la respuesta es seguro y un reenvío malicioso no duplica datos.
* Para el nodo del mástil (`kind = mast`) `cfg` solo trae `ver` e `intervalo_s`.
* `ordenes[].vence_s` es un tiempo **relativo** (el nodo no tiene reloj): el nodo calcula
  `limite = millis() + vence_s * 1000` y descarta la orden si lo supera.

### Códigos de error

| HTTP | Cuerpo | Qué debe hacer el nodo |
|---|---|---|
| 400 | `{"ok":false,"error":"invalid","detalle":[…]}` | Descartar la trama; revisar el firmware. |
| 401 | `{"ok":false,"error":"unauthorized"}` | Token desconocido, nodo deshabilitado o invernadero **dado de baja**. Reintentar en ≥ 60 s. **Seguir operando de forma autónoma.** |
| 413 | `{"ok":false,"error":"too_large"}` | Descartar la trama. |
| 429 | `{"ok":false,"error":"rate_limited"}` + `Retry-After` | Esperar lo indicado. |
| 5xx / sin red | — | Conservar `ev` y `acks` para la próxima trama y seguir operando. |

## 4. Órdenes (servidor → nodo)

| `tipo` | Campos | Efecto en el nodo |
|---|---|---|
| `riego` | `dur_s` (5…120) | Riego manual durante `dur_s` (recortado a `riego_max_s`). |
| `parar` | — | Apaga la bomba de inmediato si estaba encendida. |

El nodo responde en `acks` (idealmente en una trama inmediata tras ejecutar la orden):

```json
{ "id": "<uuid>", "estado": "ejecutada" | "rechazada", "detalle": "texto corto" }
```

El nodo **rechaza** una orden `riego` si: ya está regando · está en espera entre riegos (indicando los
segundos que faltan) · el suelo está SATURADO (< `suelo_sat`) · la orden venció. El nodo recuerda los
últimos ids atendidos para no ejecutar dos veces una orden que el servidor reentregue.

Las órdenes solo se crean en el dashboard tras una **confirmación en dos pasos** (solicitud +
reingreso de la contraseña) y solo para los sectores asignados al usuario (informe, tabla 11).

## 5. Escala del sensor de suelo (imagen de la clase)

El YL-38/YL-69 se interpreta en **escala 0…1023** (ADC de 10 bits), con las bandas de la imagen:

| Lectura | Banda | Significado |
|---|---|---|
| `0 – 299`   | `SATURADO` | Sumergido / muy húmedo: la sonda está en agua o en tierra completamente saturada. **No regar.** |
| `300 – 699` | `OPTIMO`   | Suelo húmedo / óptimo: humedad adecuada para la mayoría de las plantas. |
| `700 – 1023`| `SECO`     | Suelo seco / aire: tierra seca o el sensor está fuera del agua/suelo. **Regar.** |

El ESP32 tiene un ADC de 12 bits (0…4095); el firmware promedia 10 muestras en 12 bits y lo lleva a
10 bits con `raw10 = raw12 / 4`. Esa es la única lectura que viaja (`suelo_raw`). El **porcentaje** se
calcula en el servidor con la calibración del nodo (`cal_dry` = lectura en aire → 0 %; `cal_wet` =
lectura en agua → 100 %; por defecto 1023 y 0).

## 6. Configuración (`cfg`) y límites duros del nodo

El agrónomo ajusta los umbrales en el dashboard; el servidor los entrega en `cfg` y el nodo los
guarda en su memoria no volátil (NVS) para seguir operando sin servidor. Aun así, el nodo aplica
**límites propios** que ninguna orden ni configuración puede superar:

| Parámetro | Por defecto | Rango aceptado por el nodo |
|---|---|---|
| `intervalo_s` | 300 | 5 … 3600 |
| `suelo_on` (regar si `suelo_raw` ≥) | 700 | debe cumplirse `suelo_sat < suelo_off < suelo_on` |
| `suelo_off` (dejar de regar si `suelo_raw` ≤) | 500 | ídem |
| `suelo_sat` (SATURADO si `suelo_raw` <) | 300 | ídem |
| `temp_max` (no iniciar riego automático sobre esta °C) | 40 | 30 … 60 |
| `riego_max_s` (corte duro por ciclo) | 30 | 5 … 120 |
| `espera_s` (espera entre riegos) | 300 | 0 … 3600 (0 = sin espera; el nodo igual descansa 3 s) |
| `auto` (riego automático: `1` activado, `0` desactivado) | 1 | `0`/`1` o `false`/`true`; opcional (si falta, el nodo conserva el valor). Con `0` el nodo no inicia riegos por humedad: el riego manual, los calendarios y «detener» siguen funcionando |

Si la `cfg` recibida viola estas reglas, el nodo la **ignora completa** y conserva la anterior.

## 7. Lógica autónoma del nodo (resumen normativo)

1. Arranque en **estado seguro**: relé apagado.
2. Se muestrea cada `intervalo_s`; mientras la bomba está encendida, cada 5 s (respuesta rápida para cortar).
3. **Inicio automático** solo si: hay lectura válida de suelo y de temperatura · `suelo_raw ≥ suelo_on` ·
   `temp ≤ temp_max` · no está en espera entre riegos · el suelo no está SATURADO.
4. **Fin** por: `suelo_raw ≤ suelo_off` (`objetivo`) · `riego_max_s` (`tiempo_max`) · falla del sensor de
   suelo (`seguridad`) · banda SATURADO (`saturado`) · orden (`orden`).
5. El **corte por tiempo se evalúa en cada vuelta del bucle principal**, no solo al muestrear.
6. Terminado un riego, empieza `espera_s` antes de otro (protege el motor de arranques repetidos).
7. Sin conexión o sin servidor, el riego automático **sigue funcionando** con la última `cfg` guardada.

## 7. JSON de otros nodos (ingest tolerante) y ruta de llegada

Desde la migración 0009 el servidor acepta tramas de nodos que no son de este proyecto (otro grupo, otro firmware):

* **Solo `seq` es obligatorio** (≥ 1): sin él no se puede descartar un duplicado. Lo demás, si falta, toma un valor por defecto:
  `fw = "desconocido"`, `boot = 0`, `up = 0`, sensores `= null`. Si falta `bomba` no se sabe nada de riegos: **no se abre ni se cierra ninguno**.
* **Nombres alternativos** (el canónico gana si vienen los dos): `temperature`/`temperatura`/`temp_c` → `temp` · `humidity`/`humedad_aire`/`hum_air` → `hum_aire` ·
  `soil`/`soil_raw`/`suelo`/`soil_moisture` → `suelo_raw` · `lux`/`light` → `luz` · `wind` → `viento` · `pump`/`pump_on`/`relay` → `bomba` (acepta `true`/`false`) ·
  `flujo`/`caudal`/`flow`/`flow_rate`/`water_flow` → `flujo_lmin` · `sequence`/`counter` → `seq` · `uptime` → `up` · `firmware`/`version` → `fw` · `faults` → `fallas`. Lista completa: `ALIASES` en `src/lib/ingest/normalize.ts`.
* **Campos desconocidos** se guardan tal cual en `readings.extra` (máx. 20 claves / 2000 caracteres). El último JSON completo queda en `node_state.raw`.
* **Se descarta, sin rechazar la trama**: `est` desconocido, `rssi` fuera de −160…0, elementos inválidos de `ev`, `acks` y `fallas`, `fw` largo (se recorta a 16).
* **Se sigue rechazando (400)**: `seq` ausente o < 1, `v` distinta de 1, `boot` fuera de uint32, `bomba` distinta de 0/1/booleano, sensores con tipo equivocado (`temp: "24"`).
* `suelo_raw` debe estar en 0…1023; fuera de rango se descarta y se anota la falla `suelo_rango` (un sensor de 12 bits debe escalarse antes de enviar).

Cada lectura guarda además **por dónde llegó**: `transport` (`mqtt` | `http` | `espnow`), `via` (nodo de la malla que la subió, o null) y `hops` (saltos por radio).
`POST /relay/<id>` (pasarela, puerto 3100) lleva esa información en las cabeceras `X-Via` y `X-Saltos`; ver `docs/malla-espnow.md`.

**Modo abierto y cambio de nombre (solo pruebas, `ACEPTAR_NODOS_NUEVOS=1`).** La `<id>` de `/relay/<id>` (y del tema MQTT `invernadero/<id>/tx`) es el id del chip, p. ej. `nodo-85bbc8`; la credencial es el identificador que va dentro del mensaje (p. ej. `GrupoSavka`). La pasarela liga cada `<id>` a su nodo (`iot.open_devices`): si llega un identificador desconocido desde un `<id>` ya ligado a un invernadero activo, **renombra** ese invernadero (nombre, código si es válido y está libre, y la credencial) en lugar de crear otro; queda en la bitácora como `device.rename`. En modo normal (con tokens) no se usa.
