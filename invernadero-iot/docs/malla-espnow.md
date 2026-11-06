# Malla ESP-NOW: los nodos se cubren entre sí y solo la Pi sube a la nube

Código del nodo: `firmware/malla_espnow/malla_espnow.ino` (mismo sketch para todos). Pasarela: `dashboard/scripts/gateway.ts` (`POST /relay/<id>`).

```
 nodo sin ruta ──ESP-NOW──► vecino sin red ──ESP-NOW──► vecino CON red ──POST /relay/nodo-<origen>──► pasarela (Pi, o el PC que la simula)
      ▲                         (retransmite, TTL-1)       (la sube y avisa: X-Via, X-Saltos)                   │ guarda en PostgreSQL
      └───────────── respuesta cifrada (misma clave de un solo uso), vuelve por inundación ◄──────────────────┘ y el «sync» copia a Supabase
```

## Qué hace cada nodo
1. Cada `PERIODO_S` arma su JSON, lo cifra **para el servidor** (RSA-2048 + AES-256-GCM de un solo uso; el nodo solo lleva la clave *pública*) y lo manda a la pasarela por WiFi.
2. Si no hay WiFi, o la pasarela no responde 2 veces seguidas (o `FORZAR_RADIO 1`), lo **difunde por ESP-NOW** con `ttl = MAX_SALTOS` (3) y espera la respuesta 15 s; reintenta hasta 3 veces. Pasados 60 s vuelve a probar la red.
3. Cualquier nodo que oiga un mensaje de otro:
   - **con red** → lo sube (`POST /relay/nodo-<origen>`, cabeceras `X-Via` y `X-Saltos`), y difunde la respuesta de la pasarela hacia el origen;
   - **sin red** → retransmite cada fragmento con `ttl-1` tras un retardo aleatorio de 5–40 ms.
   Una caché de 32 entradas `(tipo, origen, seq, fragmento, intento)` evita que los mensajes den vueltas.
4. **Los relevos no abren nada.** Solo la pasarela descifra. La identidad del nodo va dentro del mensaje cifrado (en modo de pruebas, un **identificador** como `GRUPO-A`; en producción, el token de su invernadero), así que el dato queda en el nodo correcto aunque lo suba otro.

## Formato del paquete (versión nueva, `MAGIA 0xE6`, no se mezcla con otros firmwares)
`0xE6 | tipo | id(4) | seq(4) | idx(4 bits)+ttl(4 bits) | total(4 bits)+intento(4 bits) | fragmento ≤ 238 B`
`tipo 0x11` = datos hacia el servidor (id = nodo de origen) · `0x12` = respuesta (id = nodo al que va). Mensaje máximo: 6 fragmentos (1428 B).

## En el dashboard (qué cambió)
- `POST /relay/<id>` acepta la **misma carga que iría por MQTT** (claro, Base64, AES o `rsa1:`) y responde con el texto que iría a `…/rx`. Con `X-Via` queda como transporte `espnow`.
- El ingest ahora es **tolerante** (ver `docs/contrato-api.md` §7): solo `seq` es obligatorio, entiende nombres alternativos (`temperature`, `humidity`, `soil`…), conserva los campos que no conoce en `extra` y descarta —sin rechazar la trama— lo opcional mal formado.
- Cada lectura guarda `transport` (`mqtt` | `http` | `espnow`), `via`, `hops`, `boot` y `extra`; el último JSON completo queda en `node_state.raw`. La tabla de **Equipos** muestra «Directo» o «Vía nodo-xxxx · N salto(s)» y el «Último JSON» de cada nodo.
- Migración `supabase/migrations/0009_origen_ruta.sql`: **aplíquela a la base local y a Supabase** (`npm run db:migrate` contra cada una). Las columnas nuevas van al final y en el mismo orden; si una base no la tiene, el «sync» omite `readings` con un aviso.

## Probar con el PC en lugar de la Raspberry Pi
1. Arranque Docker Desktop. En `invernadero-iot`:
   `docker compose --env-file .env --env-file .env.pc up -d postgres migrate gateway dashboard`
   (`.env.pc` es solo del PC, está fuera de git y activa `ACEPTAR_NODOS_NUEVOS=1`; el `sync` solo si quiere copiar a Supabase).
   Los nodos y el PC deben estar en la **misma red WiFi**; use la IP del PC (`ipconfig`) como `GATEWAY_HOST`.
