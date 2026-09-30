# Firmware del nodo del invernadero (ESP8266 y ESP32)

Nodo de riego automático: **DHT22** + **YL-38/YL-69** + **bomba** por relé, con las bandas de humedad de la
imagen de la clase (0–1023) y envío al dashboard (Supabase) por HTTP(S). Evolución del «Código unificado» del informe.

## Para Arduino IDE con ESP8266: un solo archivo

**Abra `nodo_invernadero_unico/nodo_invernadero_unico.ino`.** Es el firmware para **ESP8266** (NodeMCU, Wemos/LOLIN D1 mini
y clones) y tiene *todo* adentro: no depende de ningún otro archivo y puede copiarlo suelto a cualquier carpeta de sketches.

1. **Placa ESP8266** (una vez): *Archivo → Preferencias → URLs adicionales del gestor de tarjetas*
   `https://arduino.esp8266.com/stable/package_esp8266com_index.json`, y en *Herramientas → Placa → Gestor de tarjetas*
   instalar **esp8266 by ESP8266 Community** (compilado con la **3.1.2**).
2. **Bibliotecas** (una vez), en *Herramientas → Administrar bibliotecas*: **DHT sensor library** y **Adafruit Unified Sensor**
   (Adafruit), y **ArduinoJson** (Benoit Blanchon, versión 7.x).
3. **Editar solo el bloque «CONFIGURACION DEL USUARIO»** (arriba del archivo): `WIFI_SSID`, `WIFI_PASS`, `SERVER_URL`
   y `DEVICE_TOKEN`.
4. *Herramientas → Placa*: **NodeMCU 1.0 (ESP-12E Module)** o **LOLIN(WEMOS) D1 R2 & mini**. Elegir el puerto, *Subir*
   y abrir el *Monitor Serie* a **115200**.

Conexiones (etiquetas de la NodeMCU / D1 mini; entre paréntesis el GPIO):

| Componente | Conexión |
|---|---|
| DHT22 | DATA → **D5** (GPIO14), VCC → 3V3, GND, y 10 kΩ entre DATA y 3V3 |
| YL-38 (sensor de suelo) | A0 → **A0**, VCC → **D7** (GPIO13, se energiza solo al medir), GND |
| Relé de la bomba | IN → **D6** (GPIO12), VCC → VIN (5 V), GND. Bomba con fuente propia |
| BH1750 (opcional) | SDA → **D2** (GPIO4), SCL → **D1** (GPIO5), VCC → 3V3, GND |
| LED indicador | el de la placa (GPIO2 = D4) |

> `SERVER_URL` debe ser la **IP del PC** en la red local (p. ej. `http://192.168.1.50:3000`), con el dashboard iniciado con
> `npm run dev:lan` y el puerto 3000 permitido en el firewall de Windows: `localhost` **no** sirve (para la placa es ella misma).
> **Solo placas ESP8266** (con otra placa el archivo se detiene con un `#error` claro).
> El archivo lleva sus claves reales (WiFi y token) una vez que las complete: si sube el proyecto a Git, que sea a un repositorio **privado**.

### Lo que cambia respecto del ESP32

* **Un solo núcleo, sin FreeRTOS.** Un POST HTTP bloquea el bucle unos segundos, así que el nodo **nunca hace red con la bomba
  encendida**: los eventos y acuses quedan en cola y salen apenas se apaga (un riego dura como máximo 30 s). El corte por tiempo
  de la bomba se evalúa igual en cada vuelta (~10 ms).
* **Una sola entrada analógica (A0).** La usa el suelo (YL-38); el anemómetro solo puede ir en el nodo del mástil
  (`NODO_MASTIL 1`, sin suelo). El ADC ya es de 10 bits: es exactamente la escala 0–1023 de la tabla de la imagen.
* **La configuración se guarda en la flash** (emulando EEPROM) solo cuando el servidor la cambia; la memoria RTC recuerda
  si el nodo se reinició con la bomba encendida.
* **La lógica del riego, el envío y el protocolo son los mismos archivos que en el ESP32** (`riego.h`, `envio.h`, `protocolo.h`,
  con sus pruebas de host); solo cambian la configuración de pines, los sensores, la red y el programa principal.
* **Límites del hardware:** sin LoRa; el YL-38 consume ~20 mA y un GPIO del ESP8266 entrega ~12 mA (si su módulo tira más,
  alimentelo con un transistor); HTTPS gasta mucha memoria, así que para las pruebas use `http://` en la red local.

**Qué se verificó:** que compila **sin errores** para NodeMCU y D1 mini con el core 3.1.2 (variantes: nodo del mástil con
anemómetro, sin BH1750 ni consola, HTTPS inseguro y HTTPS con certificado) y que el `#error` de placa aparece si se elige otra.
**Pendiente:** probarlo en una placa real (sensores, relé, WiFi y el dashboard).

## Para ESP32

