# Firmware del nodo del invernadero (ESP32)

Nodo de riego automático: **DHT22** + **YL-38/YL-69** + **bomba** por relé, con las bandas de humedad de la
imagen de la clase (0–1023) y envío al dashboard (Supabase) por HTTP(S). Evolución del «Código unificado» del informe.

## Recomendado para Arduino IDE: un solo archivo

**Abra `nodo_invernadero_unico/nodo_invernadero_unico.ino`.** Tiene *todo* el firmware adentro: no depende de ningún otro
archivo —ni siquiera de `secrets.h`— y puede copiarlo suelto a cualquier carpeta de sketches.

1. **Placa ESP32** (una vez): *Archivo → Preferencias → URLs adicionales del gestor de tarjetas*
   `https://espressif.github.io/arduino-esp32/package_esp32_index.json`, y en *Herramientas → Placa → Gestor de tarjetas*
   instalar **esp32 by Espressif Systems** (la versión modular se compiló con la 3.3.12).
2. **Bibliotecas** (una vez), en *Herramientas → Administrar bibliotecas*: **DHT sensor library** y **Adafruit Unified Sensor**
   (Adafruit), y **ArduinoJson** (Benoit Blanchon, versión 7.x).
3. **Editar solo el bloque «CONFIGURACION DEL USUARIO»** (arriba del archivo): `WIFI_SSID`, `WIFI_PASS`, `SERVER_URL`
   y `DEVICE_TOKEN`.
4. *Herramientas → Placa*: **ESP32 Dev Module** (mapa de pines de la DevKit V1) o **Heltec WiFi LoRa 32(V2)** (mapa
   alternativo, se detecta solo). Elegir el puerto, *Subir* y abrir el *Monitor Serie* a **115200**.

> `SERVER_URL` debe ser la **IP del PC** en la red local (p. ej. `http://192.168.1.50:3000`), con el dashboard iniciado con
> `npm run dev:lan` y el puerto 3000 permitido en el firewall de Windows: `localhost` **no** sirve (para el ESP32 es él mismo).
> **Solo placas ESP32** (no Arduino UNO/Nano/Mega; con otra placa el archivo se detiene con un `#error` claro).
> El archivo lleva sus claves reales (WiFi y token) una vez que las complete: si sube el proyecto a Git, que sea a un repositorio **privado**.

El archivo único está **generado** desde la versión modular, que sigue siendo la fuente y la que tiene pruebas de host: si
cambia la lógica, edite `nodo_invernadero/` y regenere con `npm run firmware:unico` (desde la carpeta raíz del proyecto);
`npm run firmware:unico:check` comprueba que esté al día. Es el mismo código: solo cambian la ubicación de la configuración
(arriba, en vez de `secrets.h`), los textos que nombraban `secrets.h` y un `#error` para placas que no son ESP32.

**Qué se verificó:** el generador (`--check`); que no queda ningún `#include` local ni `secrets.h`; que el preprocesador de
`arduino-cli` inserta los prototipos automáticos en un punto válido (ninguno para funciones de `namespace`, todos después de
los tipos que usan); y que, preprocesado, tiene los mismos tokens que la versión modular salvo dos mensajes de consola.
**Pendiente:** compilarlo para ESP32 y probarlo en la placa.

## Estructura de carpetas

```
firmware/
├── nodo_invernadero_unico/    ← PARA ARDUINO IDE: abrir este .ino (todo en un solo archivo, generado)
│   └── nodo_invernadero_unico.ino
├── nodo_invernadero/          ← versión modular: la fuente y la que tiene pruebas de host
│   ├── nodo_invernadero.ino   setup() y loop(): une todo
│   ├── config.h               pines (2 mapas), tiempos, opciones
│   ├── secrets.example.h      plantilla → copiar como secrets.h (lleva claves: repositorio privado)
│   ├── riego.h                reglas del riego (lógica pura, probada en el PC)
│   ├── envio.h                cuándo enviar / reintentar tramas (lógica pura, probada en el PC)
│   ├── protocolo.h            JSON de la trama y de la respuesta (docs/contrato-api.md)
│   ├── sensores.h             DHT22, YL-38, BH1750, anemómetro y relé
│   └── red.h                  WiFi + HTTP(S) en una tarea aparte (núcleo 0)
├── tools/
│   └── generar_archivo_unico.mjs   arma el archivo único desde la versión modular (npm run firmware:unico)
└── test/                      pruebas de host (sin placa): 70 pruebas, ver test/README.md
```

* **Guía completa** (componentes, conexiones, calibración, flasheo, diferencias con el informe):
  [`docs/hardware.md`](../docs/hardware.md)
* **Protocolo con el servidor:** [`docs/contrato-api.md`](../docs/contrato-api.md)

## En 4 comandos (arduino-cli, versión modular)

Para el Arduino IDE use el archivo único de arriba; esto es para quien compila por línea de comandos la versión modular
(el archivo único se compila igual, apuntando a `firmware/nodo_invernadero_unico`).

```bash
arduino-cli core install esp32:esp32 --additional-urls https://espressif.github.io/arduino-esp32/package_esp32_index.json
arduino-cli lib install "DHT sensor library" "Adafruit Unified Sensor" ArduinoJson
arduino-cli compile --fqbn esp32:esp32:esp32 firmware/nodo_invernadero      # o esp32:esp32:heltec_wifi_lora_32_V2
arduino-cli upload  -p COM3 --fqbn esp32:esp32:esp32 firmware/nodo_invernadero
```

Antes de cargarlo, copie `nodo_invernadero/secrets.example.h` como `secrets.h`. Sin él, el nodo funciona en modo
local (riega solo y muestra todo por el Monitor Serie a 115200).

## Lo que garantiza (y está probado en el PC)

* Bomba **apagada** al arrancar, y tras cualquier reinicio con la bomba encendida parte con la espera activa.
* Un riego **nunca supera `riego_max_s`** (30 s): el corte se evalúa en cada vuelta del bucle, sin depender de la red
  ni de las lecturas.
* Espera obligatoria entre riegos (5 min) y ningún riego automático con temperatura > 40 °C o sin lectura válida.
* El suelo **saturado** (< 300) no se riega, ni siquiera por orden manual.
* Sin WiFi ni servidor, el riego automático sigue funcionando con la última configuración guardada.
