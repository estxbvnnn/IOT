# Firmware del nodo del invernadero (ESP32)

Nodo de riego automático: **DHT22** + **YL-38/YL-69** + **bomba** por relé, con las bandas de humedad de la
imagen de la clase (0–1023) y envío al dashboard (Supabase) por HTTP(S). Evolución del «Código unificado» del informe.

```
firmware/
├── nodo_invernadero/          ← abrir esta carpeta en el Arduino IDE (el .ino se llama igual)
│   ├── nodo_invernadero.ino   setup() y loop(): une todo
│   ├── config.h               pines (2 mapas), tiempos, opciones
│   ├── secrets.example.h      plantilla → copiar como secrets.h (no se sube a Git)
│   ├── riego.h                reglas del riego (lógica pura, probada en el PC)
│   ├── envio.h                cuándo enviar / reintentar tramas (lógica pura, probada en el PC)
│   ├── protocolo.h            JSON de la trama y de la respuesta (docs/contrato-api.md)
│   ├── sensores.h             DHT22, YL-38, BH1750, anemómetro y relé
│   └── red.h                  WiFi + HTTP(S) en una tarea aparte (núcleo 0)
└── test/                      pruebas de host (sin placa): 70 pruebas, ver test/README.md
```

* **Guía completa** (componentes, conexiones, calibración, flasheo, diferencias con el informe):
  [`docs/hardware.md`](../docs/hardware.md)
* **Protocolo con el servidor:** [`docs/contrato-api.md`](../docs/contrato-api.md)

## En 4 comandos (arduino-cli)

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