* `nodo_invernadero_unico_esp32/nodo_invernadero_unico_esp32.ino`: el mismo firmware **de un solo archivo para ESP32**
  (DevKit V1 o Heltec WiFi LoRa 32 V2). Pasos: placa **esp32 by Espressif Systems** (URL
  `https://espressif.github.io/arduino-esp32/package_esp32_index.json`), mismas bibliotecas, y *Placa → ESP32 Dev Module*.
  Compilado **sin errores ni advertencias** con el core 3.3.12 para *ESP32 Dev Module* y *Heltec WiFi LoRa 32(V2)*
  (flash 30 %, RAM estática 9 %); falta probarlo en la placa.
* `nodo_invernadero/`: la versión **modular** de ESP32 (sketch normal con `secrets.h`), que es la fuente de la lógica y la que
  tiene las pruebas de host.

Los dos archivos únicos están **generados**: si cambia la lógica, edite los fuentes y regenere con `npm run firmware:unico`
(desde la carpeta raíz del proyecto); `npm run firmware:unico:check` comprueba que estén al día.

## Estructura de carpetas

```
firmware/
├── nodo_invernadero_unico/         ← ESP8266, PARA ARDUINO IDE: abrir este .ino (un solo archivo, generado)
│   └── nodo_invernadero_unico.ino
├── nodo_invernadero_unico_esp32/   ← ESP32 en un solo archivo (generado)
│   └── nodo_invernadero_unico_esp32.ino
├── nodo_invernadero_esp8266/       ← fuentes propias del ESP8266 (NO es un sketch: el generador las une con las compartidas)
│   ├── nodo_invernadero_esp8266.ino   setup() y loop()
│   ├── config.h  sensores.h  red.h    pines, sensores y red del ESP8266
├── nodo_invernadero/               ← versión modular de ESP32: la fuente y la que tiene pruebas de host
│   ├── nodo_invernadero.ino   setup() y loop(): une todo
│   ├── config.h               pines (2 mapas), tiempos, opciones
│   ├── secrets.example.h      plantilla → copiar como secrets.h (lleva claves: repositorio privado)
│   ├── riego.h                reglas del riego (lógica pura, COMPARTIDA con el ESP8266)
│   ├── envio.h                cuándo enviar / reintentar tramas (lógica pura, COMPARTIDA)
│   ├── protocolo.h            JSON de la trama y de la respuesta (COMPARTIDO; docs/contrato-api.md)
│   ├── sensores.h             DHT22, YL-38, BH1750, anemómetro y relé
│   └── red.h                  WiFi + HTTP(S) en una tarea aparte (núcleo 0)
├── tools/
│   └── generar_archivo_unico.mjs   arma los archivos únicos (npm run firmware:unico)
└── test/                      pruebas de host (sin placa): 70 pruebas, ver test/README.md
```

* **Guía completa** (componentes, conexiones, calibración, flasheo, diferencias con el informe):
  [`docs/hardware.md`](../docs/hardware.md)
* **Protocolo con el servidor:** [`docs/contrato-api.md`](../docs/contrato-api.md)

## En 4 comandos (arduino-cli)

Para el Arduino IDE use los archivos únicos de arriba; esto es para quien compila por línea de comandos.

```bash
# ESP8266 (archivo único)
arduino-cli core install esp8266:esp8266 --additional-urls https://arduino.esp8266.com/stable/package_esp8266com_index.json
arduino-cli lib install "DHT sensor library" "Adafruit Unified Sensor" ArduinoJson
arduino-cli compile --fqbn esp8266:esp8266:nodemcuv2 firmware/nodo_invernadero_unico     # o esp8266:esp8266:d1_mini
arduino-cli upload  -p COM3 --fqbn esp8266:esp8266:nodemcuv2 firmware/nodo_invernadero_unico

# ESP32 (versión modular)
arduino-cli core install esp32:esp32 --additional-urls https://espressif.github.io/arduino-esp32/package_esp32_index.json
arduino-cli compile --fqbn esp32:esp32:esp32 firmware/nodo_invernadero      # o esp32:esp32:heltec_wifi_lora_32_V2
```

La versión modular de ESP32 necesita `nodo_invernadero/secrets.example.h` copiado como `secrets.h`. Los archivos únicos no
(sus valores van en el bloque «CONFIGURACION DEL USUARIO»). Sin credenciales reales, el nodo funciona en modo local (riega solo y
muestra todo por el Monitor Serie a 115200).

## Lo que garantiza (y está probado en el PC)

* Bomba **apagada** al arrancar, y tras cualquier reinicio con la bomba encendida parte con la espera activa.
* Un riego **nunca supera `riego_max_s`** (30 s): el corte se evalúa en cada vuelta del bucle, sin depender de la red
  ni de las lecturas.
* Espera obligatoria entre riegos (5 min) y ningún riego automático con temperatura > 40 °C o sin lectura válida.
* El suelo **saturado** (< 300) no se riega, ni siquiera por orden manual.
* Sin WiFi ni servidor, el riego automático sigue funcionando con la última configuración guardada.
