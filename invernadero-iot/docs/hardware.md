# Hardware y puesta en marcha del nodo del invernadero

Guía del nodo ESP32 (`firmware/nodo_invernadero`): componentes, conexiones, calibración, flasheo y pruebas.
Es la evolución del «Código unificado» (sección 17 del informe) y se apoya en las notas de la clase
(fotografía): DHT22, sensor de humedad YL-38 con sus rangos de 0 a 1023 y la mini bomba de agua sumergible.

> **¿Tiene una placa ESP8266 (NodeMCU, Wemos/LOLIN D1 mini)?** Use `firmware/nodo_invernadero_unico/nodo_invernadero_unico.ino`
> (un solo archivo, sin `secrets.h`) y las conexiones de [la sección ESP8266](#versión-esp8266-nodemcu--d1-mini). El resto de esta
> guía (calibración, bandas del YL-38, bomba por relé, pruebas) vale igual para las dos placas.

> **Estado de la verificación.** El firmware **compila sin advertencias** para las dos placas y sus variantes
> (ver [Tamaño del firmware](#tamaño-del-firmware)), y la lógica de seguridad tiene **70 pruebas automáticas**
> (`firmware/test`). **No se ha probado sobre hardware real**: ningún dato de esta guía sobre el comportamiento
> eléctrico de sensores o bomba viene de una medición propia. Haga el piloto de un invernadero antes del despliegue
> (informe, sección 19).

## Puesta en marcha en 6 pasos

1. Arme el circuito según [Conexiones](#conexiones) (bomba con fuente propia, nunca desde la placa).
2. Instale el IDE y las librerías ([Instalación](#instalación-y-flasheo)).
3. Copie `secrets.example.h` como `secrets.h` y complételo ([secrets.h](#secretsh)).
4. Cargue el programa y abra el Monitor Serie a **115200**.
5. Calibre el sensor de suelo ([Calibración](#calibración-del-sensor-de-suelo)).
6. Verifique con la [consola por USB](#cómo-probar) y, si hay servidor, con el dashboard.

Sin `secrets.h` (o con los valores de ejemplo) el nodo **no se conecta a nada**, pero riega de forma autónoma y
muestra todo por el Monitor Serie. Sirve para probar el circuito antes de tener red.

---

## Versión ESP8266 (NodeMCU / D1 mini)

Archivo: `firmware/nodo_invernadero_unico/nodo_invernadero_unico.ino`. Pasos en Arduino IDE: URL del gestor de placas
`https://arduino.esp8266.com/stable/package_esp8266com_index.json`, instalar **esp8266 by ESP8266 Community** (compilado con la 3.1.2),
las bibliotecas del [paso 2](#instalación-y-flasheo), editar el bloque «CONFIGURACION DEL USUARIO» y elegir la placa
*NodeMCU 1.0 (ESP-12E Module)* o *LOLIN(WEMOS) D1 R2 & mini*.

| Componente | Pin del componente | Pin de la placa |
|---|---|---|
| DHT22 | VCC / DATA / GND | 3V3 / **D5** (GPIO14) / GND, con 10 kΩ entre DATA y 3V3 |
| YL-38 | VCC / A0 / GND | **D7** (GPIO13, solo se energiza al medir) / **A0** / GND |
| Relé de la bomba | VCC / IN / GND | VIN (5 V) / **D6** (GPIO12) / GND (bomba con fuente propia) |
| BH1750 (opcional) | VCC / SDA / SCL / GND | 3V3 / **D2** (GPIO4) / **D1** (GPIO5) / GND |
| LED indicador | — | el de la placa (GPIO2 = D4, se enciende con LOW) |

Se evitaron los pines de arranque (GPIO0 = D3, GPIO2 = D4 salvo el LED, GPIO15 = D8) para que el relé no se active al encender.

**Diferencias con el ESP32 (y por qué):**

| Tema | ESP32 | ESP8266 |
|---|---|---|
| Red | Tarea en el núcleo 0: el bucle nunca espera | Un solo núcleo: un POST bloquea el bucle, así que **no se hace red con la bomba encendida** (eventos en cola; salen al apagarse) |
| Entradas analógicas | Varias en ADC1 | **Solo A0**: suelo, o anemómetro en el nodo del mástil (nunca ambos) |
| ADC | 12 bits, se lleva a 10 | 10 bits nativos (0–1023, la escala de la imagen); NodeMCU/D1 mini lo entregan de 0 a 3,2 V |
| Configuración guardada | NVS (`Preferences`) | Flash emulando EEPROM, con suma de control; se escribe solo cuando el servidor la cambia |
| Reinicio con bomba encendida | Memoria RTC (`RTC_NOINIT_ATTR`) | Memoria RTC de usuario (`ESP.rtcUserMemory*`) |
| Corriente por GPIO | hasta ~40 mA (se sube al máximo) | ~12 mA: si el YL-38 consume más, aliméntelo con un transistor |
| HTTPS | TLS con `WiFiClientSecure` | BearSSL: gasta mucha RAM; para pruebas use `http://` en la LAN. Con `CA_ROOT_PEM` necesita hora NTP |
| Bandas de la imagen, reglas de riego, protocolo, reintentos | `riego.h`, `envio.h`, `protocolo.h` | **Los mismos archivos** (con sus pruebas de host) |

Compilado sin errores para `nodemcuv2` y `d1_mini` (core 3.1.2, ArduinoJson 7.4.3, DHT 1.4.7). **No probado en una placa real.**

---

## Lista de componentes (por nodo)

| Componente | Detalle | Fuente |
|---|---|---|
| Placa | **ESP32 DevKit V1** (30 pines) — mapa de pines por defecto — o **Heltec WiFi LoRa 32 (V2)** — mapa alternativo | informe, tabla 3 |
| Sensor de temperatura y humedad del aire | **DHT22** (AM2302) + resistencia de 10 kΩ entre DATA y 3V3 (pull-up). En las notas de la clase figura escrito «DTH22»: es el mismo sensor | informe, tabla 3; imagen |
| Sensor de humedad de suelo | **YL-69** con módulo **YL-38** (comparador LM393). Se usa la salida **analógica A0** | informe, tabla 3; imagen |
| Módulo de relé | 1 canal (o 4 canales), 5 V de bobina, entrada compatible con 3,3 V, normalmente **activo en bajo** (el firmware lo supone; `RELE_ACTIVO_EN_BAJO` en `config.h`) | informe, tablas 3 y 18 |
| **Mini bomba de agua sumergible** | **2,5 – 6 V CC**, caudal **80 – 120 L/h**, altura de bombeo **40 – 110 cm**, «compatible con Arduino» (AFEL, SKU 1307) | imagen (ficha del vendedor) |
| Fuente de la bomba | **Independiente de la placa**, con tensión dentro de 2,5 – 6 V (p. ej. 5 V) y corriente suficiente para el arranque del motor | ver [Bomba](#bomba-mini-bomba-sumergible-por-relé) |
| Diodo de rueda libre | 1N4007 o 1N5819, en paralelo con la bomba | ver [Bomba](#bomba-mini-bomba-sumergible-por-relé) |
| Opcional: sensor de luz | **BH1750** (GY-30), I2C, dirección 0x23 | informe, tabla 3 |
| Opcional (solo nodo del mástil) | Anemómetro de copas 0–5 V = 0–45 m/s, y divisor de tensión 20 kΩ / 10 kΩ | informe, tabla 3 |
| Mecánica | Manguera para la bomba, recipiente, caja estanca IP65 para la placa (informe: mantener el agua lejos de la electrónica) | informe, sección 10 |

**No incluido en este firmware:** el elemento seguro ATECC608A y el enlace LoRaWAN del informe (ver
[Diferencias con el informe](#diferencias-con-el-informe)).

---

## Bandas del sensor YL-38 (imagen de la clase)

La fotografía muestra la tabla de lectura del módulo, en la **escala de 10 bits (0–1023)**:

| Lectura (10 bits) | Estado según la imagen | Qué significa | Equivalente en 12 bits (ADC del ESP32) |
|---|---|---|---|
| `0 – 300` | **Sumergido / muy húmedo** | La sonda está en agua o en tierra completamente saturada | 0 – 1199 |
| `300 – 700` | **Suelo húmedo / óptimo** | Humedad adecuada para la mayoría de las plantas | 1200 – 2799 |
| `700 – 1023` | **Suelo seco / aire** | Tierra seca o el sensor está fuera del agua/suelo | 2800 – 4095 |

Los extremos comparten valor en la imagen (300 y 700 aparecen en dos filas). El firmware fija los límites así
(`raw10 = raw12 / 4`, división entera), de modo que 300 ya es «óptimo» y 700 ya es «seco»:

| Banda | `suelo_raw` (0–1023) | Nombre en el código | Efecto |
|---|---|---|---|
| Saturado | `0 – 299` | `SATURADO` | **No se riega** (tampoco por orden manual) |
| Óptimo | `300 – 699` | `OPTIMO` | Sin acción; zona de histéresis |
| Seco | `700 – 1023` | `SECO` | Se inicia el riego automático (si la temperatura y la espera lo permiten) |

Los umbrales por defecto siguen esa tabla: regar con `suelo_raw ≥ 700`, dejar de regar con `suelo_raw ≤ 500`
(mitad de la banda óptima) y `SATURADO` bajo 300. El agrónomo puede cambiarlos desde el dashboard; el nodo
los recibe en `cfg` y los guarda en su memoria (`docs/contrato-api.md`, secciones 5 y 6).

> **Ojo con la calibración del informe.** Los valores del informe (`SUELO_SECO = 3200`, `SUELO_MOJADO = 1300`,
> escala de 12 bits) equivalen a 800 y **325** en la escala de 10 bits: el sensor «en agua» del informe cae en la
> banda *óptimo* de la imagen (300–700) y no en *sumergido* (0–300). No es un error: cada módulo y cada tensión de
> alimentación dan valores distintos. Por eso hay que **medir el propio sensor** (siguiente sección) y, si hace falta,
> ajustar los umbrales.

---

## Conexiones

### Mapa 1 — ESP32 DevKit V1 (por defecto; tabla 18 del informe)

| Componente | Pin del componente | Pin del ESP32 | Observación |
|---|---|---|---|
| DHT22 | VCC / DATA / GND | 3V3 / **GPIO4** / GND | Resistencia de 10 kΩ entre DATA y 3V3 |
| YL-38 (módulo del YL-69) | VCC / A0 / GND | **GPIO25** / **GPIO34** / GND | El VCC va a un pin (se energiza solo al medir). GPIO34 es solo entrada y ADC1 |
| Módulo de relé | VCC / IN / GND | 5V / **GPIO26** / GND | La bomba va en el contacto seco (ver más abajo) |
| LED indicador | (de la placa) | **GPIO2** | Encendido = regando |
| BH1750 (opcional) | VCC / SDA / SCL / GND | 3V3 / **GPIO21** / **GPIO22** / GND | I2C, dirección 0x23 |
| Anemómetro (opcional, mástil) | señal | **GPIO32** vía divisor | ADC1; ver más abajo |

### Mapa 2 — Heltec WiFi LoRa 32 (V2) (alternativo; se activa solo con esa placa)

En el IDE, al elegir la placa **Heltec WiFi LoRa 32(V2)** el firmware usa este mapa automáticamente (la placa
define `ARDUINO_HELTEC_WIFI_LORA_32_V2`). Con otra placa se fuerza quitando el `//` de `#define PLACA_HELTEC_V2`
en `config.h`.

| Componente | Pin del componente | Pin de la Heltec V2 | Observación |
|---|---|---|---|
| DHT22 | VCC / DATA / GND | 3V3 / **GPIO13** / GND | Resistencia de 10 kΩ entre DATA y 3V3 |
| YL-38 (módulo del YL-69) | VCC / A0 / GND | **GPIO2** / **GPIO33** / GND | GPIO33 es ADC1. VCC desde GPIO2 (se energiza solo al medir) |
| Módulo de relé | VCC / IN / GND | 5V / **GPIO17** / GND | |
| LED indicador | (de la placa) | **GPIO25** | LED blanco de la placa |
| BH1750 (opcional) | VCC / SDA / SCL / GND | 3V3 / **GPIO22** / **GPIO23** / GND | I2C por matriz de pines |
| Anemómetro (opcional, mástil) | señal | **GPIO32** vía divisor | ADC1 |

> **Antes de cablear en la Heltec:** el mapa evita todos los pines que el core asigna al radio, la pantalla, el
> LED y Vext, pero **no se pudo comprobar en este trabajo que GPIO2, 13, 17, 22 y 23 salgan a los conectores** de su
> revisión de la placa (el diagrama de pines de Heltec es una imagen). Confírmelo en el diagrama oficial de su placa.

### Por qué la Heltec V2 necesita otro mapa (evidencia)

El informe (código 17) dice «probado en Heltec WiFi LoRa 32 V2 y ESP32 DevKit V1». La tabla 18 es válida para la
DevKit V1, pero **en la Heltec V2 cinco de sus pines chocan con el radio, la pantalla o la alimentación externa**.
Fuente: `variants/heltec_wifi_lora_32_V2/pins_arduino.h` del core *esp32 3.3.12* de Espressif; para el control de `Vext`
y los estados de descarga, además, el PDF oficial de Heltec (`WIFI_LoRa_32_V2.pdf`):

| Pin | Uso en la tabla 18 | Función en la Heltec V2 | Consecuencia |
|---|---|---|---|
| **GPIO26** | IN del relé | `DIO0` del transceptor SX1276 (LoRa) | Dos salidas empujando la misma línea: el ESP32 y el radio |
| **GPIO4** | DATA del DHT22 | `SDA_OLED` (pantalla OLED) | La línea del DHT22 queda compartida con el bus de la pantalla |
| **GPIO34** | A0 del YL-38 | `DIO2` del SX1276 | Una señal digital del radio sobre una entrada analógica |
| **GPIO25** | VCC del YL-38 | `LED_BUILTIN` | Enciende el LED y le suma carga al pin |
| **GPIO21** | SDA (BH1750, ATECC608A) | `Vext`: conmuta la alimentación externa de 3,3 V (LOW = encendida, según Heltec) | Cada transacción I2C conmutaría la alimentación externa. El propio archivo del core define `SDA = 21` y `Vext = 21` |
| GPIO22 | SCL | libre | Sin conflicto |
| GPIO2 | LED | libre (`A12`/`T2`) | Sin conflicto |

Además, según el mismo PDF, para **descargar** el programa en la Heltec V2 esos pines deben estar así: **GPIO5 en
LOW, GPIO12 en LOW y GPIO15 en HIGH**. Por eso el mapa alternativo no usa GPIO12 ni conecta nada a los pines del radio
y la pantalla.

Regla general del ESP32 que aplica a ambos mapas (verificada en el SDK): el sensor de suelo debe ir en el **ADC1**
(GPIO32–39; `adc_channel.h`), porque el WiFi reclama el ADC2 mientras funciona (`adc2_wifi_acquire`), y los pines
**34–39 son solo entrada** (`SOC_GPIO_VALID_OUTPUT_GPIO_MASK`), así que no sirven para salidas ni para I2C.

### Bomba (mini bomba sumergible) por relé

```
                       ┌────────────── Fuente de la bomba (2,5–6 V, p. ej. 5 V) ──────────────┐
                       │ (+)                                                             (−)  │
                       │                                                                      │
              ┌────────┴────────┐                                                             │
              │ COM   NO    NC  │  Módulo de relé                                             │
              │  │    │         │  (VCC = 5 V de la placa, GND, IN = pin del ESP32)           │
              └──┼────┼─────────┘                                                             │
                 │    │                                                                       │
              (+)┘    └──────────┬───────────────┐                                            │
                                 │       ┌───────┴───────┐                                    │
                                 │       │  Mini bomba   │  ◄── diodo 1N4007 / 1N5819 en      │
                                 │       │  sumergible   │      paralelo, CÁTODO al (+)       │
                                 │       └───────┬───────┘                                    │
                                 └───────────────┴────────────────────────────────────────────┘
```

* **Use COM y NO** (normalmente abierto): sin señal, o si el ESP32 se reinicia o pierde energía, la bomba
  queda apagada. El firmware además arranca con el relé apagado y fija ese nivel antes de configurar el pin
  como salida, para que no haya un pulso al encender.
* **La bomba se alimenta desde su propia fuente y nunca desde la placa** (informe, sección 16): ni del pin 3V3,
  ni de un GPIO, ni del 5 V si la placa va por USB. El contacto del relé es seco: la fuente de la bomba **no necesita
  compartir GND** con el ESP32, y el motor no puede meter ruido ni provocar un reinicio (*brownout*) en la placa.
  El firmware además detecta un reinicio ocurrido con la bomba encendida y parte con la espera activa para no
  repetir el riego de inmediato.
* **Diodo de rueda libre:** la bomba es un motor de CC (carga inductiva). Un diodo en antiparalelo con sus
  terminales absorbe el pico inverso al cortar y protege los contactos del relé. Si usa un **transistor o MOSFET en
  lugar del relé**, el diodo es **obligatorio** (además de una resistencia en la compuerta/base y una resistencia
  de pull-down para que arranque apagado).
* **Caída de tensión:** la bomba trabaja entre 2,5 y 6 V y a menor tensión mueve menos agua. Cables finos o largos,
  conectores y los contactos del relé restan tensión (V = I × R), sobre todo en el arranque del motor, que consume
  más que en régimen. **Mida la tensión en los terminales de la bomba con la bomba funcionando.** La corriente del
  motor no figura en la ficha de la imagen: consúltela con el vendedor o mídala con un multímetro, y elija la
  fuente y la sección del cable con margen.
* **Seguridad:** la bomba es sumergible; la placa, el relé y las conexiones no. Manténgalos secos y en la caja IP65.

### YL-38: alimentación a 3,3 V

El módulo se alimenta desde un GPIO (3,3 V). **No lo conecte a 5 V mientras A0 vaya a un pin del ESP32:** la salida
analógica seguiría a la alimentación y podría superar los 3,3 V que tolera el pin. Alimentarlo solo durante la medición
(50 ms de estabilización + 10 muestras de 20 ms) evita además que la corriente continua entre los electrodos del
YL-69 los corroa por electrólisis (informe, sección 15). El pin de alimentación se configura con la máxima capacidad
de corriente que ofrece el ESP32 (`GPIO_DRIVE_CAP_3`, «strongest» en el SDK) porque el módulo consume del orden de
20 mA (informe, tabla 3); si su módulo consume más, alimente el módulo con un transistor.

### Anemómetro (solo nodo del mástil)

Activar con `NODO_MASTIL 1` y `USAR_ANEMOMETRO 1` en `config.h`. La señal de 0–5 V del anemómetro no puede ir directa
al ESP32: use un divisor de tensión con **R_arriba = 20 kΩ** (entre la señal y el pin) y **R_abajo = 10 kΩ** (entre el
pin y GND). Con 5 V en la señal el pin recibe 1,67 V. El firmware reconstruye la tensión original (× 3) y la convierte
con 0–5 V = 0–45 m/s (informe, tabla 3). En modo mástil el nodo no lee suelo ni maneja bomba, y rechaza las órdenes de riego.

---

## Calibración del sensor de suelo

El YL-69 es resistivo: cada sensor, cada sustrato y cada tensión de alimentación dan valores distintos, y el
sensor se degrada con el tiempo. Calibre **cada nodo** con su propio sensor:

1. Con el nodo funcionando, abra el Monitor Serie (115200). Cada medición imprime una línea como
   `Suelo: 512 (0-1023; ADC 12 bits: 2048) -> OPTIMO, 49 %`.
2. Con el sensor **al aire y limpio**, anote el valor de 10 bits → `raw_aire`.
3. Con el sensor **sumergido en agua hasta la marca** (sin mojar el módulo electrónico), anote → `raw_agua`.
4. En el dashboard, en la administración del nodo, ingrese `cal_dry = raw_aire` y `cal_wet = raw_agua`
   (valores por defecto 1023 y 0).
5. **Cómo calcula el servidor el porcentaje:** `% = (cal_dry − suelo_raw) / (cal_dry − cal_wet) × 100`, limitado a
   0–100 (contrato, sección 5). El nodo envía siempre el valor crudo (`suelo_raw`); el porcentaje se calcula en el
   servidor, por lo que cambiar la calibración no exige tocar el firmware.
6. Los **umbrales de riego** (`suelo_on`, `suelo_off`, `suelo_sat`) están en unidades crudas de 0–1023 y los ajusta el
   agrónomo en el dashboard. Compruébelos con el sustrato real: pruebe el valor con tierra seca, húmeda y saturada.
7. El porcentaje que imprime el Monitor Serie usa las constantes `SUELO_RAW_AIRE_LOCAL` y `SUELO_RAW_AGUA_LOCAL` de
   `config.h`; cámbielas por sus valores si quiere ver el mismo porcentaje que el dashboard.

Repita la calibración si cambia el sustrato o reemplaza el sensor. El informe (sección 18) reconoce el YL-69 como el
punto débil del diseño; un sensor capacitivo es la ampliación natural.

---

## Instalación y flasheo

Versiones con las que se verificó la compilación: **core esp32 (Arduino-ESP32) 3.3.12**, **DHT sensor library 1.4.7**,
**Adafruit Unified Sensor 1.1.15**, **ArduinoJson 7.4.3**.

> **Atajo para Arduino IDE con ESP32:** `firmware/nodo_invernadero_unico_esp32/nodo_invernadero_unico_esp32.ino` es este mismo firmware en **un solo
> archivo** (no usa `secrets.h`: WiFi, servidor y token se escriben en su bloque «CONFIGURACION DEL USUARIO»). Con él, los pasos
> 4 y 6 de abajo se reducen a abrir ese archivo y editar ese bloque. Se genera desde `nodo_invernadero/` con `npm run firmware:unico`.
> Para **ESP8266** el archivo es `nodo_invernadero_unico/nodo_invernadero_unico.ino` (ver [Versión ESP8266](#versión-esp8266-nodemcu--d1-mini)).

### Arduino IDE 2.x

1. *Archivo → Preferencias → URLs adicionales del gestor de tarjetas:*
   `https://espressif.github.io/arduino-esp32/package_esp32_index.json`
2. *Herramientas → Placa → Gestor de tarjetas:* instalar **esp32 by Espressif Systems**.
3. *Herramientas → Administrar bibliotecas:* instalar **DHT sensor library** (Adafruit), **Adafruit Unified Sensor**
   y **ArduinoJson** (versión 7.x).
4. Abrir `firmware/nodo_invernadero/nodo_invernadero.ino` (la carpeta debe llamarse igual que el `.ino`).
5. Placa: **ESP32 Dev Module** (DevKit V1) o **Heltec WiFi LoRa 32(V2)**. El esquema de particiones por defecto sirve
   (ver [tamaño](#tamaño-del-firmware)).
6. Copiar `secrets.example.h` como `secrets.h` y completarlo. *Subir.* Abrir el Monitor Serie a **115200**.

### Equivalente con `arduino-cli`

```bash
arduino-cli core update-index --additional-urls https://espressif.github.io/arduino-esp32/package_esp32_index.json
arduino-cli core install esp32:esp32 --additional-urls https://espressif.github.io/arduino-esp32/package_esp32_index.json
arduino-cli lib install "DHT sensor library" "Adafruit Unified Sensor" ArduinoJson

arduino-cli compile --fqbn esp32:esp32:esp32 --warnings all firmware/nodo_invernadero
arduino-cli compile --fqbn esp32:esp32:heltec_wifi_lora_32_V2 --warnings all firmware/nodo_invernadero

arduino-cli upload -p COM3 --fqbn esp32:esp32:esp32 firmware/nodo_invernadero      # ajuste el puerto
```

Opciones del firmware desde la línea de comandos (sin editar `config.h`), por ejemplo un nodo de mástil:
`--build-property "compiler.cpp.extra_flags=-DNODO_MASTIL=1 -DUSAR_ANEMOMETRO=1"`.

---

## `secrets.h`

Copie `secrets.example.h` con el nombre `secrets.h` (misma carpeta). **Lleva sus claves (WiFi y token): si sube el proyecto a Git, hágalo solo a un repositorio privado.** (Con el archivo único no existe `secrets.h`: esos valores van en su bloque «CONFIGURACION DEL USUARIO».)

| Constante | Qué poner |
|---|---|
| `WIFI_SSID`, `WIFI_PASS` | Red WiFi de 2,4 GHz del predio |
| `SERVER_URL` | Dirección del dashboard **sin barra final**. Desarrollo: `http://192.168.1.50:3000`. Producción: `https://su-dominio.cl` |
| `DEVICE_TOKEN` | Token **único de este nodo**. El dashboard lo muestra **una sola vez** al dar de alta o rotar el nodo: cópielo aquí. Si lo perdió, rote el token y vuelva a cargarlo. En la instalación de demostración los tokens los genera el script de siembra del dashboard (ver su README) |
| `CA_ROOT_PEM` | Solo con `https://`: certificado raíz que firma el del servidor. Sin él (y sin `TLS_INSEGURO`) el nodo **se niega a enviar** por HTTPS |
| `TLS_INSEGURO` | **Solo desarrollo:** acepta cualquier certificado. Deja el tráfico expuesto a un intermediario. No usar en producción |

Mientras `DEVICE_TOKEN` o `WIFI_SSID` conserven los valores de ejemplo, el nodo no intenta conectarse.
El token viaja en la cabecera `Authorization: Bearer`; con `http://` va sin cifrar por la red local, por eso
producción debe usar HTTPS. La identidad del nodo la deduce el servidor del token: el nodo nunca la envía en el cuerpo.

---

## Cómo probar

### 1. Sin servidor (solo el circuito)

Con el Monitor Serie a 115200 debería verse, cada `intervalo_s` (300 s por defecto; 5 s mientras la bomba está encendida):

```
>> BOMBA ENCENDIDA (auto)
---------------------------------------------
[12 s] Temp 24.3 C | Humedad aire 61.2 %
Suelo: 812 (0-1023; ADC 12 bits: 3251) -> SECO, 20 % | Bomba: ENCENDIDA | Estado: riego
```

Para no esperar 5 minutos, la **consola por USB** (`CONSOLA_SERIAL 1`) acepta letras sueltas:

| Tecla | Acción |
|---|---|
| `r` | Regar 10 s (con todas las reglas: rechaza si ya riega, si hay espera entre riegos o si el suelo está saturado) |
| `p` | Parar la bomba |
| `s` | Estado y configuración vigente |

Pruebas sugeridas (con la bomba en un vaso de agua): sensor **al aire** → debe regar y cortar a los **30 s** aunque el
suelo siga «seco»; sensor **en el agua** → estado `saturado` o `idle` (según su calibración) y no riega; desconectar el
cable DATA del DHT22 → `ERROR: sin lectura valida del DHT22` y, si el suelo está seco, estado `bloq_temp` (no riega); después
de un riego, una nueva orden `r` responde `en espera entre riegos (faltan N s)`. Un cable de A0 suelto puede o no detectarse
como lectura inestable, según cómo «flote» el pin (ver [Limitaciones](#limitaciones-conocidas)). Ponga `CONSOLA_SERIAL 0` en
producción (informe: puerto de depuración deshabilitado).

### 2. Con el dashboard

1. Inicie el dashboard escuchando en la red local (p. ej. `npx next dev -H 0.0.0.0`) y permita el acceso en el
   cortafuegos de Windows. Use la IP del PC en `SERVER_URL`.
2. Debería aparecer en el Monitor Serie:
   `WiFi: conectado, IP ...` → `RED: trama 1 enviada` → `CFG: aplicada y guardada ...`.
3. Una orden de riego desde el dashboard llega en la respuesta al siguiente envío (hasta `intervalo_s`):
   `ORDEN <id> -> ejecutada (regando 20 s)`, y el nodo envía de inmediato el acuse.
4. Mensajes de diagnóstico frecuentes:

| Mensaje | Causa probable |
|---|---|
| `RED: ... descartada (HTTP 401: token rechazado ...)` | `DEVICE_TOKEN` incorrecto o token rotado |
| `RED: ... fallo (HTTP -1)` | Sin conexión con el servidor (IP/puerto, cortafuegos) |
| `RED: SERVER_URL es https:// pero secrets.h no define CA_ROOT_PEM` | URL `https://` sin `CA_ROOT_PEM` ni `TLS_INSEGURO`: el nodo no arranca la red |
| `ERROR: sin lectura valida del DHT22` | Cableado o falta la resistencia de 10 kΩ |
| `ERROR: lectura de suelo inestable` | Cable de A0 suelto o sensor desconectado |
| `CFG: la del servidor es INVALIDA` | El servidor envió umbrales fuera de los límites del contrato; el nodo conserva los anteriores |

Sin hardware se puede probar el servidor con `curl`:

```bash
curl -X POST http://192.168.1.50:3000/api/ingest \
  -H "Authorization: Bearer <TOKEN_DEL_NODO>" -H "Content-Type: application/json" \
  -d '{"v":1,"fw":"curl","boot":1,"seq":1,"up":1,"temp":24.3,"hum_aire":60,"suelo_raw":512,"bomba":0}'
```

### 3. Pruebas automáticas de la lógica

`firmware/test/README.md`: 70 pruebas que corren en el PC (controlador de riego, política de envío, trama JSON).

---

## Comportamiento del nodo (resumen)

* **Arranque seguro:** relé apagado antes que cualquier otra cosa. Si el reinicio ocurrió con la bomba encendida
  (detectado con memoria RTC), parte con la espera activa e informa el corte como `seguridad`.
* **Riego automático:** solo con lectura válida de suelo **y** de temperatura, `suelo_raw ≥ suelo_on`,
  `temp ≤ temp_max`, sin espera entre riegos y suelo no saturado. Termina con `suelo_raw ≤ suelo_off`, o por el corte
  duro `riego_max_s` (30 s), o por falla del sensor de suelo. El corte por tiempo se evalúa **en cada vuelta del bucle**
  (~10 ms). Nunca decide con una lectura anterior al riego: al terminar la espera pide una medición nueva.
* **Órdenes manuales** (`riego`, `parar`): con las mismas protecciones; `parar` se ejecuta siempre, incluso vencida.
  Una orden repetida por el servidor no se ejecuta dos veces.
* **Sin red:** el riego automático sigue funcionando con la última configuración guardada en memoria (NVS).
  La red vive en otra tarea (núcleo 0) y nunca detiene el bucle de control.
* **Watchdog** de 15 s: si el bucle se cuelga, el nodo se reinicia (con la bomba apagada). Si la tarea de red no devuelve
  nada en 2 minutos, el nodo también se reinicia.
* **Timeouts HTTP:** 5 s para conectar y 10 s para leer la respuesta, siempre dentro de la tarea de red (el bucle de control
  no se bloquea). El servidor puede tardar ~1,2 s por trama y hasta ~5 s en la primera tras un período inactivo (conexión «fría» a la base).
* **Envío:** cada `intervalo_s` y de inmediato ante un evento de la bomba o el acuse de una orden. Si el envío falla se
  reintenta **la misma trama** (el servidor responde `dup:true` si ya la tenía); tras 3 intentos se abandona y se
  espera 10, 20, 40… s (tope 5 min).

---

## Tamaño del firmware

Medido con `arduino-cli compile --warnings all` (core esp32 3.3.12). Los 11 casos compilaron con 0 errores y 0 advertencias:

| Variante | Placa | Flash | RAM estática |
|---|---|---|---|
| Modo local (`secrets.h` con valores de ejemplo) | ESP32 Dev Module | 399 220 B (30 % de 1 310 720) | 31 796 B (9 %) |
| Modo local | Heltec WiFi LoRa 32(V2) | 399 252 B (11 % de 3 342 336) | 31 796 B (9 %) |
| Modo local, mapa de la Heltec forzado (`-DPLACA_HELTEC_V2`) | ESP32 Dev Module | 399 220 B (30 %) | 31 796 B (9 %) |
| Con red, `http://` | ESP32 Dev Module | 987 764 B (75 %) | 62 800 B (19 %) |
| Con red, `http://` | Heltec WiFi LoRa 32(V2) | 987 796 B (29 % de 3 342 336) | 62 800 B (19 %) |
| Con red, `https://` + `TLS_INSEGURO` | ESP32 Dev Module | 1 077 120 B (82 %) | 63 312 B (19 %) |
| Con red, `https://` + `CA_ROOT_PEM` | ESP32 Dev Module | 1 077 192 B (82 %) | 63 312 B (19 %) |
| `https://` sin CA (la red no arranca) | ESP32 Dev Module | 399 332 B (30 %) | 31 796 B (9 %) |
| Nodo del mástil + anemómetro, `http://` | ESP32 Dev Module | 986 684 B (75 %) | 62 800 B (19 %) |
| Nodo del mástil + anemómetro, `http://` | Heltec WiFi LoRa 32(V2) | 986 700 B (29 %) | 62 800 B (19 %) |
| Sin BH1750 ni consola (`-DUSAR_BH1750=0 -DCONSOLA_SERIAL=0`), `http://` | ESP32 Dev Module | 986 888 B (75 %) | 62 800 B (19 %) |

Con los valores de ejemplo de `secrets.example.h` el compilador sabe que son marcadores de posición y el enlazador descarta
todo el código de red: por eso el tamaño «real» de un nodo conectado es el de las filas «Con red» (≈ 75 % de la partición
por defecto con HTTP y ≈ 82 % con HTTPS).

> **Nota:** después de estas mediciones solo se cambiaron dos constantes en `red.h` (los *timeouts* HTTP, de 3 s/4 s a 5 s/10 s)
> y **no se volvió a compilar**. Recompile antes de cargar.

El esquema de particiones por defecto de *ESP32 Dev Module* ofrece 1 310 720 bytes para la aplicación y el de la Heltec V2
(8 MB de flash) 3 342 336 bytes, así que hay margen incluso con HTTPS.

---

## Diferencias con el informe

| # | Informe | Este firmware | Motivo |
|---|---|---|---|
| 1 | Tabla 18: pines DHT22→4, YL-38→25/34, relé→26, I2C 21/22; código 17 «probado en Heltec V2 y DevKit V1» | Mapa por defecto = tabla 18 (**DevKit V1**). En la **Heltec V2** se usa otro mapa (DHT22→13, YL-38→2/33, relé→17, I2C 22/23, LED→25) | En la Heltec V2 los GPIO 26, 4, 34, 25 y 21 están ocupados por el radio, la pantalla, el LED y Vext (ver [evidencia](#por-qué-la-heltec-v2-necesita-otro-mapa-evidencia)) |
| 2 | Humedad de suelo en **12 bits** (0–4095) con calibración `SUELO_SECO=3200`/`SUELO_MOJADO=1300` y umbrales en **porcentaje** (regar bajo 30 %, parar en 45 %) | Lectura en **10 bits** (`raw12/4`) con las bandas de la imagen y umbrales en **valor crudo**: regar ≥ 700, parar ≤ 500, saturado < 300. El % lo calcula el servidor con la calibración del nodo | La imagen de la clase define las bandas en 0–1023. Con la calibración del informe, 30 % y 45 % equivalen a ≈ 657 y ≈ 586: los umbrales por defecto son distintos (700/500) y se ajustan desde el dashboard |
| 3 | Bomba de agua periférica de 1/2 HP (220 V) y electroválvulas de 12 V por invernadero | Se maneja **un relé** con la **mini bomba sumergible 2,5–6 V, 80–120 L/h** de la imagen (prototipo de la clase) | El relé de este nodo es el mismo que en el diseño completo abriría la electroválvula del sector; el contactor de la bomba central de 220 V queda fuera del alcance del firmware |
| 4 | Código 17 mide cada 5 s | Mide cada `intervalo_s` (300 s por defecto, como el objetivo 3.2 del informe) y cada 5 s **solo mientras riega** | Menos corrosión del YL-69 (energizado ≈ 0,1 % del tiempo) y menos tráfico |
| 5 | Una lectura del DHT22; si falla, no se riega | Hasta 3 intentos separados 2,1 s (sin bloquear el bucle) | El DHT22 falla ocasionalmente; se evitan bloqueos innecesarios. Si sigue sin dato válido, no se riega (igual que el informe) |
| 6 | `USAR_MQTT` (WiFi + PubSubClient) | Cliente **HTTP(S)** al dashboard: `POST /api/ingest` con token por nodo (`docs/contrato-api.md`) | El último tramo del informe (MQTT → ThingsBoard → PostgreSQL) se reemplaza por API → Supabase. El JSON es independiente del transporte |
| 7 | Enlace LoRaWAN 915 MHz (nodo → concentrador → ChirpStack) | **No implementado** | Solicitado: DHT22, YL-38 y bomba. Si se vuelve a LoRaWAN, solo cambia quien entrega el JSON |
| 8 | Elemento seguro ATECC608A guarda la llave | **No implementado**: el token va en `secrets.h`, dentro de la flash del nodo | Queda como mejora; con acceso físico al nodo el token es extraíble (informe, tabla 10, primera fila) |
| 9 | Protecciones: estado seguro, tiempo máximo, espera entre riegos | Esas tres, más: watchdog, reinicio conservador tras un corte con la bomba encendida (RTC), límites duros que ninguna orden ni configuración puede superar, y rechazo de una configuración inválida completa | Ver `docs/contrato-api.md`, secciones 4, 6 y 7 |
| 10 | El código 17 es un único archivo | Lógica pura en `riego.h`, `envio.h` y `protocolo.h` (probada en el PC); hardware en `sensores.h`; red en `red.h` | Para poder probar la parte de seguridad sin placa |
| 11 | Calibración: `SUELO_MOJADO` 1300 (12 bits) | Equivale a **325** en 10 bits: dentro de la banda *óptimo* de la imagen, no de *sumergido* | Ver la advertencia en [Bandas del sensor](#bandas-del-sensor-yl-38-imagen-de-la-clase): calibre el sensor real |
| 12 | LED indicador en GPIO2 | GPIO2 en DevKit V1; **GPIO25** (LED blanco de la placa) en Heltec V2 | En la Heltec V2 el LED está en el 25 |
| 13 | Lectura de suelo sin validación de estabilidad | Se descarta si las 10 muestras difieren en más de 400 cuentas (de 4095): cable suelto o sensor ausente | Un A0 flotante daría valores arbitrarios que podrían activar la bomba |

## Limitaciones conocidas

* **Sin pruebas en hardware.** Compila y la lógica está probada en el PC, pero el comportamiento del ADC, del DHT22,
  del relé y de la bomba reales no se ha medido.
* Un YL-69 desconectado o sacado del suelo se lee como «aire» (banda `SECO`, tal como dice la imagen): el sistema no
  puede distinguirlo de tierra seca salvo por el corte de 30 s, la espera de 5 min y la alerta de anomalías del servidor
  tras riegos repetidos que terminan por tiempo.
* El token está en la flash (sin ATECC608A). Producción: HTTPS con `CA_ROOT_PEM`, `CONSOLA_SERIAL 0` y, si se necesita
  proteger contra acceso físico, cifrado de flash y arranque seguro del ESP32 (fuera del alcance de este trabajo).
* Reemplazar una trama tras 3 intentos fallidos puede duplicar eventos de la bomba en el servidor si la respuesta original
  se perdió después de que el servidor procesó la trama; un identificador de evento (`eid`) en el contrato lo evitaría.
* La detección de «reinicio con la bomba encendida» usa memoria `RTC_NOINIT_ATTR`. El SDK documenta que conserva su valor
  «después de un reinicio o de un ciclo de sueño profundo»; tras un corte de energía completo el contenido es indeterminado
  (el firmware ignora la marca cuando el motivo del reinicio es `ESP_RST_POWERON`). No se verificó en hardware qué ocurre
  en un reinicio por *brownout*.
* El BH1750 y el anemómetro no se han contrastado con hardware; la conversión del anemómetro supone 0 V = 0 m/s y
  5 V = 45 m/s (informe, tabla 3), sin desfase.