2. Firewall de Windows (PowerShell **como administrador**, lo ejecuta usted). Solo red privada y solo subred local:
   - abrir: `.\scripts\firewall-pasarela-pc.ps1 -Abrir` (o `-Abrir -Horas 6` para que se cierre solo)
   - estado: `.\scripts\firewall-pasarela-pc.ps1 -Estado`
   - **revertir**: `.\scripts\firewall-pasarela-pc.ps1 -Cerrar` (borra solo la regla «IoT pasarela PC (prueba)» y la tarea de cierre)
3. La clave del «servidor PC» está en `secrets/mqtt-rsa-private.pem` (fuera de git; `docker compose` la monta) y su pública ya está pegada en `malla_espnow.ino`.
   El registro de la pasarela debe decir `MODO ABIERTO` y `RSA-2048 (clave privada cargada · huella pública 8def8cac15aa45cb)`.
4. **Sin tokens**: todas las placas llevan el mismo `.ino`. `MI_ID ""` hace que cada placa se llame `nodo-<chipid>`; o ponga `MI_ID "GRUPO-A"` (1–40 caracteres `A-Z a-z 0-9 _ -`). El nodo se da de alta solo en el dashboard (un invernadero por identificador). Ajuste `WIFI_SSID`, `WIFI_PASS`, `GATEWAY_HOST` y suba. Para 2 placas de prueba use `PERFIL 1` (GRUPO-A, sube por la red) y `PERFIL 2` (GRUPO-B, siempre por radio) **en el mismo archivo**, cambiando solo ese número antes de subir a cada placa.
5. **Al terminar las pruebas** (revertir todo): `-Cerrar` del firewall, `docker compose --env-file .env --env-file .env.pc down` y borrar `.env.pc` (o poner `ACEPTAR_NODOS_NUEVOS=0`). El modo abierto acepta cualquier identificador y **no debe usarse en producción**.

## Mapa del predio
En modo abierto cada nodo nuevo se coloca en el hueco libre más cercano a la subestación (la misma regla que la pantalla *Invernaderos*, `suggestPosition`); si el predio se llena, crece hacia abajo. Nunca se superponen ni se salen del mapa.

### Escenarios con 2 placas (A y B)
| # | Configuración | Qué debe pasar |
|---|---|---|
| 1 | Las dos normales | Cada una: `<< respuesta recibida (servidor, directo)`. Equipos: «Directo · HTTP». |
| 2 | B con `FORZAR_RADIO 1` (o `GATEWAY_HOST` equivocado solo en B) | B: `>> RADIO envio…`; A: `<< datos de nodo-B… los subo yo` y `>> subido via mi…`; B: `<< respuesta recibida (por la malla)`. Equipos: «Vía nodo-A · 1 salto». |
| 3 | B sin WiFi (`USAR_WIFI 0`) y `CANAL` = canal del router | Igual que el 2. El canal lo imprime A al conectar. Con `USAR_WIFI 1` y la clave mal puesta, B busca el router por su nombre y usa su canal solo. |
| 4 | Apague A en el escenario 2 | B: `sin respuesta… reintento` ×3 y luego «lo doy por perdido»; no hay otra ruta. |
Con 2 placas solo se prueba **1 salto**. El reenvío con varios saltos (`reenvio fragmento…`) se probaría con una tercera placa sin red entre B y A.

## Límites (léalos antes de confiar en esto)
- **No probado en placas.** El sketch compila (NodeMCU, core 3.1.2) pero no se ha corrido; la lógica de pasarela sí tiene pruebas automáticas.
- Hace falta **al menos un nodo con WiFi y pasarela alcanzable**. Si cae el router entero, ningún dato llega a la Pi (haría falta el puente USB; no está hecho).
- Con WiFi, ESP-NOW usa el **canal del router**; un nodo que no consigue conectar busca el router por su nombre (`WIFI_SSID`) y usa su canal; solo si no lo ve usa `CANAL`, que debe ser igual (o `USAR_WIFI 0`, que siempre usa `CANAL`). Dos routers en canales distintos no forman malla.
- Mientras un nodo se conecta al WiFi (hasta 10–20 s) no oye la radio.
- Una trama que llegue **después** de otra con `seq` mayor (ruta lenta) se descarta como duplicada (`seq <= last_seq`).
- Difusión sin confirmación de entrega por fragmento: si se pierde uno, el origen reintenta el mensaje completo (hasta 3 veces).
- `POST /relay` no pide autenticación HTTP: quien llegue al puerto 3100 puede enviar cargas. Con `ACEPTAR_NODOS_NUEVOS=0` hace falta un token válido dentro; en modo abierto basta cualquier identificador (límite de 60 invernaderos autocreados). Con `MQTT_CIFRADO=exigir-rsa` además deben ir cifradas con la clave pública. No exponga el puerto fuera de la red local.
