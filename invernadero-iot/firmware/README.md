# Firmware · malla ESP-NOW

Hay **un solo firmware**: `malla_espnow/malla_espnow.ino`. **El mismo archivo va en todas las placas** (NodeMCU / ESP8266).

Cada placa manda sus mediciones cifradas (RSA-2048 + AES-256-GCM; solo la pasarela puede abrirlas):

1. **Con red** (WiFi + pasarela alcanzable): las sube directo con `POST /relay/<id>` a la pasarela del PC o de la Pi.
2. **Sin red**: las difunde por ESP-NOW; cualquier vecino las retransmite (hasta 3 saltos) hasta que las recibe una placa **con** red, que las sube en su nombre.
3. Solo la Pi/PC habla con la nube (servicio `sync`). Ninguna placa lo hace.

Los sensores del sketch son **simulados** (función `armarJson`); las placas no tienen DHT22, suelo ni bomba conectados.

## Subir el firmware (una vez por placa)

1. Arduino IDE con la placa **NodeMCU 1.0 (ESP-12E)** del core *esp8266 by ESP8266 Community* **3.1.2**. No hay que instalar bibliotecas.
2. Editar solo el bloque `CONFIGURACION` (arriba del archivo):
   - `WIFI_SSID`, `WIFI_PASS`: red de **2,4 GHz**.
   - `GATEWAY_HOST`: IP del PC/Pi que corre la pasarela (`ipconfig` / `hostname -I`), puerto 3100.
   - `PERFIL`: **0** para el despliegue normal (todas las placas; `MI_ID` vacío, cada placa se llama `nodo-<chipid>` y se da de alta sola). Para probar la malla con 2 placas: **1** en la placa de entrada (`GRUPO-A`, sube por la red) y **2** en la otra (`GRUPO-B`, manda siempre por radio). No hace falta copiar el archivo.
3. La clave pública de la pasarela ya está pegada. Si cambias la clave del servidor: `node malla_espnow/pegar-claves.mjs malla_espnow/malla_espnow.ino --socio publica-del-servidor.pem`.
4. Subir, abrir el Monitor Serie a **115200**. Debes ver `WiFi OK, IP …, canal N` y `<< respuesta recibida (servidor, directo): HTTP 200`.

> **Una carpeta de sketch, un solo `.ino`**: Arduino junta todos los `.ino` de la carpeta y fallaría por definiciones duplicadas.
> No guardes copias dentro de `malla_espnow/`.

## Qué ver en el Monitor Serie

| Línea | Significa |
|---|---|
| `<< respuesta recibida (servidor, directo)` | esta placa tiene red y subió ella misma |
| `>> RADIO envio N … difundido` | esta placa no tiene ruta y lo mandó por radio |
| `<< datos de nodo-xxxx … los subo yo` | esta placa tiene red y subió lo de un vecino |
| `reenvio fragmento …` | esta placa solo retransmite (hace de salto intermedio) |
| `WiFi: <red> visible en el canal N pero no conecta` | sin WiFi, pero ya escucha en el canal del router |

Guía completa (pruebas con el PC como pasarela, firewall y cómo revertirlo): [`../docs/malla-espnow.md`](../docs/malla-espnow.md).
Material de clase y firmwares anteriores: carpeta `material-clase/` en la raíz del repositorio (fuera del proyecto).
