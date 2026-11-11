# Firmware · malla ESP-NOW

Hay **un solo firmware**: `malla_espnow/malla_espnow.ino`. **El mismo archivo va en todas las placas** (NodeMCU / ESP8266); solo cambia el número de `PERFIL`.
Es el diagrama del proyecto ([`../docs/diagrama-objetivo.jpeg`](../docs/diagrama-objetivo.jpeg)): los invernaderos forman la malla, un **concentrador** la une por USB con la Raspberry Pi.

| `PERFIL` | Rol | Qué hace |
|---|---|---|
| **0** | **Nodo de invernadero** (el de casi todas las placas) | Mide, cifra y habla **solo por radio** (ESP-NOW) en un canal fijo. No usa WiFi ni router. Retransmite lo de sus vecinos. |
| **1** | **Concentrador principal** | Se conecta por **USB** a la Pi/PC. Oye la malla, entrega cada mensaje al puente (`@RX`) y devuelve la respuesta por la malla (`@TX`). No mide nada. |
| **2** | Nodo con WiFi (respaldo) | Igual que el 0, pero además sube por HTTP a la pasarela si hay WiFi. Necesita `config_local.h`. |

Cada placa manda sus mediciones cifradas (RSA-2048 + AES-256-GCM; solo la pasarela puede abrirlas). Los nodos intermedios y el concentrador **no abren nada**.
Solo la Pi/PC habla con la nube (servicio `uplink`). Ninguna placa lo hace.

Datos de cada nodo: `temp`, `hum_aire`, `suelo_raw` y `flujo_lmin` (L/min), más `vecinos` (cuántos nodos de la malla oye) y `conc` (si ve al concentrador).
Los sensores son **simulados** (función `armarJson`). El flujo de agua se lee de un sensor de pulsos (YF-S201) con `USAR_SENSOR_FLUJO 1` y `SENSOR_FLUJO_PIN` (D5).

## Subir el firmware (una vez por placa)

1. Arduino IDE con la placa **NodeMCU 1.0 (ESP-12E)** del core *esp8266 by ESP8266 Community* **3.1.2**. No hay que instalar bibliotecas.
2. Elige el rol con `#define PERFIL` (arriba del archivo): **0** en los nodos, **1** en el concentrador. El `CANAL` (6) debe ser el **mismo en todas las placas**.
   Pon el nombre de la placa en `#define NOMBRE_NODO "grupo-1"` (distinto en cada una); es el que aparece en el dashboard. Vacío = `nodo-<chip>` automático.
   **Solo letras, números, `-` y `_` (máx. 40), sin espacios ni comillas curvas**: si el nombre no cumple, la placa usa `nodo-<chip>` **sin avisar** (el Monitor Serie muestra `identificador: …` al arrancar). Si cambias el nombre y vuelves a subir, la pasarela renombra el invernadero de esa placa (no crea otro).
3. Solo con `PERFIL 2`: copia `config_local.example.h` a `config_local.h` y pon `WIFI_SSID`, `WIFI_PASS` y `GATEWAY_HOST` (IP de la pasarela, puerto 3100). Ese archivo no se sube a git.
4. La clave pública de la pasarela ya está pegada. Si cambias la clave del servidor: `node malla_espnow/pegar-claves.mjs malla_espnow/malla_espnow.ino --socio publica-del-servidor.pem`.
5. Sube y abre el Monitor Serie a **115200** (en el concentrador, ciérralo antes de ejecutar el puente: el puerto no se comparte).

> **Una carpeta de sketch, un solo `.ino`**: Arduino junta todos los `.ino` de la carpeta y fallaría por definiciones duplicadas.
> No guardes copias dentro de `malla_espnow/`.

## Concentrador ↔ Raspberry Pi
En la Pi/PC, con el concentrador por USB: `npm run puente -- COM4` (Windows) o `npm run puente -- /dev/ttyUSB0` (Pi), dentro de `dashboard/`.
En la Pi con Docker: `CONCENTRADOR_DEV=/dev/ttyUSB0 docker compose --profile concentrador up -d puente`.
Protocolo (una línea por mensaje, 115200 baudios; lo que no empieza con `@` es depuración):

```
ESP → Pi   @HOLA <nombre>
           @RX <origen-hex> <seq> <intento> <saltos> <via> <mensaje rsa1:…>
Pi  → ESP  @TX <origen-hex> <seq> <intento> <respuesta rsa1:…>
```

## Qué ver en el Monitor Serie

| Línea | Significa |
|---|---|
| `=== Malla ESP-NOW · nodo de invernadero (solo radio) ===` | rol con el que arrancó la placa |
| `>> RADIO envio N … difundido` | el nodo mandó sus datos por radio |
| `<< respuesta recibida (por la malla): HTTP 200` | la respuesta de la Pi llegó de vuelta |
| `reenvio fragmento …` | esta placa solo retransmite (salto intermedio) |
| `@RX …` / `>> respuesta de la Pi hacia nodo-…` | (concentrador) entregó un mensaje a la Pi / devolvió la respuesta |
| `<< datos de nodo-xxxx … los subo yo` | (PERFIL 2) esta placa tiene WiFi y subió lo de un vecino |

Guía completa (pruebas con el PC como pasarela, firewall y cómo revertirlo): [`../docs/malla-espnow.md`](../docs/malla-espnow.md).
Material de clase y firmwares anteriores: carpeta `material-clase/` en la raíz del repositorio (fuera del proyecto).
