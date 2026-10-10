/* =====================================================================
   NODO DEL INVERNADERO  -  monitoreo y riego automatico (ESP8266)
   ARCHIVO UNICO PARA ARDUINO IDE  -  firmware 1.0.0-esp8266
   DHT22 + YL-38/YL-69 + bomba de agua por rele  ->  dashboard (Supabase)
   Placas: NodeMCU 1.0 (ESP-12E), Wemos/LOLIN D1 mini y clones con ESP8266.

   TODO el firmware esta en ESTE archivo: no necesita ningun otro archivo. Puede
   copiarlo solo, a cualquier carpeta de sketches.

   PASOS (Arduino IDE 1.8 o 2.x)
   1) Placa ESP8266 (una sola vez):
        Archivo > Preferencias > "URLs adicionales del gestor de tarjetas":
          https://arduino.esp8266.com/stable/package_esp8266com_index.json
        Herramientas > Placa > Gestor de tarjetas > instalar
          "esp8266 by ESP8266 Community"  (compilado con la version 3.1.2)
   2) Bibliotecas (una sola vez): Herramientas > Administrar bibliotecas
          "DHT sensor library" y "Adafruit Unified Sensor"  (Adafruit)
          "ArduinoJson"  (Benoit Blanchon), version 7.x
   3) Edite SOLO el bloque "CONFIGURACION DEL USUARIO" (mas abajo):
        WIFI_SSID, WIFI_PASS, SERVER_URL y DEVICE_TOKEN.
   4) Herramientas > Placa: "NodeMCU 1.0 (ESP-12E Module)" o
      "LOLIN(WEMOS) D1 R2 & mini". Elija el Puerto, pulse Subir y abra el
      Monitor Serie a 115200.
   5) Conexiones (D5 = GPIO14, D6 = GPIO12, D7 = GPIO13): en la SECCION 2 (config.h).

   TENGA EN CUENTA
   - SERVER_URL debe ser la IP del PC en la red local (ej.: http://192.168.1.50:3000),
     con el dashboard iniciado con "npm run dev:lan" y el puerto 3000 permitido en el
     Firewall de Windows. "localhost" NO sirve: para la placa "localhost" es ella misma.
   - Solo para placas ESP8266. Para ESP32 use nodo_invernadero_unico_esp32.ino.
     No sirve en Arduino UNO, Nano ni Mega.
   - El ESP8266 tiene UN solo nucleo y UNA sola entrada analogica (A0): la usa el suelo
     (YL-38) o, en el nodo del mastil, el anemometro; nunca los dos en la misma placa.
   - Como un POST HTTP bloquea el bucle unos segundos, el nodo NUNCA hace red mientras la
     bomba esta encendida: los eventos quedan en cola y salen al apagarse. El corte de
     la bomba por tiempo se evalua en cada vuelta (~10 ms).
   - HTTPS usa mucha memoria del ESP8266: para las pruebas use http:// en la red local.
   - Sin WiFi ni servidor (o con los valores de ejemplo) el nodo igual riega de forma
     autonoma y muestra el estado por el Monitor Serie.
   - Con sus claves reales (WiFi, token) este archivo es sensible: si lo sube a Git,
     que sea a un repositorio PRIVADO.

   ESTE ARCHIVO ESTA GENERADO
   Nace de firmware/nodo_invernadero_esp8266 (lo propio del ESP8266: config, sensores,
   red y programa principal) y de riego.h, envio.h y protocolo.h de
   firmware/nodo_invernadero (la misma logica del ESP32, con pruebas de host).
   Si va a cambiar algo, edite esos archivos y vuelva a generar este con
        npm run firmware:unico        (desde la carpeta raiz del proyecto)

   ORDEN DEL ARCHIVO
     1. Configuracion del usuario (WiFi, servidor, token, opciones)
     2. config.h      pines, tiempos, opciones (ESP8266)
     3. riego.h       reglas del riego (logica pura, probada en el PC)
     4. envio.h       cuando enviar y reintentar tramas (logica pura, probada en el PC)
     5. protocolo.h   JSON de la trama y de la respuesta (docs/contrato-api.md)
     6. sensores.h    DHT22, YL-38, BH1750, anemometro y rele (ESP8266)
     7. red.h         WiFi + HTTP(S) (ESP8266)
     8. nodo_invernadero_esp8266.ino   setup() y loop(): une todo
   ===================================================================== */

#if !defined(ARDUINO_ARCH_ESP8266)
  #error "Este firmware es solo para placas ESP8266: en Herramientas > Placa elija NodeMCU 1.0 (ESP-12E Module) o LOLIN(WEMOS) D1 R2 & mini. Para ESP32 use nodo_invernadero_unico_esp32.ino. No sirve en Arduino UNO, Nano ni Mega."
#endif

/* ---------------------------------------------------------------------
   BIBLIOTECAS (las de ESP8266 vienen con la placa; DHT y ArduinoJson se instalan aparte)
   --------------------------------------------------------------------- */
#include <Arduino.h>
#include <EEPROM.h>
#include <stdint.h>
#include <string.h>
#include <stdio.h>
#include <math.h>
#include <stddef.h>
#include <stdarg.h>
#include <ArduinoJson.h>
#include <Wire.h>
#include <DHT.h>
#include <ESP8266WiFi.h>
#include <ESP8266HTTPClient.h>
#include <WiFiClientSecure.h>
#include <time.h>

/* #####################################################################
   SECCION 1 de 8:  CONFIGURACION DEL USUARIO  (WiFi, servidor, token y opciones)
   ##################################################################### */

/* Es lo UNICO que hay que editar. Mientras WIFI_SSID o DEVICE_TOKEN tengan los valores de
   ejemplo, el nodo NO intenta conectarse: solo riega de forma autonoma y muestra el estado
   por el Monitor Serie. */

/* Red WiFi del predio (2,4 GHz) */
#define WIFI_SSID     "Wifu"
#define WIFI_PASS     "admin123"

/* Direccion del dashboard, SIN barra final.
   Desarrollo (misma red):  http://192.168.1.50:3000   (npm run dev:lan en el dashboard)
   Produccion:              https://su-dominio.cl                                        */
#define SERVER_URL    "http://192.168.1.26:3000"

/* Token unico de ESTE nodo. Lo entrega el dashboard al crear el invernadero (Invernaderos >
   Nuevo invernadero) o al rotarlo (Equipos > Rotar token) y solo se muestra una vez.
   No lo comparta: si sube el proyecto a Git, que sea a un repositorio PRIVADO. */
#define DEVICE_TOKEN  "n8EsSeaCJRdA0-TclbcZllGRFQVqWpuDN3SOqxjHgD8"

/* HTTPS: pegar el certificado raiz (CA) que firma el certificado del servidor.
   Ejemplo (una sola cadena, con \n al final de cada linea):
   #define CA_ROOT_PEM "-----BEGIN CERTIFICATE-----\nMIID...\n-----END CERTIFICATE-----\n"  */
// #define CA_ROOT_PEM ""

/* SOLO PARA DESARROLLO: acepta cualquier certificado HTTPS (sin verificar al servidor).
   Deja el trafico expuesto a un intermediario. NO usar en produccion. */
// #define TLS_INSEGURO

/* Opciones del nodo (todas opcionales). Los valores por defecto ya sirven para un nodo de
   riego: solo quite el // de la linea que quiera cambiar. */
// #define NODO_MASTIL      1   // nodo del mastil: SIN suelo ni bomba (solo DHT22 y viento)  [por defecto 0]
// #define USAR_ANEMOMETRO  1   // lee el anemometro (usar junto con NODO_MASTIL 1)  [por defecto 0]
// #define USAR_BH1750      0   // busca el sensor de luz BH1750 (si no responde, "luz" va null y no es falla)  [por defecto 1]
// #define CONSOLA_SERIAL   0   // comandos por USB: r = regar 10 s, p = parar, s = estado (0 en produccion)  [por defecto 1]

/* #####################################################################
   SECCION 2 de 8:  config.h  -  pines, tiempos y opciones del nodo (ESP8266)
   ##################################################################### */

/* =====================================================================
   config.h  -  AJUSTES DEL NODO (ESP8266: NodeMCU, Wemos/LOLIN D1 mini y clones)

   Aqui va todo lo que se puede necesitar cambiar (pines, tiempos y opciones).
   Lo secreto (WiFi, servidor, token) va en el bloque CONFIGURACION DEL USUARIO
   (al inicio del archivo unico), NO aqui.

   TABLA DE CONEXIONES
   +------------------+-------------------+---------------------------------------+
   | Componente       | Pin del componente| Pin de la placa                       |
   +------------------+-------------------+---------------------------------------+
   | DHT22            | VCC / DATA / GND  | 3V3 / D5 (GPIO14) / GND (10k DATA-3V3)|
   | YL-38 (YL-69)    | VCC / A0 / GND    | D7 (GPIO13) / A0 / GND  (DO sin usar) |
   | Rele (DC+/DC-/IN)| DC+ / IN / DC-    | VIN (5 V) / D6 (GPIO12) / GND         |
   | BH1750 (opcional)| VCC / SDA/SCL/GND | 3V3 / D2 (GPIO4) / D1 (GPIO5) / GND   |
   | LED indicador    | (de la placa)     | GPIO2 = D4 (encendido = regando)      |
   | Anemometro (opc.)| senal 0-5 V       | A0 con divisor (solo NODO_MASTIL 1)   |
   +------------------+-------------------+---------------------------------------+
   El ESP8266 tiene UNA sola entrada analogica (A0): la usa el suelo (YL-38) o, en el
   nodo del mastil, el anemometro. Nunca los dos en la misma placa.

   MODULO YL-38 (MH-Sensor-Series, comparador LM393): el orden de los pines del modulo es
   AO - DO - GND - VCC (de izquierda a derecha, mirando los componentes). La sonda YL-69 va
   a los 2 pines del extremo superior (la polaridad no importa). El potenciometro azul solo
   ajusta la salida digital DO, no afecta a AO. DO se deja sin conectar.

   El YL-38 se alimenta desde D7 y solo se energiza al medir (evita que la sonda se
   corroa). Si su modulo consume mas de ~12 mA (el modulo con 2 LEDs puede hacerlo),
   alimentelo con un transistor: VCC del modulo a 3V3, GND del modulo al colector de un
   NPN (2N2222), emisor a GND, base a D7 con 1 k. El codigo no cambia (HIGH = medir).
   RELE Y MINIBOMBA SUMERGIBLE (DC, cable rojo/negro)
   Lado de control (3 bornes): DC+ -> VIN (5 V) | DC- -> GND | IN -> D6.
   Lado de potencia (3 bornes, NO - COM - NC): use COM y NO (NO = contacto abierto en reposo,
   asi la bomba queda apagada si la placa se reinicia). NO use NC.
        + de la fuente de la bomba -> COM
        NO -> cable ROJO de la bomba
        cable NEGRO de la bomba -> - de la fuente
   Si la fuente de la bomba es distinta de la placa, una sus GND (el - de la fuente con GND).
   Recomendado: diodo 1N4007 en paralelo con la bomba (raya/catodo hacia el rojo) para
   absorber el pico inductivo del motor. Nunca haga funcionar la bomba en seco.
   Detalle y comparacion con el ESP32: docs/hardware.md
   ===================================================================== */

#define FW_VERSION "1.0.0-esp8266"

/* ---------------------------------------------------------------------
   ROL Y OPCIONES DEL NODO
   --------------------------------------------------------------------- */
/* Cada opcion puede fijarse aqui o desde la linea de comandos (-DNODO_MASTIL=1 ...). */
#ifndef NODO_MASTIL
#define NODO_MASTIL      0   // 0 = nodo de invernadero (DHT22 + suelo + bomba)
                             // 1 = nodo del mastil: SIN suelo ni bomba (solo DHT22 y viento)
#endif
#ifndef USAR_ANEMOMETRO
#define USAR_ANEMOMETRO  0   // 1 = lee el anemometro por A0 (solo con NODO_MASTIL 1)
#endif
#ifndef USAR_BH1750
#define USAR_BH1750      1   // 1 = intenta leer el BH1750; si no responde, "luz" va null (sin falla)
#endif
#ifndef CONSOLA_SERIAL
#define CONSOLA_SERIAL   1   // 1 = acepta comandos por USB (r = regar 10 s, p = parar, s = estado)
                             // El informe pide deshabilitar el puerto de depuracion en produccion: poner 0.
#endif

#ifndef TABLA_SERIAL_S
#define TABLA_SERIAL_S   10  // segundos entre filas de la TABLA de estado del Monitor Serie (0 = no imprime la tabla)
#endif

#ifndef ARRANQUE_SIN_RIEGO_S
#define ARRANQUE_SIN_RIEGO_S  20   // tras encender/reiniciar NO se inicia ningun riego AUTOMATICO durante estos segundos (da tiempo a recibir la configuracion del
                                   // servidor, p. ej. "riego automatico desactivado"). El riego manual y las ordenes del dashboard funcionan siempre. 0 = sin espera.
#endif

#if USAR_ANEMOMETRO && !NODO_MASTIL
  #error "En ESP8266 el anemometro usa el unico pin analogico (A0), el mismo del suelo: use USAR_ANEMOMETRO solo junto con NODO_MASTIL 1 (nodo del mastil, sin suelo)."
#endif

/* ---------------------------------------------------------------------
   PINES (numeros GPIO; entre parentesis la etiqueta de la placa NodeMCU / D1 mini)
   Se evitan los pines de arranque: GPIO0 (D3), GPIO2 (D4, solo el LED) y GPIO15 (D8).
   --------------------------------------------------------------------- */
#define PIN_DHT            14   // D5: DATA del DHT22
#define PIN_SUELO          A0   // unica entrada analogica: AO del YL-38
#define PIN_SUELO_VCC      13   // D7: VCC del YL-38 (se energiza solo al medir)
#define PIN_RELE           12   // D6: IN del modulo de rele
#define PIN_LED             2   // D4: LED de la placa (en la NodeMCU/D1 mini se enciende con LOW)
#define PIN_SDA             4   // D2: I2C del BH1750
#define PIN_SCL             5   // D1
#define PIN_ANEMOMETRO     A0   // solo con NODO_MASTIL 1

/* Modulo de rele de 1 canal con optoacoplador y jumper H/L ("High/Low Level Trigger"):
     jumper en H -> el rele cierra con el pin en HIGH  => RELE_ACTIVO_EN_BAJO false
     jumper en L -> el rele cierra con el pin en LOW   => RELE_ACTIVO_EN_BAJO true
   Segun las fotos el jumper esta en H. Si al usar 'r' en el Monitor Serie el rele
   actua al reves (se activa al apagar), cambie el valor o mueva el jumper. */
#define RELE_ACTIVO_EN_BAJO  false
/* El LED integrado de la NodeMCU y de la D1 mini se enciende con el pin en LOW. */
#define LED_ACTIVO_EN_BAJO   true

/* ---------------------------------------------------------------------
   SENSOR DHT22
   --------------------------------------------------------------------- */
#define TIPO_DHT             DHT22
#define REINTENTOS_DHT       3      // intentos por ronda de medicion
#define REINTENTO_DHT_MS     2100   // el DHT22 pide >= 2 s entre lecturas

/* ---------------------------------------------------------------------
   SENSOR DE SUELO YL-38 / YL-69
   El ADC del ESP8266 ya es de 10 bits (0-1023): es EXACTAMENTE la escala de la tabla de la
   imagen, sin conversion. Se promedian varias muestras.
        0-299   SATURADO   sumergido / muy humedo
      300-699   OPTIMO     suelo humedo, adecuado para la mayoria de las plantas
      700-1023  SECO       tierra seca o sensor fuera del suelo (aire)
   NodeMCU y D1 mini llevan un divisor que lleva 0-3,2 V (pin A0) a 0-1 V (ADC). Un ESP-12
   pelado, sin divisor, solo admite 0-1 V en A0.
   --------------------------------------------------------------------- */
#define SUELO_MUESTRAS            10
#define SUELO_ESTABILIZACION_MS   40    // el modulo YL-38 tarda en estabilizar al energizarse (antes 300; si la lectura sale inestable, suba a 150 o 300)
#define SUELO_ENTRE_MUESTRAS_MS   2     // antes 20: 10 muestras en ~20 ms
#define SUELO_DISPERSION_MAX      150   // diferencia max-min entre muestras (0-1023) mas alla de
                                        // la cual la lectura se considera inestable (cable suelto).
                                        // Algo mas tolerante: el ADC del ESP8266 es ruidoso.
#define SUELO_RAW_MIN_VALIDO       20   // un YL-38 conectado NUNCA lee tan bajo (sumergido en agua da ~350-450). Con AO sin
                                        // conectar o el modulo sin energia, A0 queda a ~0 (lee 4-6): se informa como FALLA
                                        // del sensor ("suelo") en vez de "suelo saturado". 0 desactiva esta comprobacion.

/* Calibracion LOCAL: solo sirve para mostrar el % por el Monitor Serie. El % que ve el
   dashboard lo calcula el servidor con la calibracion del nodo (cal_dry / cal_wet).
   Una sonda YL-69 sumergida en agua casi nunca llega a 0: con 3,3 V suele dar ~350-450.
   Ajuste SUELO_RAW_AGUA_LOCAL con lo que lea en un vaso con agua. */
#define SUELO_RAW_AIRE_LOCAL   1023     // lectura con el sensor al aire   -> 0 %
#define SUELO_RAW_AGUA_LOCAL    400     // lectura con el sensor en agua   -> 100 %

/* ---------------------------------------------------------------------
   BH1750 (I2C, direccion 0x23) y ANEMOMETRO (0-5 V = 0-45 m/s)
   Divisor para el anemometro: R_ARRIBA = 20 k (entre la senal y A0) y
   R_ABAJO = 10 k (entre A0 y GND) => 5 V -> 1,67 V en el pin A0.
   ADC_A0_ESCALA_V es la tension en A0 que da la lectura maxima (1023): 3,2 V en la
   NodeMCU y en la D1 mini.
   --------------------------------------------------------------------- */
#define BH1750_DIRECCION      0x23
#define ANEMOMETRO_R_ARRIBA   20000.0f
#define ANEMOMETRO_R_ABAJO    10000.0f
#define ANEMOMETRO_V_MAX      5.0f
#define ANEMOMETRO_MS_MAX     45.0f
#define ADC_A0_ESCALA_V       3.2f

/* ---------------------------------------------------------------------
   TIEMPOS DEL BUCLE Y DE LA RED
   --------------------------------------------------------------------- */
#define MUESTREO_RIEGO_S      5       // mientras la bomba esta encendida se mide cada 5 s
#define PERIODO_LOOP_MS       1       // antes 10: pausa por vuelta (el corte por tiempo se evalua en cada una)
#define TRAMAS_AVISO_WDT      3       // cuantas tramas informan "reinicio_wdt" tras un reinicio por watchdog
#define HTTP_TIMEOUT_MS       8000    // tiempo maximo de un POST. El ESP8266 no tiene otro nucleo: mientras
                                      // dura, el bucle espera; por eso NUNCA se hace con la bomba encendida.
#define WIFI_REINTENTO_MS     20000   // primer reintento de conexion WiFi; luego se duplica hasta 5 min

/* HTTPS en ESP8266 (BearSSL): memoria para los buffers de TLS. Con 16 KB de entrada cabe cualquier
   servidor pero casi toda la RAM libre se va en eso; con menos, algunos servidores fallan. */
#define TLS_BUFFER_RX         4096
#define TLS_BUFFER_TX         1024

/* #####################################################################
   SECCION 3 de 8:  riego.h  -  reglas del riego (logica pura, igual que en el ESP32)
   ##################################################################### */

/* =====================================================================
   riego.h  -  CONTROLADOR DE RIEGO (logica pura, sin Arduino)

   Este archivo no incluye nada de Arduino ni toca pines: recibe las
   lecturas y el tiempo (milisegundos) como parametros y devuelve
   decisiones (bomba si/no, eventos, respuestas a ordenes). Por eso se
   puede probar en el PC:  firmware/test/test_riego.cpp

   Reglas implementadas (contrato de la API, secciones 4, 6 y 7):
     1. Estado seguro al arrancar: bomba apagada.
     2. INICIO automatico solo si: hay lectura valida de suelo y de
        temperatura, suelo >= suelo_on, temp <= temp_max, no esta en
        espera entre riegos y el suelo no esta SATURADO.
     3. FIN por: suelo <= suelo_off (objetivo) | riego_max_s (tiempo_max)
        | falla del sensor de suelo (seguridad) | banda SATURADO en un
        riego manual (saturado) | orden (orden).
     4. El corte por tiempo se evalua en CADA llamada a tick(); el
        sketch llama a tick() en cada vuelta de loop() (~10 ms).
     5. Al terminar cualquier riego empieza la espera entre riegos
        (espera_s): protege el motor de arranques repetidos.
     6. Sin servidor el controlador sigue funcionando: solo necesita la
        ultima configuracion valida.

   Sobre el desborde de millis() (uint32, cada ~49,7 dias): el
   controlador lleva su propio reloj de 64 bits, que avanza con la
   diferencia SIN SIGNO entre dos llamadas consecutivas. Todas las
   comparaciones internas usan ese reloj, asi que el desborde no
   produce esperas falsas ni cortes tardios.
   ===================================================================== */

namespace riego {

/* ---------- Limites duros y valores por defecto (contrato, seccion 6) ---------- */
static const uint16_t INTERVALO_MIN_S = 5;
static const uint16_t INTERVALO_MAX_S = 3600;
static const uint16_t INTERVALO_DEF_S = 300;   // informe: 1 lectura cada 5 min

static const uint16_t SUELO_MAX_RAW   = 1023;  // escala de 10 bits (tabla de la imagen)
static const uint16_t SUELO_ON_DEF    = 700;   // 700-1023: SECO -> regar
static const uint16_t SUELO_OFF_DEF   = 500;   // mitad de la banda OPTIMO (300-700)
static const uint16_t SUELO_SAT_DEF   = 300;   // 0-299: SATURADO -> no regar

static const float    TEMP_MAX_MIN    = 30.0f;
static const float    TEMP_MAX_MAX    = 60.0f;
static const float    TEMP_MAX_DEF    = 40.0f; // informe: no regar sobre 40 C

static const uint16_t RIEGO_MAX_MIN_S = 5;
static const uint16_t RIEGO_MAX_MAX_S = 120;   // tope absoluto, ninguna orden lo supera
static const uint16_t RIEGO_MAX_DEF_S = 30;    // informe: 30 s por ciclo

static const uint16_t ESPERA_MIN_S    = 0;     // 0 = sin espera entre riegos (el nodo igual descansa DESCANSO_MIN_MS para poder informar al servidor)
static const uint32_t DESCANSO_MIN_MS = 3000;
static const uint16_t ESPERA_MAX_S    = 3600;
static const uint16_t ESPERA_DEF_S    = 300;   // informe: 5 min entre riegos

static const uint16_t ORDEN_DUR_MIN_S = 5;     // duracion valida de una orden manual
static const uint16_t ORDEN_DUR_MAX_S = 120;

static const uint8_t  COLA_MAX        = 8;     // eventos y acks pendientes (contrato)
static const uint8_t  IDS_RECORDADOS  = 8;     // ordenes atendidas que se recuerdan
static const uint8_t  ID_MAX          = 40;    // 39 caracteres + NUL
static const uint8_t  DETALLE_MAX     = 56;

/* ---------- Banda del suelo (tabla de la imagen de la clase) ---------- */
enum Banda : uint8_t { BANDA_SATURADO = 0, BANDA_OPTIMO = 1, BANDA_SECO = 2 };

inline const char* nombreBanda(Banda b) {
  switch (b) {
    case BANDA_SATURADO: return "SATURADO";
    case BANDA_OPTIMO:   return "OPTIMO";
    default:             return "SECO";
  }
}

/* ---------- Configuracion (la entrega el servidor en "cfg") ---------- */
struct Config {
  uint32_t ver;          // version de la configuracion (la fija el servidor)
  uint16_t intervalo_s;  // segundos entre tramas de telemetria
  uint16_t suelo_on;     // regar si suelo_raw >= suelo_on
  uint16_t suelo_off;    // dejar de regar si suelo_raw <= suelo_off
  uint16_t suelo_sat;    // SATURADO si suelo_raw < suelo_sat
  float    temp_max;     // no iniciar riego automatico sobre esta temperatura (C)
  uint16_t riego_max_s;  // corte duro por ciclo de riego
  uint16_t espera_s;     // espera obligatoria entre riegos
  bool     auto_riego;   // false = el nodo NO inicia riegos automaticos (lo manual sigue funcionando)
};

inline Config configPorDefecto() {
  Config c;
  c.ver         = 0;
  c.intervalo_s = INTERVALO_DEF_S;
  c.suelo_on    = SUELO_ON_DEF;
  c.suelo_off   = SUELO_OFF_DEF;
  c.suelo_sat   = SUELO_SAT_DEF;
  c.temp_max    = TEMP_MAX_DEF;
  c.riego_max_s = RIEGO_MAX_DEF_S;
  c.espera_s    = ESPERA_DEF_S;
  c.auto_riego  = true;
  return c;
}

/* Una configuracion que viole cualquiera de estas reglas se IGNORA completa. */
inline bool configValida(const Config& c) {
  if (c.intervalo_s < INTERVALO_MIN_S || c.intervalo_s > INTERVALO_MAX_S) return false;
  if (c.suelo_sat < 1 || c.suelo_on > SUELO_MAX_RAW) return false;
  if (!(c.suelo_sat < c.suelo_off && c.suelo_off < c.suelo_on)) return false;
  if (!(c.temp_max >= TEMP_MAX_MIN && c.temp_max <= TEMP_MAX_MAX)) return false;  // falso tambien con NaN
  if (c.riego_max_s < RIEGO_MAX_MIN_S || c.riego_max_s > RIEGO_MAX_MAX_S) return false;
  if (c.espera_s > ESPERA_MAX_S) return false;                                    // (0 = sin espera)
  return true;
}

inline bool configIgual(const Config& a, const Config& b) {
  return a.ver == b.ver && a.intervalo_s == b.intervalo_s && a.suelo_on == b.suelo_on &&
         a.suelo_off == b.suelo_off && a.suelo_sat == b.suelo_sat && a.temp_max == b.temp_max &&
         a.riego_max_s == b.riego_max_s && a.espera_s == b.espera_s && a.auto_riego == b.auto_riego;
}

/* ---------- Lectura de los sensores (una ronda de medicion) ---------- */
struct Lectura {
  bool  suelo_ok;    // false = el sensor de suelo fallo (lectura inestable o ausente)
  int   suelo_raw;   // 0..1023
  bool  temp_ok;     // false = el DHT22 fallo o dio un valor imposible
  float temp;        // grados Celsius
};

/* ---------- Estado del controlador (campo "est" de la trama) ---------- */
enum Est : uint8_t { EST_IDLE = 0, EST_RIEGO, EST_ESPERA, EST_BLOQ_TEMP, EST_BLOQ_SENSOR, EST_SATURADO };

inline const char* nombreEst(Est e) {
  switch (e) {
    case EST_RIEGO:       return "riego";
    case EST_ESPERA:      return "espera";
    case EST_BLOQ_TEMP:   return "bloq_temp";
    case EST_BLOQ_SENSOR: return "bloq_sensor";
    case EST_SATURADO:    return "saturado";
    default:              return "idle";
  }
}

/* ---------- Eventos de la bomba (campo "ev") ---------- */
enum MotivoOn  : uint8_t { ON_AUTO = 0, ON_MANUAL = 1 };
enum MotivoOff : uint8_t { OFF_OBJETIVO = 0, OFF_TIEMPO_MAX, OFF_ORDEN, OFF_SEGURIDAD, OFF_SATURADO };

inline const char* nombreOn(uint8_t m)  { return m == ON_MANUAL ? "manual" : "auto"; }
inline const char* nombreOff(uint8_t m) {
  switch (m) {
    case OFF_OBJETIVO:   return "objetivo";
    case OFF_TIEMPO_MAX: return "tiempo_max";
    case OFF_ORDEN:      return "orden";
    case OFF_SEGURIDAD:  return "seguridad";
    default:             return "saturado";
  }
}

struct Evento {
  uint32_t seq;            // numero creciente: sirve para confirmar "hasta aqui"
  bool     encendido;      // true = pump_on, false = pump_off
  uint8_t  motivo;         // MotivoOn o MotivoOff segun "encendido"
  uint64_t t_ms;           // reloj interno cuando ocurrio
  uint16_t dur_s;          // segundos de riego (solo pump_off)
  char     cmd[ID_MAX];    // id de la orden asociada ("" si no hay)
};

/* ---------- Ordenes del servidor (campo "ordenes" de la respuesta) ---------- */
enum TipoOrden : uint8_t { ORDEN_RIEGO = 0, ORDEN_PARAR, ORDEN_DESCONOCIDA };

struct Orden {
  char      id[ID_MAX];    // "" = orden local (consola Serie): sin dedupe ni acuse
  TipoOrden tipo;
  uint16_t  dur_s;         // solo ORDEN_RIEGO
  uint32_t  vence_s;       // segundos de validez contados desde que llego
  uint32_t  recibida_ms;   // millis() al recibirla
};

struct AckOrden {
  uint32_t seq;
  char     id[ID_MAX];
  bool     ejecutada;      // true = "ejecutada", false = "rechazada"
  char     detalle[DETALLE_MAX];
};

struct ResultadoOrden {
  bool ignorada;           // duplicada: no se ejecuta ni se acusa de nuevo
  bool ejecutada;
  char detalle[DETALLE_MAX];
};

/* ===================================================================== */
class Controlador {
 public:
  Controlador() { ponerACero(0, false); }

  /* Arranque en ESTADO SEGURO. riego_interrumpido = true si el reinicio
     ocurrio con la bomba encendida (lo detecta el sketch): se parte con
     la espera activa para no repetir el riego de inmediato y se informa
     el corte como "seguridad". */
  void iniciar(uint32_t ahora_ms, bool riego_interrumpido) { ponerACero(ahora_ms, riego_interrumpido); }

  /* Nodo del mastil: no tiene bomba, asi que las ordenes de riego se rechazan. */
  void sinBomba(bool v) { sin_bomba_ = v; }

  /* Tras encender, no se inicia ningun riego AUTOMATICO durante "segundos" (el manual no se afecta). */
  void bloquearRiegoAutoAlArrancar(uint32_t segundos) {
    arranque_activo_ = segundos > 0;
    arranque_ms_ = segundos * 1000UL;
    t_arranque_ = reloj_;
  }

  /* Devuelve false (y conserva la anterior) si la configuracion es invalida. */
  bool aplicarConfig(const Config& nueva) {
    if (!configValida(nueva)) return false;
    cfg_ = nueva;
    return true;
  }
  const Config& config() const { return cfg_; }

  /* Llamar en CADA vuelta de loop(): corte por tiempo y fin de la espera. */
  void tick(uint32_t ahora_ms) {
    avanzar(ahora_ms);
    if (arranque_activo_ && reloj_ - t_arranque_ >= arranque_ms_) {
      arranque_activo_ = false;
      /* Terminada la espera de arranque: si el suelo estaba seco se mide YA para decidir con un dato fresco. */
      if (!bomba_ && hay_lectura_ && lec_.suelo_ok && lec_.suelo_raw >= (int)cfg_.suelo_on) muestra_pendiente_ = true;
    }
    if (bomba_) {
      const uint64_t trans = reloj_ - t_inicio_;
      const uint64_t tope  = (uint64_t)cfg_.riego_max_s * 1000ULL;
      if (manual_ && trans >= dur_orden_ms_) apagar(OFF_ORDEN, cmd_activa_);
      else if (trans >= tope)                apagar(OFF_TIEMPO_MAX, cmd_activa_);
    } else if (espera_activa_) {
      if (reloj_ - t_fin_ >= esperaMs()) {
        espera_activa_ = false;
        /* Si la ultima lectura pedia riego, se pide medir de nuevo YA: nunca se
           decide un riego con una lectura vieja (tomada antes de regar). */
        if (hay_lectura_ && lec_.suelo_ok && lec_.suelo_raw >= (int)cfg_.suelo_on) muestra_pendiente_ = true;
      }
    }
  }

  /* Entrega una ronda de medicion y evalua las reglas de inicio/fin. */
  void nuevaLectura(const Lectura& l, uint32_t ahora_ms) {
    avanzar(ahora_ms);
    lec_ = l;
    if (lec_.suelo_ok && (lec_.suelo_raw < 0 || lec_.suelo_raw > (int)SUELO_MAX_RAW)) lec_.suelo_ok = false;
    if (lec_.temp_ok && (isnan(lec_.temp) || lec_.temp < -40.0f || lec_.temp > 80.0f)) lec_.temp_ok = false;
    hay_lectura_ = true;
    muestra_pendiente_ = false;
    evaluar();
  }

  /* Procesa una orden del servidor (o local si id == ""). Ver contrato, seccion 4. */
  ResultadoOrden atenderOrden(const Orden& o, uint32_t ahora_ms) {
    avanzar(ahora_ms);
    ResultadoOrden r;
    r.ignorada = false;
    r.ejecutada = false;
    r.detalle[0] = 0;
    const bool con_id = o.id[0] != 0;

    if (con_id) {
      if (yaAtendida(o.id)) { r.ignorada = true; return r; }   // el servidor la reentrego: no se repite
      recordarId(o.id);
    }

    if (o.tipo == ORDEN_DESCONOCIDA) {
      return terminarOrden(o, false, "tipo de orden desconocido", r);
    }

    if (o.tipo == ORDEN_PARAR) {
      /* Detener siempre es la direccion segura: se ejecuta aunque haya vencido. */
      if (bomba_) {
        apagar(OFF_ORDEN, con_id ? o.id : cmd_activa_);
        return terminarOrden(o, true, "bomba apagada", r);
      }
      return terminarOrden(o, true, "ya estaba apagada", r);
    }

    /* ---- ORDEN_RIEGO ---- */
    uint32_t desde_recibida = (uint32_t)(ahora_ms - o.recibida_ms);
    if (desde_recibida >= 0x80000000UL) desde_recibida = 0;          // reloj "hacia atras": cuenta como 0 ms
    if ((uint64_t)desde_recibida >= (uint64_t)o.vence_s * 1000ULL) return terminarOrden(o, false, "vencida", r);

    if (sin_bomba_) return terminarOrden(o, false, "nodo sin bomba", r);

    if (o.dur_s < ORDEN_DUR_MIN_S || o.dur_s > ORDEN_DUR_MAX_S) {
      snprintf(r.detalle, DETALLE_MAX, "duracion invalida (%u-%u s)", (unsigned)ORDEN_DUR_MIN_S, (unsigned)ORDEN_DUR_MAX_S);
      return terminarOrden(o, false, r.detalle, r);
    }
    if (bomba_) return terminarOrden(o, false, "ya esta regando", r);
    if (espera_activa_) {
      char t[DETALLE_MAX];
      snprintf(t, DETALLE_MAX, "en espera entre riegos (faltan %u s)", (unsigned)esperaRestanteS());
      return terminarOrden(o, false, t, r);
    }
    if (hay_lectura_ && lec_.suelo_ok && lec_.suelo_raw < (int)cfg_.suelo_sat) {
      return terminarOrden(o, false, "suelo saturado", r);
    }

    uint16_t dur = o.dur_s;
    bool acortada = false;
    if (dur > cfg_.riego_max_s) { dur = cfg_.riego_max_s; acortada = true; }

    /* Si el sensor de suelo ya estaba en falla, el operador decide: se riega el
       tiempo pedido y los cortes por suelo no se aplican en este riego. */
    const bool sin_sensor = !(hay_lectura_ && lec_.suelo_ok);
    encender(ON_MANUAL, (uint32_t)dur * 1000UL, con_id ? o.id : "", sin_sensor);

    char t[DETALLE_MAX];
    if (acortada)        snprintf(t, DETALLE_MAX, "regando %u s (acortada por el maximo)", (unsigned)dur);
    else if (sin_sensor) snprintf(t, DETALLE_MAX, "regando %u s (suelo sin lectura)", (unsigned)dur);
    else                 snprintf(t, DETALLE_MAX, "regando %u s", (unsigned)dur);
    return terminarOrden(o, true, t, r);
  }

  /* ---------- Consulta de estado ---------- */
  bool bombaEncendida() const { return bomba_; }

  Est estado() const {
    if (bomba_) return EST_RIEGO;
    if (!hay_lectura_ || !lec_.suelo_ok) return EST_BLOQ_SENSOR;
    if (lec_.suelo_raw < (int)cfg_.suelo_sat) return EST_SATURADO;
    if (espera_activa_ || arranque_activo_) return EST_ESPERA;
    if (lec_.suelo_raw >= (int)cfg_.suelo_on && (!lec_.temp_ok || lec_.temp > cfg_.temp_max)) return EST_BLOQ_TEMP;
    return EST_IDLE;
  }

  uint32_t esperaRestanteS() const {
    if (bomba_) return 0;
    uint32_t arr = 0;                                          // espera de arranque (sin riego automatico)
    if (arranque_activo_ && reloj_ - t_arranque_ < arranque_ms_) arr = (uint32_t)((arranque_ms_ - (reloj_ - t_arranque_) + 999ULL) / 1000ULL);
    if (!espera_activa_) return arr;
    const uint64_t total = esperaMs();
    const uint64_t pasado = reloj_ - t_fin_;
    if (pasado >= total) return arr;
    const uint32_t esp = (uint32_t)((total - pasado + 999ULL) / 1000ULL);   // redondeo hacia arriba
    return esp > arr ? esp : arr;
  }

  uint32_t riegoS() const { return bomba_ ? (uint32_t)((reloj_ - t_inicio_) / 1000ULL) : 0; }
  uint32_t uptimeS() const { return (uint32_t)(reloj_ / 1000ULL); }

  Banda banda(int raw) const {
    if (raw < (int)cfg_.suelo_sat) return BANDA_SATURADO;
    if (raw >= (int)cfg_.suelo_on) return BANDA_SECO;
    return BANDA_OPTIMO;
  }

  /* true UNA vez cuando termino la espera con demanda de riego: el sketch debe medir ya. */
  bool quiereMuestraYa() {
    const bool q = muestra_pendiente_;
    muestra_pendiente_ = false;
    return q;
  }

  /* ---------- Colas de eventos y acuses (se vacian solo tras un 200 del servidor) ---------- */
  uint8_t eventosPendientes() const { return n_ev_; }
  const Evento& evento(uint8_t i) const { return ev_[i]; }
  uint32_t agoEventoS(uint8_t i) const {
    const uint64_t d = reloj_ - ev_[i].t_ms;
    const uint64_t s = d / 1000ULL;
    return s > 86400ULL ? 86400U : (uint32_t)s;
  }
  uint32_t ultimoEventoSeq() const { return n_ev_ ? ev_[n_ev_ - 1].seq : 0; }
  void descartarEventosHasta(uint32_t seq) {
    uint8_t k = 0;
    while (k < n_ev_ && ev_[k].seq <= seq) k++;
    if (k) {
      memmove(&ev_[0], &ev_[k], (size_t)(n_ev_ - k) * sizeof(Evento));
      n_ev_ = (uint8_t)(n_ev_ - k);
    }
  }

  uint8_t acksPendientes() const { return n_ack_; }
  const AckOrden& ack(uint8_t i) const { return ack_[i]; }
  uint32_t ultimoAckSeq() const { return n_ack_ ? ack_[n_ack_ - 1].seq : 0; }
  void descartarAcksHasta(uint32_t seq) {
    uint8_t k = 0;
    while (k < n_ack_ && ack_[k].seq <= seq) k++;
    if (k) {
      memmove(&ack_[0], &ack_[k], (size_t)(n_ack_ - k) * sizeof(AckOrden));
      n_ack_ = (uint8_t)(n_ack_ - k);
    }
  }

  /* Vacia ambas colas (si el servidor rechaza una y otra vez la misma trama). */
  void vaciarColas() { n_ev_ = 0; n_ack_ = 0; }

 private:
  Config   cfg_;
  Lectura  lec_;
  bool     hay_lectura_;
  bool     sin_bomba_;

  uint64_t reloj_;          // ms monotonicos de 64 bits (inmune al desborde de millis)
  uint32_t ultimo32_;       // ultimo millis() visto

  bool     bomba_;
  bool     manual_;
  bool     manual_ignora_suelo_;
  uint32_t dur_orden_ms_;
  uint64_t t_inicio_;
  char     cmd_activa_[ID_MAX];

  bool     espera_activa_;
  uint64_t t_fin_;
  bool     muestra_pendiente_;
  bool     arranque_activo_;
  uint32_t arranque_ms_;
  uint64_t t_arranque_;

  Evento   ev_[COLA_MAX];
  uint8_t  n_ev_;
  uint32_t ev_seq_;
  AckOrden ack_[COLA_MAX];
  uint8_t  n_ack_;
  uint32_t ack_seq_;

  char     ids_[IDS_RECORDADOS][ID_MAX];
  uint8_t  ids_pos_;

  /* Espera entre riegos efectiva: la configurada, pero nunca menos de DESCANSO_MIN_MS (con espera 0 el nodo
     descansa 3 s: es el tiempo que necesita para enviar al servidor los eventos del riego que acaba de terminar). */
  uint64_t esperaMs() const {
    const uint64_t e = (uint64_t)cfg_.espera_s * 1000ULL;
    return e < DESCANSO_MIN_MS ? (uint64_t)DESCANSO_MIN_MS : e;
  }

  void ponerACero(uint32_t ahora_ms, bool riego_interrumpido) {
    cfg_ = configPorDefecto();
    lec_.suelo_ok = false; lec_.suelo_raw = 0; lec_.temp_ok = false; lec_.temp = 0.0f;
    hay_lectura_ = false;
    sin_bomba_ = false;
    reloj_ = ahora_ms;
    ultimo32_ = ahora_ms;
    bomba_ = false; manual_ = false; manual_ignora_suelo_ = false;
    dur_orden_ms_ = 0; t_inicio_ = 0; cmd_activa_[0] = 0;
    espera_activa_ = false; t_fin_ = 0; muestra_pendiente_ = false;
    arranque_activo_ = false; arranque_ms_ = 0; t_arranque_ = 0;
    memset(ev_, 0, sizeof(ev_));   n_ev_ = 0;  ev_seq_ = 0;
    memset(ack_, 0, sizeof(ack_)); n_ack_ = 0; ack_seq_ = 0;
    memset(ids_, 0, sizeof(ids_)); ids_pos_ = 0;
    if (riego_interrumpido) {
      espera_activa_ = true;
      t_fin_ = reloj_;
      encolarEvento(false, OFF_SEGURIDAD, 0, "");
    }
  }

  void avanzar(uint32_t ahora_ms) {
    const uint32_t d = ahora_ms - ultimo32_;      // resta sin signo: correcta a traves del desborde
    if (d >= 0x80000000UL) return;                // marca "hacia atras" (llamada con un millis() ya viejo): se ignora
    reloj_ += d;
    ultimo32_ = ahora_ms;
  }

  /* Reglas de inicio / fin que dependen de una lectura nueva. */
  void evaluar() {
    if (bomba_) {
      if (!lec_.suelo_ok) {
        if (!(manual_ && manual_ignora_suelo_)) apagar(OFF_SEGURIDAD, cmd_activa_);
        return;
      }
      if (manual_) {
        if (!manual_ignora_suelo_ && lec_.suelo_raw < (int)cfg_.suelo_sat) apagar(OFF_SATURADO, cmd_activa_);
      } else {
        if (lec_.suelo_raw <= (int)cfg_.suelo_off) apagar(OFF_OBJETIVO, cmd_activa_);
      }
      return;
    }
    /* Bomba apagada: corresponde iniciar un riego automatico? */
    if (!cfg_.auto_riego) return;                                // riego automatico desactivado desde el dashboard
    if (arranque_activo_) return;                                // recien encendido: se espera la configuracion del servidor
    if (!lec_.suelo_ok) return;                                  // sin lectura de suelo no se decide
    if (lec_.suelo_raw < (int)cfg_.suelo_on) return;             // no hace falta regar
    if (lec_.suelo_raw < (int)cfg_.suelo_sat) return;            // SATURADO (defensa en profundidad)
    if (!lec_.temp_ok) return;                                   // sin temperatura valida: se bloquea
    if (lec_.temp > cfg_.temp_max) return;                       // demasiado calor: se pospone
    if (espera_activa_) return;                                  // el motor descansa
    encender(ON_AUTO, 0, "", false);
  }

  void encender(uint8_t motivo, uint32_t dur_orden_ms, const char* cmd, bool ignora_suelo) {
    bomba_ = true;
    manual_ = (motivo == ON_MANUAL);
    manual_ignora_suelo_ = manual_ && ignora_suelo;
    dur_orden_ms_ = dur_orden_ms;
    t_inicio_ = reloj_;
    copiar(cmd_activa_, ID_MAX, cmd);
    encolarEvento(true, motivo, 0, cmd);
  }

  void apagar(uint8_t motivo, const char* cmd) {
    uint64_t ms = reloj_ - t_inicio_;
    uint64_t s = (ms + 500ULL) / 1000ULL;                        // segundos, redondeo al mas cercano
    if (s > 65535ULL) s = 65535ULL;
    char cmd_copia[ID_MAX];
    copiar(cmd_copia, ID_MAX, cmd);                              // cmd puede apuntar a cmd_activa_
    bomba_ = false;
    manual_ = false;
    manual_ignora_suelo_ = false;
    cmd_activa_[0] = 0;
    espera_activa_ = true;                                       // empieza la espera entre riegos
    t_fin_ = reloj_;
    encolarEvento(false, motivo, (uint16_t)s, cmd_copia);
  }

  void encolarEvento(bool encendido, uint8_t motivo, uint16_t dur_s, const char* cmd) {
    if (n_ev_ >= COLA_MAX) {                                     // cola llena: se descarta el mas antiguo
      memmove(&ev_[0], &ev_[1], (size_t)(COLA_MAX - 1) * sizeof(Evento));
      n_ev_ = (uint8_t)(COLA_MAX - 1);
    }
    Evento& e = ev_[n_ev_++];
    e.seq = ++ev_seq_;
    e.encendido = encendido;
    e.motivo = motivo;
    e.t_ms = reloj_;
    e.dur_s = dur_s;
    copiar(e.cmd, ID_MAX, cmd);
  }

  ResultadoOrden terminarOrden(const Orden& o, bool ejecutada, const char* detalle, ResultadoOrden r) {
    r.ejecutada = ejecutada;
    copiar(r.detalle, DETALLE_MAX, detalle);
    if (o.id[0] != 0) {                                          // las ordenes locales no se acusan
      if (n_ack_ >= COLA_MAX) {
        memmove(&ack_[0], &ack_[1], (size_t)(COLA_MAX - 1) * sizeof(AckOrden));
        n_ack_ = (uint8_t)(COLA_MAX - 1);
      }
      AckOrden& a = ack_[n_ack_++];
      a.seq = ++ack_seq_;
      copiar(a.id, ID_MAX, o.id);
      a.ejecutada = ejecutada;
      copiar(a.detalle, DETALLE_MAX, r.detalle);
    }
    return r;
  }

  bool yaAtendida(const char* id) const {
    for (uint8_t i = 0; i < IDS_RECORDADOS; i++) if (ids_[i][0] && strcmp(ids_[i], id) == 0) return true;
    return false;
  }
  void recordarId(const char* id) {
    copiar(ids_[ids_pos_], ID_MAX, id);
    ids_pos_ = (uint8_t)((ids_pos_ + 1) % IDS_RECORDADOS);       // anillo: el 9.o desplaza al 1.o
  }

  static void copiar(char* dst, size_t n, const char* src) {
    if (n == 0) return;
    size_t i = 0;
    if (src) for (; i + 1 < n && src[i]; i++) dst[i] = src[i];
    dst[i] = 0;
  }
};

}  // namespace riego

/* #####################################################################
   SECCION 4 de 8:  envio.h  -  cuando enviar y reintentar tramas (logica pura)
   ##################################################################### */

/* =====================================================================
   envio.h  -  POLITICA DE ENVIO DE TRAMAS (logica pura, sin Arduino)

   Decide CUANDO se envia una trama al servidor y que hacer con cada
   resultado. No conoce WiFi ni HTTP: el sketch le informa lo que pasa.
   Se prueba en el PC: firmware/test/test_envio.cpp

   Reglas (contrato de la API, secciones 1 y 3):
     - Una trama nueva cada intervalo_s, y de inmediato si hay eventos o
       acuses nuevos (con una separacion minima de 2 s entre envios).
     - Si el POST falla (sin red, timeout, 5xx) se REINTENTA LA MISMA
       TRAMA (mismo seq): si el servidor ya la habia procesado responde
       "dup:true" y no la reprocesa, asi que reintentar es seguro.
       Maximo 3 intentos por trama; despues se descarta y se arma una
       nueva con espera creciente (10 s, 20 s, 40 s ... tope 5 min).
     - 401: esperar 60 s.  429: esperar Retry-After.  400/413: descartar
       la trama; tras 3 rechazos seguidos se vacian las colas para que una
       trama defectuosa no bloquee el envio para siempre.
     - Mientras hay un envio en vuelo no se lanza otro; si la tarea de red
       no responde en 30 s se da por fallido.
   Todas las comparaciones usan diferencias SIN SIGNO de millis(), asi que
   el desborde cada ~49 dias no las afecta.
   ===================================================================== */

namespace envio {

static const uint32_t SEPARACION_MIN_MS    = 1200;   // el servidor exige > 1000 ms entre tramas de un mismo nodo
static const uint32_t TIMEOUT_EN_VUELO_MS  = 30000;
static const uint8_t  INTENTOS_MAX         = 3;
static const uint32_t PASO_REINTENTO_MS    = 3000;    // 3 s tras el 1.o fallo, 6 s tras el 2.o
static const uint32_t BACKOFF_BASE_MS      = 10000;
static const uint32_t BACKOFF_MAX_MS       = 300000;
static const uint32_t BACKOFF_MIN_MS       = 5000;
static const uint32_t ESPERA_401_MS        = 60000;
static const uint32_t ESPERA_429_DEF_MS    = 30000;
static const uint32_t ESPERA_429_MAX_MS    = 600000;
static const uint8_t  RECHAZOS_PARA_LIMPIAR = 3;

enum Accion : uint8_t { NADA = 0, ENVIAR_NUEVA, REENVIAR };
enum Resultado : uint8_t {
  EXITO = 0,           // 200 con cuerpo valido: vaciar colas y aplicar cfg/ordenes
  REINTENTAR,          // se conserva la trama para reenviarla igual
  DESCARTAR,           // se abandona la trama (las colas de eventos/acuses se conservan)
  DESCARTAR_Y_LIMPIAR  // ademas se vacian las colas (trama defectuosa)
};

class Plan {
 public:
  Plan() { iniciar(0); }

  void iniciar(uint32_t ahora_ms) {
    en_vuelo_ = false;
    pendiente_ = false;
    penalizado_ = false;
    enviado_alguna_vez_ = false;
    intentos_ = 0;
    fallos_seguidos_ = 0;
    rechazos_ = 0;
    t_envio_ = ahora_ms;
    t_ultimo_envio_ = ahora_ms;
    t_ref_ = ahora_ms;
    espera_ms_ = 0;             // la primera trama sale apenas haya datos y red
  }

  /* listo: hay una ronda de medicion completa y la red esta conectada.
     hay_novedades: hay eventos o acuses que aun no viajaron. */
  Accion decidir(uint32_t ahora_ms, bool listo, bool hay_novedades) const {
    if (en_vuelo_ || !listo) return NADA;
    if (enviado_alguna_vez_ && desde(ahora_ms, t_ultimo_envio_) < SEPARACION_MIN_MS) return NADA;
    const bool vencio = desde(ahora_ms, t_ref_) >= espera_ms_;
    if (pendiente_) return vencio ? REENVIAR : NADA;
    if (!penalizado_ && hay_novedades) return ENVIAR_NUEVA;   // novedad: sin esperar al periodo
    return vencio ? ENVIAR_NUEVA : NADA;
  }

  /* La trama (nueva o reintento) se entrego a la tarea de red. */
  void entregada(uint32_t ahora_ms) {
    if (!pendiente_) { pendiente_ = true; intentos_ = 0; }
    intentos_++;
    en_vuelo_ = true;
    t_envio_ = ahora_ms;
    t_ultimo_envio_ = ahora_ms;
    enviado_alguna_vez_ = true;
  }

  bool enVuelo() const { return en_vuelo_; }
  bool hayPendiente() const { return pendiente_; }
  uint8_t intentos() const { return intentos_; }

  /* true si el envio en vuelo excedio el plazo: el sketch debe llamar a
     respuesta(..., http = -99, ...) para registrar el fallo. */
  bool vencioEnVuelo(uint32_t ahora_ms) const {
    return en_vuelo_ && desde(ahora_ms, t_envio_) >= TIMEOUT_EN_VUELO_MS;
  }

  /* Registra el resultado del envio.
       http:       codigo HTTP, o <= 0 si no hubo respuesta (sin red, timeout).
       cuerpo_ok:  la respuesta 200 se pudo interpretar y traia "ok":true.
       retry_after_s: valor de la cabecera Retry-After (0 si no vino).
       intervalo_ms: intervalo de telemetria vigente. */
  Resultado respuesta(uint32_t ahora_ms, int http, bool cuerpo_ok, uint32_t retry_after_s, uint32_t intervalo_ms) {
    en_vuelo_ = false;

    if (http == 200 && cuerpo_ok) {
      pendiente_ = false;
      penalizado_ = false;
      fallos_seguidos_ = 0;
      rechazos_ = 0;
      t_ref_ = ahora_ms;
      espera_ms_ = intervalo_ms;
      return EXITO;
    }

    penalizado_ = true;
    t_ref_ = ahora_ms;

    if (http == 401) {
      pendiente_ = false;
      espera_ms_ = ESPERA_401_MS;
      return DESCARTAR;
    }
    if (http == 429) {
      pendiente_ = false;
      uint32_t ms = retry_after_s ? retry_after_s * 1000UL : ESPERA_429_DEF_MS;
      if (retry_after_s > ESPERA_429_MAX_MS / 1000UL) ms = ESPERA_429_MAX_MS;
      espera_ms_ = ms;
      return DESCARTAR;
    }
    if (http == 400 || http == 413) {
      pendiente_ = false;
      espera_ms_ = BACKOFF_BASE_MS;
      if (++rechazos_ >= RECHAZOS_PARA_LIMPIAR) { rechazos_ = 0; return DESCARTAR_Y_LIMPIAR; }
      return DESCARTAR;
    }

    /* Falla transitoria: sin red, timeout, 5xx, 200 con cuerpo ilegible... */
    if (intentos_ < INTENTOS_MAX) {
      espera_ms_ = (uint32_t)intentos_ * PASO_REINTENTO_MS;   // se reintenta la MISMA trama
      return REINTENTAR;
    }
    pendiente_ = false;                                       // 3 intentos fallidos: se abandona esta trama
    if (fallos_seguidos_ < 250) fallos_seguidos_++;           // (se cuenta por trama, no por intento)
    espera_ms_ = backoff(fallos_seguidos_, intervalo_ms);
    return DESCARTAR;
  }

 private:
  bool     en_vuelo_;
  bool     pendiente_;
  bool     penalizado_;
  bool     enviado_alguna_vez_;
  uint8_t  intentos_;
  uint8_t  fallos_seguidos_;
  uint8_t  rechazos_;
  uint32_t t_envio_;
  uint32_t t_ultimo_envio_;
  uint32_t t_ref_;        // instante desde el cual se cuenta espera_ms_
  uint32_t espera_ms_;    // "no antes de t_ref_ + espera_ms_"

  /* Milisegundos transcurridos desde t (resta sin signo, segura ante el desborde de millis()).
     Si "ahora" quedo ATRASADO respecto de t (por un millis() capturado antes de una espera),
     cuenta como 0: es el lado conservador. */
  static uint32_t desde(uint32_t ahora_ms, uint32_t t) {
    const uint32_t d = ahora_ms - t;
    return d >= 0x80000000UL ? 0 : d;
  }

  static uint32_t backoff(uint8_t fallos, uint32_t intervalo_ms) {
    uint32_t b = BACKOFF_BASE_MS;
    for (uint8_t i = 1; i < fallos && b < BACKOFF_MAX_MS; i++) b *= 2;   // 10, 20, 40, 80, 160, 300 s
    if (b > BACKOFF_MAX_MS) b = BACKOFF_MAX_MS;
    if (b > intervalo_ms) b = intervalo_ms;                              // nunca peor que el periodo normal
    if (b < BACKOFF_MIN_MS) b = BACKOFF_MIN_MS;
    return b;
  }
};

}  // namespace envio

/* #####################################################################
   SECCION 5 de 8:  protocolo.h  -  JSON de la trama y de la respuesta
   ##################################################################### */

/* =====================================================================
   protocolo.h  -  TRAMA DE TELEMETRIA Y RESPUESTA DEL SERVIDOR

   Construye el JSON que se envia (contrato, seccion 2) y analiza la
   respuesta (seccion 3). No usa WiFi ni pines: se prueba en el PC con
   firmware/test/test_protocolo.cpp (necesita la libreria ArduinoJson).

   - La trama se escribe con snprintf y no con ArduinoJson para controlar
     los decimales ("24.3" y no "24.299999237"). ArduinoJson (v7) se usa
     para LEER la respuesta, que es la parte que viene de fuera.
   - El servidor nunca recibe el identificador del nodo: lo deduce del
     token de la cabecera Authorization.
   ===================================================================== */

namespace protocolo {

static const int     VERSION_PROTOCOLO = 1;
static const size_t  TX_MAX      = 3072;   // tamano maximo del cuerpo enviado (el servidor acepta hasta 4 KB); el peor caso
                                               // absoluto (8 eventos + 8 acuses de largo maximo) mide ~2,2 KB
static const size_t  RX_MAX      = 1536;   // tamano maximo de la respuesta que se guarda
static const uint8_t MAX_ORDENES = 4;
static const uint8_t MAX_FALLAS  = 6;

/* Todo lo que viaja en una trama. */
struct DatosTrama {
  const char* fw;
  uint32_t boot, seq, up;
  bool     temp_ok;    float temp;
  bool     hum_ok;     float hum;
  bool     suelo_ok;   int   suelo_raw;
  bool     con_luz;    bool  luz_ok;     float luz;       // con_luz: la clave "luz" viaja (null si no responde)
  bool     con_viento; bool  viento_ok;  float viento;    // solo el nodo del mastil
  bool     bomba;
  uint32_t riego_s;
  const char* est;
  uint32_t esp;
  bool     con_rssi;   int   rssi;
  const char* fallas[MAX_FALLAS];  uint8_t n_fallas;
  riego::Evento   ev[riego::COLA_MAX];    uint32_t ev_ago_s[riego::COLA_MAX];  uint8_t n_ev;
  riego::AckOrden ack[riego::COLA_MAX];                                        uint8_t n_ack;
};

/* Escritor con limite: nunca escribe fuera del buffer y avisa si algo no cupo. */
class Escritor {
 public:
  Escritor(char* buf, size_t cap) : b_(buf), cap_(cap), n_(0), ovf_(false) { if (cap_) b_[0] = 0; }

  void fmt(const char* f, ...) {
    if (ovf_) return;
    va_list ap;
    va_start(ap, f);
    const int r = vsnprintf(b_ + n_, cap_ - n_, f, ap);
    va_end(ap);
    if (r < 0 || (size_t)r >= cap_ - n_) { ovf_ = true; b_[n_] = 0; return; }
    n_ += (size_t)r;
  }

  /* Cadena JSON entre comillas, con escapes (" \ y caracteres de control). */
  void str(const char* s) {
    put('"');
    if (s) {
      for (; *s; s++) {
        const unsigned char c = (unsigned char)*s;
        if (c == '"' || c == '\\') { put('\\'); put((char)c); }
        else if (c < 0x20)         { fmt("\\u%04x", (unsigned)c); }
        else                       { put((char)c); }
      }
    }
    put('"');
  }

  size_t n() const { return n_; }
  bool overflow() const { return ovf_; }

 private:
  char* b_; size_t cap_; size_t n_; bool ovf_;
  void put(char c) {
    if (ovf_) return;
    if (n_ + 1 >= cap_) { ovf_ = true; b_[n_] = 0; return; }
    b_[n_++] = c;
    b_[n_] = 0;
  }
};

/* Escribe el JSON de la trama. Devuelve los bytes escritos, o 0 si no cupo ni sin eventos/acuses.
   Si no cabe con todos los eventos/acuses, va quitando los ULTIMOS y ajusta d.n_ev / d.n_ack:
   el llamador debe confirmar solo los que realmente viajaron. */
inline size_t construirTrama(char* buf, size_t cap, DatosTrama& d) {
  for (;;) {
    Escritor w(buf, cap);
    w.fmt("{\"v\":%d,\"fw\":", VERSION_PROTOCOLO);
    w.str(d.fw);
    w.fmt(",\"boot\":%lu,\"seq\":%lu,\"up\":%lu", (unsigned long)d.boot, (unsigned long)d.seq, (unsigned long)d.up);

    if (d.temp_ok) w.fmt(",\"temp\":%.1f", (double)d.temp);       else w.fmt(",\"temp\":null");
    if (d.hum_ok)  w.fmt(",\"hum_aire\":%.1f", (double)d.hum);    else w.fmt(",\"hum_aire\":null");
    if (d.suelo_ok) w.fmt(",\"suelo_raw\":%d", d.suelo_raw);       else w.fmt(",\"suelo_raw\":null");
    if (d.con_luz)    { if (d.luz_ok)    w.fmt(",\"luz\":%.0f", (double)d.luz);       else w.fmt(",\"luz\":null"); }
    if (d.con_viento) { if (d.viento_ok) w.fmt(",\"viento\":%.1f", (double)d.viento); else w.fmt(",\"viento\":null"); }

    w.fmt(",\"bomba\":%d,\"riego_s\":%lu,\"est\":", d.bomba ? 1 : 0, (unsigned long)d.riego_s);
    w.str(d.est);
    w.fmt(",\"esp\":%lu", (unsigned long)d.esp);
    if (d.con_rssi) w.fmt(",\"rssi\":%d", d.rssi);

    w.fmt(",\"fallas\":[");
    for (uint8_t i = 0; i < d.n_fallas && i < MAX_FALLAS; i++) { if (i) w.fmt(","); w.str(d.fallas[i]); }
    w.fmt("]");

    if (d.n_ev) {
      w.fmt(",\"ev\":[");
      for (uint8_t i = 0; i < d.n_ev; i++) {
        const riego::Evento& e = d.ev[i];
        if (i) w.fmt(",");
        w.fmt("{\"t\":\"%s\",\"why\":", e.encendido ? "pump_on" : "pump_off");
        w.str(e.encendido ? riego::nombreOn(e.motivo) : riego::nombreOff(e.motivo));
        w.fmt(",\"ago\":%lu", (unsigned long)d.ev_ago_s[i]);
        if (!e.encendido) w.fmt(",\"dur\":%u", (unsigned)e.dur_s);
        if (e.cmd[0]) { w.fmt(",\"cmd\":"); w.str(e.cmd); }
        w.fmt("}");
      }
      w.fmt("]");
    }

    if (d.n_ack) {
      w.fmt(",\"acks\":[");
      for (uint8_t i = 0; i < d.n_ack; i++) {
        const riego::AckOrden& a = d.ack[i];
        if (i) w.fmt(",");
        w.fmt("{\"id\":");
        w.str(a.id);
        w.fmt(",\"estado\":\"%s\",\"detalle\":", a.ejecutada ? "ejecutada" : "rechazada");
        w.str(a.detalle);
        w.fmt("}");
      }
      w.fmt("]");
    }
    w.fmt("}");

    if (!w.overflow()) return w.n();
    if (d.n_ev > 0)       d.n_ev--;          // no cabe: se quitan primero eventos, luego acuses
    else if (d.n_ack > 0) d.n_ack--;
    else return 0;
  }
}

/* ---------------------------------------------------------------------
   RESPUESTA DEL SERVIDOR
   --------------------------------------------------------------------- */
struct Respuesta {
  bool ok;                 // "ok": true
  bool dup;                // "dup": true  (la trama ya se habia recibido)
  bool tiene_cfg;          // la respuesta trae "cfg"
  bool cfg_invalida;       // trae "cfg" pero viola las reglas: se ignora completa
  riego::Config cfg;       // configuracion resultante (la actual con los campos recibidos encima)
  uint8_t n_ordenes;
  uint8_t ordenes_ignoradas;   // por id invalido, exceso o formato incorrecto
  riego::Orden ordenes[MAX_ORDENES];
};

/* Identificador de orden: 1 a 39 caracteres de [A-Za-z0-9_-] (un UUID cumple). Asi nunca
   hace falta escapar nada al devolverlo en un acuse. */
inline bool idValido(const char* s) {
  if (!s) return false;
  const size_t n = strlen(s);
  if (n == 0 || n >= riego::ID_MAX) return false;
  for (size_t i = 0; i < n; i++) {
    const char c = s[i];
    const bool ok = (c >= '0' && c <= '9') || (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c == '-' || c == '_';
    if (!ok) return false;
  }
  return true;
}

inline bool leerEntero(JsonVariantConst v, long minimo, long maximo, long& salida) {
  if (!v.is<long>()) return false;
  const long x = v.as<long>();
  if (x < minimo || x > maximo) return false;
  salida = x;
  return true;
}

/* Campo entero de "cfg" que puede faltar. Presente pero fuera de 0..65535 => invalido. */
inline void campoU16(JsonVariantConst v, uint16_t& destino, bool& invalida) {
  if (v.isNull()) return;
  long x = 0;
  if (leerEntero(v, 0, 65535, x)) destino = (uint16_t)x;
  else invalida = true;
}

/* Analiza el cuerpo de una respuesta 200. Devuelve false si no es un JSON objeto valido.
   "actual" es la configuracion vigente: los campos que falten en "cfg" (p. ej. en el nodo del
   mastil, que solo recibe ver e intervalo_s) conservan su valor. */
inline bool parsearRespuesta(const char* json, size_t n, const riego::Config& actual, Respuesta& r) {
  memset(&r, 0, sizeof(r));
  r.cfg = actual;

  JsonDocument doc;
  if (deserializeJson(doc, json, n)) return false;
  if (!doc.is<JsonObject>()) return false;

  r.ok  = doc["ok"]  | false;
  r.dup = doc["dup"] | false;

  JsonObjectConst c = doc["cfg"].as<JsonObjectConst>();
  if (!c.isNull()) {
    r.tiene_cfg = true;
    riego::Config m = actual;
    bool inval = false;

    JsonVariantConst v = c["ver"];
    if (!v.isNull()) {
      if (v.is<uint32_t>()) m.ver = v.as<uint32_t>();
      else inval = true;
    }
    campoU16(c["intervalo_s"], m.intervalo_s, inval);
    campoU16(c["suelo_on"],    m.suelo_on,    inval);
    campoU16(c["suelo_off"],   m.suelo_off,   inval);
    campoU16(c["suelo_sat"],   m.suelo_sat,   inval);
    campoU16(c["riego_max_s"], m.riego_max_s, inval);
    campoU16(c["espera_s"],    m.espera_s,    inval);
    v = c["auto"];                                   // opcional: si falta (servidor antiguo) se conserva el valor actual
    if (!v.isNull()) {
      if (v.is<long>())      m.auto_riego = (v.as<long>() != 0);
      else if (v.is<bool>()) m.auto_riego = v.as<bool>();
      else inval = true;
    }
    v = c["temp_max"];
    if (!v.isNull()) {
      if (v.is<float>()) m.temp_max = v.as<float>();
      else inval = true;
    }

    if (!inval && !riego::configValida(m)) inval = true;
    r.cfg_invalida = inval;
    if (!inval) r.cfg = m;
  }

  JsonArrayConst arr = doc["ordenes"].as<JsonArrayConst>();
  for (JsonVariantConst item : arr) {
    JsonObjectConst o = item.as<JsonObjectConst>();
    if (o.isNull() || r.n_ordenes >= MAX_ORDENES) { r.ordenes_ignoradas++; continue; }
    const char* id   = o["id"].as<const char*>();
    const char* tipo = o["tipo"].as<const char*>();
    if (!idValido(id)) { r.ordenes_ignoradas++; continue; }

    riego::Orden& ord = r.ordenes[r.n_ordenes];
    memset(&ord, 0, sizeof(ord));
    strncpy(ord.id, id, riego::ID_MAX - 1);

    if (tipo && strcmp(tipo, "riego") == 0) {
      ord.tipo = riego::ORDEN_RIEGO;
      long dur = 0;
      ord.dur_s = leerEntero(o["dur_s"], 0, 65535, dur) ? (uint16_t)dur : 0;   // 0 => el controlador la rechaza
    } else if (tipo && strcmp(tipo, "parar") == 0) {
      ord.tipo = riego::ORDEN_PARAR;
    } else {
      ord.tipo = riego::ORDEN_DESCONOCIDA;                                     // se rechaza con un acuse
    }
    long vence = 0;
    ord.vence_s = leerEntero(o["vence_s"], 0, 4000000L, vence) ? (uint32_t)vence : 0;   // sin dato => vencida (lado seguro)
    r.n_ordenes++;
  }
  return true;
}

}  // namespace protocolo

/* #####################################################################
   SECCION 6 de 8:  sensores.h  -  DHT22, YL-38, BH1750, anemometro y rele (ESP8266)
   ##################################################################### */

/* =====================================================================
   sensores.h  -  LECTURA DE SENSORES Y CONTROL DEL RELE (ESP8266)

   DHT22 (temperatura y humedad del aire) | YL-38/YL-69 (humedad de suelo)
   BH1750 (luz, opcional)                 | anemometro (viento, opcional; solo mastil)
   Modulo de rele de la bomba.

   Ninguna funcion bloquea mas de ~550 ms (la medicion del suelo es la mas
   larga: 300 ms de estabilizacion + 1 lectura de descarte + 10 muestras
   separadas 20 ms). Todas las esperas usan delay(), que cede el control al
   WiFi y al perro guardian.
   ===================================================================== */

#define NIVEL_RELE_ON   (RELE_ACTIVO_EN_BAJO ? LOW : HIGH)
#define NIVEL_RELE_OFF  (RELE_ACTIVO_EN_BAJO ? HIGH : LOW)
#define NIVEL_LED_ON    (LED_ACTIVO_EN_BAJO ? LOW : HIGH)
#define NIVEL_LED_OFF   (LED_ACTIVO_EN_BAJO ? HIGH : LOW)

namespace sensores {

static DHT dht(PIN_DHT, TIPO_DHT);

/* ---------- Rele de la bomba ---------- */

/* Debe ser lo PRIMERO que se ejecuta en setup(): deja la bomba apagada. Se fija el nivel de
   apagado antes de configurar el pin como salida, para que no haya un pulso que active el rele. */
inline void releIniciarSeguro() {
#if !NODO_MASTIL
  digitalWrite(PIN_RELE, NIVEL_RELE_OFF);
  pinMode(PIN_RELE, OUTPUT);
  digitalWrite(PIN_RELE, NIVEL_RELE_OFF);
  digitalWrite(PIN_LED, NIVEL_LED_OFF);
  pinMode(PIN_LED, OUTPUT);
  digitalWrite(PIN_LED, NIVEL_LED_OFF);
#endif
}

/* Idempotente: se puede llamar en cada vuelta. */
inline void releAplicar(bool encendida) {
#if !NODO_MASTIL
  digitalWrite(PIN_RELE, encendida ? NIVEL_RELE_ON : NIVEL_RELE_OFF);
  digitalWrite(PIN_LED, encendida ? NIVEL_LED_ON : NIVEL_LED_OFF);
#else
  (void)encendida;
#endif
}

/* ---------- DHT22 ---------- */

/* Devuelve false si el sensor no responde (la libreria da NaN) o si el valor cae fuera del
   rango declarado por el fabricante (-40 a 80 C, 0 a 100 %HR). */
inline bool leerDHT(float& temperatura, float& humedad) {
  const float h = dht.readHumidity();
  const float t = dht.readTemperature();
  if (isnan(h) || isnan(t)) return false;
  if (t < -40.0f || t > 80.0f || h < 0.0f || h > 100.0f) return false;
  temperatura = t;
  humedad = h;
  return true;
}

/* ---------- Suelo: YL-38 / YL-69 ---------- */
struct Suelo {
  bool ok;         // false = lectura inestable (cable suelto o sensor ausente)
  int  raw10;      // 0..1023: escala de la tabla de la imagen (el ADC del ESP8266 ya es de 10 bits)
  int  dispersion; // max - min entre las muestras
};

/* El YL-69 es resistivo: si se mantiene energizado, la corriente continua entre sus electrodos
   lo corroe por electrolisis en pocas semanas. Por eso se alimenta desde un pin y solo se enciende
   durante la medicion (300 ms + descarte + 10 muestras).
   Se descarta la primera lectura: el ADC del ESP8266 suele dar un valor erroneo justo al
   energizar el modulo. */
inline Suelo medirSuelo() {
  Suelo s = {false, 0, 0};
#if !NODO_MASTIL
  digitalWrite(PIN_SUELO_VCC, HIGH);
  delay(SUELO_ESTABILIZACION_MS);
  (void)analogRead(PIN_SUELO);                 // lectura de descarte
  delay(SUELO_ENTRE_MUESTRAS_MS);
  long suma = 0;
  int minimo = 1023, maximo = 0;
  for (int i = 0; i < SUELO_MUESTRAS; i++) {
    int v = analogRead(PIN_SUELO);
    if (v > 1023) v = 1023;
    suma += v;
    if (v < minimo) minimo = v;
    if (v > maximo) maximo = v;
    delay(SUELO_ENTRE_MUESTRAS_MS);
  }
  digitalWrite(PIN_SUELO_VCC, LOW);
  s.raw10 = (int)(suma / SUELO_MUESTRAS);
  s.dispersion = maximo - minimo;
  s.ok = (s.dispersion <= SUELO_DISPERSION_MAX) && (s.raw10 >= SUELO_RAW_MIN_VALIDO);
#endif
  return s;
}

/* Porcentaje SOLO para mostrar por el Monitor Serie (el servidor calcula el suyo). */
inline int porcentajeLocal(int raw10) {
  const long rango = (long)SUELO_RAW_AIRE_LOCAL - (long)SUELO_RAW_AGUA_LOCAL;
  if (rango <= 0) return 0;
  long p = ((long)SUELO_RAW_AIRE_LOCAL - raw10) * 100L / rango;
  if (p < 0) p = 0;
  if (p > 100) p = 100;
  return (int)p;
}

/* ---------- Luz: BH1750 por I2C directo (sin libreria) ---------- */
#if USAR_BH1750
static bool luz_detectada = false;

inline bool luzEscribir(uint8_t comando) {
  Wire.beginTransmission(BH1750_DIRECCION);
  Wire.write(comando);
  return Wire.endTransmission() == 0;
}

/* Power ON (0x01) y medicion continua en alta resolucion (0x10, ~120 ms por medicion).
   Asi cada lectura entrega el dato mas reciente sin esperar. */
inline bool luzDetectar() {
  if (!luzEscribir(0x01)) return false;
  if (!luzEscribir(0x10)) return false;
  luz_detectada = true;
  return true;
}

/* false = el BH1750 no esta o no responde (no se considera una falla del nodo). */
inline bool leerLuz(float& lux) {
  if (!luz_detectada) {
    luzDetectar();                             // por si se conecto despues del arranque
    return false;                              // la primera medicion tarda ~120 ms: se lee en la proxima ronda
  }
  if (Wire.requestFrom((uint8_t)BH1750_DIRECCION, (uint8_t)2) != 2) { luz_detectada = false; return false; }
  const uint8_t alto = Wire.read();            // dos lecturas en sentencias separadas: el orden importa
  const uint8_t bajo = Wire.read();
  const uint16_t crudo = ((uint16_t)alto << 8) | bajo;
  lux = (float)crudo / 1.2f;                   // hoja de datos: lux = valor / 1,2
  return true;
}
#else
inline bool leerLuz(float&) { return false; }
#endif

/* ---------- Anemometro (solo nodo del mastil): senal 0-5 V = 0-45 m/s por A0 ---------- */
#if USAR_ANEMOMETRO
inline bool leerViento(float& ms) {
  long suma = 0;
  for (int i = 0; i < 10; i++) { suma += analogRead(PIN_ANEMOMETRO); delay(2); }
  const float crudo = (float)suma / 10.0f;                              // 0..1023
  const float v_pin = crudo / 1023.0f * ADC_A0_ESCALA_V;                // tension en el pin A0 de la placa
  const float divisor = (ANEMOMETRO_R_ARRIBA + ANEMOMETRO_R_ABAJO) / ANEMOMETRO_R_ABAJO;
  const float v_sensor = v_pin * divisor;                               // reconstruye los 0-5 V del sensor
  if (v_sensor < 0.0f || v_sensor > ANEMOMETRO_V_MAX * 1.1f) return false;
  float v = v_sensor / ANEMOMETRO_V_MAX * ANEMOMETRO_MS_MAX;
  if (v > ANEMOMETRO_MS_MAX) v = ANEMOMETRO_MS_MAX;
  ms = v;
  return true;
}
#else
inline bool leerViento(float&) { return false; }
#endif

/* ---------- Inicio ---------- */
inline void iniciar() {
#if !NODO_MASTIL
  pinMode(PIN_SUELO_VCC, OUTPUT);
  digitalWrite(PIN_SUELO_VCC, LOW);            // sonda sin energia mientras no se mide
#endif
  dht.begin();
#if USAR_BH1750
  Wire.begin(PIN_SDA, PIN_SCL);
  Wire.setClockStretchLimit(2000);             // un bus colgado no debe bloquear el bucle (microsegundos)
  if (luzDetectar()) delay(180);               // primera medicion del BH1750
#endif
}

}  // namespace sensores

/* #####################################################################
   SECCION 7 de 8:  red.h  -  WiFi y HTTP(S) (ESP8266, sin tareas: nunca con la bomba encendida)
   ##################################################################### */

/* =====================================================================
   red.h  -  WIFI Y CLIENTE HTTP(S) PARA ESP8266 (un solo nucleo, sin FreeRTOS)

   A diferencia del ESP32, el ESP8266 no tiene un segundo nucleo ni tareas:
   un POST HTTP bloquea el bucle mientras dura (0,3 a 8 s). Para que eso
   nunca afecte al riego, el sketch aplica UNA regla (ver gestionarEnvio):

       NUNCA se hace red con la bomba encendida.

   Asi el corte de la bomba por tiempo se evalua en cada vuelta (~10 ms) y
   ningun POST puede alargar un riego. Los eventos (bomba encendida/apagada)
   y los acuses quedan en cola y viajan apenas la bomba se apaga.

   La interfaz es la misma que en el ESP32 (redEnviar / redRecibir ...), pero
   redEnviar() hace el POST en el momento y deja la respuesta lista para
   redRecibir(). La conexion WiFi es asincrona y se mantiene con redMantener().
   ===================================================================== */

/* Credenciales: WIFI_SSID, WIFI_PASS, SERVER_URL, DEVICE_TOKEN (y CA_ROOT_PEM o TLS_INSEGURO si se
   usa HTTPS) salen del bloque CONFIGURACION DEL USUARIO, al inicio de este archivo. Con los valores
   de ejemplo el nodo funciona en modo local. */

#define URL_INGEST  SERVER_URL "/api/ingest"

struct MsgTx {
  uint32_t seq;                       // seq de la trama (para casar la respuesta)
  uint16_t n;
  char     cuerpo[protocolo::TX_MAX];
};

struct MsgRx {
  uint32_t seq;
  int      http;                      // codigo HTTP, o el error de HTTPClient (negativo: sin red, timeout...)
  uint16_t n;
  uint16_t retry_after_s;
  uint32_t recibido_ms;               // millis() al recibir la respuesta (para el vencimiento de ordenes)
  char     cuerpo[protocolo::RX_MAX];
};

/* Valores de la plantilla: el nodo NO intenta conectarse. */
inline bool credencialesDeEjemplo() {
  return strcmp(DEVICE_TOKEN, "PEGAR_AQUI_EL_TOKEN_DEL_NODO") == 0 || strcmp(WIFI_SSID, "NOMBRE_DE_LA_RED") == 0;
}

/* URL https:// sin certificado raiz (CA_ROOT_PEM) y sin TLS_INSEGURO: se prefiere NO enviar antes que
   enviar sin verificar al servidor. Se avisa una sola vez al arrancar (ver redIniciar). */
inline bool httpsSinCA() {
#if defined(TLS_INSEGURO) || defined(CA_ROOT_PEM)
  return false;
#else
  return strncmp(SERVER_URL, "https://", 8) == 0;
#endif
}

/* Recibe el cuerpo de la respuesta en un buffer fijo. Si el servidor envia mas de lo que cabe,
   deja de aceptar (HTTPClient aborta la lectura) en vez de agotar la memoria. */
class BufferAcotado : public Stream {
 public:
  BufferAcotado(char* buf, size_t cap) : b_(buf), cap_(cap), n_(0) { if (cap_) b_[0] = 0; }
  size_t write(uint8_t c) override {
    if (n_ + 1 >= cap_) return 0;
    b_[n_++] = (char)c;
    b_[n_] = 0;
    return 1;
  }
  size_t write(const uint8_t* datos, size_t largo) override {
    size_t k = 0;
    while (k < largo && write(datos[k])) k++;
    return k;
  }
  /* El nucleo ESP8266 3.x no copia datos a un Print que dice tener 0 bytes libres (por defecto 0). */
  int availableForWrite() { return (int)(cap_ - 1 - n_); }
  int available() override { return 0; }
  int read() override { return -1; }
  int peek() override { return -1; }
  size_t largo() const { return n_; }
 private:
  char* b_; size_t cap_; size_t n_;
};

/* Certificado raiz para verificar al servidor por HTTPS (solo si se definio CA_ROOT_PEM). */
#if defined(CA_ROOT_PEM) && !defined(TLS_INSEGURO)
static BearSSL::X509List ca_raiz(CA_ROOT_PEM);
#endif

namespace red {

static bool   activa = false;
static bool   hay_rx = false;          // hay una respuesta lista para redRecibir()
static MsgRx  rx;                      // estatico: es grande y no debe ir a la pila

static uint32_t t_intento_wifi = 0;
static uint32_t espera_wifi_ms = WIFI_REINTENTO_MS;
static bool     hubo_intento_wifi = false;
static bool     estaba_conectado = false;

/* Mantiene el WiFi SIN bloquear: WiFi.begin() conecta en segundo plano. Si no se logra, reintenta con
   espera creciente (20 s, 40 s, 80 s ... tope 5 min). Se llama en cada vuelta del bucle. */
inline void mantenerWiFi() {
  if (WiFi.status() == WL_CONNECTED) {
    if (!estaba_conectado) {
      estaba_conectado = true;
      Serial.printf("WiFi: conectado, IP %s, RSSI %d dBm\n", WiFi.localIP().toString().c_str(), (int)WiFi.RSSI());
    }
    espera_wifi_ms = WIFI_REINTENTO_MS;
    hubo_intento_wifi = false;
    return;
  }
  if (estaba_conectado) {
    estaba_conectado = false;
    Serial.println("WiFi: conexion perdida");
  }
  const uint32_t ahora = millis();
  if (hubo_intento_wifi && (uint32_t)(ahora - t_intento_wifi) < espera_wifi_ms) return;
  if (hubo_intento_wifi && espera_wifi_ms < 300000UL) {
    espera_wifi_ms *= 2;
    if (espera_wifi_ms > 300000UL) espera_wifi_ms = 300000UL;
  }
  hubo_intento_wifi = true;
  t_intento_wifi = ahora;
  Serial.printf("WiFi: conectando a \"%s\" ...\n", WIFI_SSID);
  WiFi.disconnect(false);
  WiFi.begin(WIFI_SSID, WIFI_PASS);
}

/* Hace el POST de una trama y deja el resultado en r. BLOQUEA hasta HTTP_TIMEOUT_MS (por eso nunca
   se llama con la bomba encendida). */
inline void enviarPost(const MsgTx& t, MsgRx& r) {
  r.seq = t.seq;
  r.http = -1;
  r.n = 0;
  r.retry_after_s = 0;
  r.recibido_ms = millis();
  r.cuerpo[0] = 0;
  if (WiFi.status() != WL_CONNECTED) return;

  const bool https = strncmp(SERVER_URL, "https://", 8) == 0;
  WiFiClient*                plano  = nullptr;
  BearSSL::WiFiClientSecure* seguro = nullptr;
  HTTPClient http;
  bool ok = false;

  if (https) {
#if defined(TLS_INSEGURO) || defined(CA_ROOT_PEM)
    if (ESP.getFreeHeap() < 20000) { r.http = -3; return; }          // sin memoria para TLS: se reintenta despues
    seguro = new BearSSL::WiFiClientSecure();
    seguro->setBufferSizes(TLS_BUFFER_RX, TLS_BUFFER_TX);
  #if defined(TLS_INSEGURO)
    seguro->setInsecure();                                            // SOLO DESARROLLO: no verifica al servidor
  #else
    const time_t ahora_utc = time(nullptr);
    if (ahora_utc < 1700000000) { delete seguro; r.http = -2; return; }   // aun sin hora NTP: no se puede validar
    seguro->setX509Time(ahora_utc);
    seguro->setTrustAnchors(&ca_raiz);                                // verifica la cadena contra CA_ROOT_PEM
  #endif
    ok = http.begin(*seguro, URL_INGEST);
#else
    return;                                                           // no se llega aqui: redIniciar() no arranca la red sin CA
#endif
  } else {
    plano = new WiFiClient();
    ok = http.begin(*plano, URL_INGEST);
  }

  if (ok) {
    http.setTimeout(HTTP_TIMEOUT_MS);    // conexion y lectura. El servidor puede tardar ~1,2 s por trama y hasta
                                         // ~5 s tras un periodo inactivo (conexion "fria" a la base).
    http.setReuse(false);
    http.setUserAgent("nodo-invernadero/" FW_VERSION);
    http.addHeader("Content-Type", "application/json");
    http.addHeader("Authorization", "Bearer " DEVICE_TOKEN);
    const char* claves[] = {"Retry-After"};
    http.collectHeaders(claves, 1);

    const int codigo = http.POST((const uint8_t*)t.cuerpo, t.n);
    r.http = codigo;
    r.recibido_ms = millis();
    if (codigo > 0) {
      const int tam = http.getSize();            // Content-Length, o -1 si el servidor responde por trozos
      if (tam >= 0 && tam < (int)sizeof(r.cuerpo)) {
        const String cuerpo = http.getString();  // tamano conocido y acotado: la via estandar
        size_t n = cuerpo.length();
        if (n >= sizeof(r.cuerpo)) n = sizeof(r.cuerpo) - 1;
        memcpy(r.cuerpo, cuerpo.c_str(), n);
        r.cuerpo[n] = 0;
        r.n = (uint16_t)n;
      } else {
        BufferAcotado salida(r.cuerpo, sizeof(r.cuerpo));
        http.writeToStream(&salida);             // acotado; si excede, r.n queda en lo leido
        r.n = (uint16_t)salida.largo();
      }
      const String ra = http.header("Retry-After");
      if (ra.length()) r.retry_after_s = (uint16_t)constrain(ra.toInt(), 0, 3600);
    }
    http.end();
  }
  delete plano;
  delete seguro;
}

}  // namespace red

/* ---------- Interfaz para el bucle de control ---------- */

inline bool redActiva() { return red::activa; }

inline void redIniciar() {
  if (credencialesDeEjemplo()) {
    Serial.println("RED: la CONFIGURACION DEL USUARIO tiene valores de ejemplo -> sin conexion. El riego local sigue funcionando.");
    return;
  }
  if (httpsSinCA()) {
    Serial.println("RED: SERVER_URL es https:// pero la CONFIGURACION DEL USUARIO no define CA_ROOT_PEM (ni TLS_INSEGURO para desarrollo).");
    Serial.println("     No se enviara nada para no exponer el token. El riego local sigue funcionando.");
    return;
  }
  WiFi.persistent(false);              // no escribe las credenciales en la flash en cada arranque
  WiFi.mode(WIFI_STA);
  WiFi.setAutoReconnect(true);
  WiFi.setSleepMode(WIFI_NONE_SLEEP);  // el nodo va con alimentacion de red: prioriza estabilidad sobre consumo
#if defined(CA_ROOT_PEM) && !defined(TLS_INSEGURO)
  configTime(0, 0, "pool.ntp.org", "time.google.com");   // la validacion de certificados necesita la hora
#endif
  red::activa = true;
  red::mantenerWiFi();                 // primer intento de conexion, sin esperar
}

/* Mantiene el WiFi. Barato: se llama en cada vuelta. */
inline void redMantener() {
  if (red::activa) red::mantenerWiFi();
}

inline bool redConectada() { return red::activa && WiFi.status() == WL_CONNECTED; }
inline int  redRssi()      { return WiFi.status() == WL_CONNECTED ? (int)WiFi.RSSI() : 0; }

/* Hace el POST de la trama AHORA (bloquea hasta HTTP_TIMEOUT_MS) y deja la respuesta para redRecibir().
   false si la red no esta activa o aun hay una respuesta sin recoger. */
inline bool redEnviar(const MsgTx& m) {
  if (!red::activa || red::hay_rx) return false;
  red::enviarPost(m, red::rx);
  red::hay_rx = true;
  return true;
}

/* Recoge la respuesta del ultimo POST, si la hay. */
inline bool redRecibir(MsgRx& m) {
  if (!red::activa || !red::hay_rx) return false;
  memcpy(&m, &red::rx, sizeof(MsgRx));
  red::hay_rx = false;
  return true;
}

/* #####################################################################
   SECCION 8 de 8:  nodo_invernadero_esp8266.ino  -  setup() y loop(): une todo
   ##################################################################### */

/* ---------------------------------------------------------------------
   ESTADO GLOBAL
   --------------------------------------------------------------------- */
static riego::Controlador ctl;
static envio::Plan        plan;

/* Memoria RTC de usuario: sobrevive a reinicios por software, watchdog o excepcion (no a un corte de
   energia). Sirve para saber si el nodo se reinicio CON LA BOMBA ENCENDIDA. */
struct EstadoRtc {
  uint32_t magia;
  uint32_t bomba_activa;
};
static const uint32_t RTC_MAGIA  = 0xB0B4C0DEUL;
static const uint32_t RTC_BLOQUE = 0;                 // primer bloque (4 bytes) de la memoria RTC de usuario

static void rtcGuardarBomba(bool encendida) {
  EstadoRtc s = { RTC_MAGIA, encendida ? 1UL : 0UL };
  ESP.rtcUserMemoryWrite(RTC_BLOQUE, reinterpret_cast<uint32_t*>(&s), sizeof(s));
}

static bool rtcBombaEstabaActiva() {
  EstadoRtc s = { 0, 0 };
  if (!ESP.rtcUserMemoryRead(RTC_BLOQUE, reinterpret_cast<uint32_t*>(&s), sizeof(s))) return false;
  return s.magia == RTC_MAGIA && s.bomba_activa == 1;
}

/* Ultimos valores medidos (los que viajan en la trama). */
struct Ultima {
  bool  hay;
  bool  temp_ok;   float temp;
  bool  hum_ok;    float hum;
  bool  suelo_ok;  int   suelo_raw;
  bool  luz_ok;    float luz;
  bool  viento_ok; float viento;
};
static Ultima ultima = {false, false, 0, false, 0, false, 0, false, 0, false, 0};

/* Ronda de medicion en curso. El DHT22 puede pedir reintentos separados 2,1 s: se hacen sin
   bloquear el bucle. */
struct Ronda {
  bool     activa;
  bool     con_dht;
  uint8_t  intentos_dht;
  uint32_t t_dht;
  bool     suelo_ok;  int suelo_raw;  int dispersion;
  bool     temp_ok;   float temp;
  bool     hum_ok;    float hum;
  bool     luz_ok;    float luz;
  bool     viento_ok; float viento;
};
static Ronda    ronda = {};
static bool     primera_muestra = false;
static uint32_t t_ultima_muestra = 0;

/* Envio de tramas. */
static uint32_t             boot_id = 0;
static uint32_t             seq_trama = 0;
static protocolo::DatosTrama datos;                 // estatico: es grande
static MsgTx                msg_pend;               // trama construida (se reenvia igual si falla)
static uint32_t             ev_hasta_pend = 0, ack_hasta_pend = 0;   // hasta que seq viajo en msg_pend
static uint32_t             ev_incluido_max = 0, ack_incluido_max = 0;
static uint8_t              tramas_aviso_wdt = 0;

/* Tabla de estado por el Monitor Serie. */
static uint32_t t_tabla = 0;              // cuando se imprimio la ultima fila
static uint8_t  filas_tabla = 0;          // 0 = la proxima fila lleva el encabezado antes
static uint32_t red_ultima_ok = 0;        // seq de la ultima trama aceptada por el servidor (0 = ninguna)
static bool     red_fallando = false;     // el ultimo envio fallo
static bool     aviso_dht = false;        // el aviso de falla del DHT22 ya se imprimio (se repite solo si se recupera y vuelve a fallar)
static bool     aviso_suelo = false;

static bool     rele_estado_previo = false;
static uint32_t t_reafirma_rele = 0;

/* Milisegundos desde t (seguro ante el desborde de millis(); si "ahora" quedo atrasado cuenta 0). */
static inline uint32_t desde(uint32_t ahora, uint32_t t) {
  const uint32_t d = ahora - t;
  return d >= 0x80000000UL ? 0 : d;
}

/* ---------------------------------------------------------------------
   BOMBA (rele + LED + memoria RTC)
   --------------------------------------------------------------------- */
static void aplicarBomba() {
  const bool on = ctl.bombaEncendida();
  const uint32_t ahora = millis();
  /* Se reescribe el pin cada segundo aunque no haya cambios: cuesta nada y corrige un glitch. */
  if (on != rele_estado_previo || desde(ahora, t_reafirma_rele) >= 1000) {
    sensores::releAplicar(on);
    t_reafirma_rele = ahora;
  }
  if (on != rele_estado_previo) {
    rele_estado_previo = on;
    filas_tabla = 0;
    rtcGuardarBomba(on);
    const uint8_t n = ctl.eventosPendientes();
    if (n) {
      const riego::Evento& e = ctl.evento(n - 1);
      if (e.encendido) Serial.printf(">> BOMBA ENCENDIDA (%s)\n", riego::nombreOn(e.motivo));
      else             Serial.printf(">> BOMBA APAGADA (%s, %u s)\n", riego::nombreOff(e.motivo), (unsigned)e.dur_s);
    } else {
      Serial.println(on ? ">> BOMBA ENCENDIDA" : ">> BOMBA APAGADA");
    }
  }
}

/* ---------------------------------------------------------------------
   CONFIGURACION EN MEMORIA NO VOLATIL (flash, emulando EEPROM): sobrevive a reinicios
   Se escribe SOLO cuando el servidor cambia la configuracion (rara vez): la flash tiene
   un numero limitado de escrituras.
   --------------------------------------------------------------------- */
struct CfgFlash {
  uint32_t magia;
  uint32_t ver;
  uint16_t intervalo_s;
  uint16_t suelo_on;
  uint16_t suelo_off;
  uint16_t suelo_sat;
  uint16_t riego_max_s;
  uint16_t espera_s;
  float    temp_max;
  uint8_t  auto_riego;
  uint32_t suma;          // control de integridad (FNV-1a de todo lo anterior)
};
static const uint32_t CFG_MAGIA = 0xC0F16A03UL;   // cambia al agregar campos: una config guardada con otro formato se descarta

/* FNV-1a. OJO: las funciones de este archivo NO deben recibir tipos definidos en este mismo archivo
   (por eso aqui va un puntero a bytes y no un CfgFlash): el IDE de Arduino les genera un prototipo
   automatico al principio del archivo, antes de que esos tipos existan. */
static uint32_t sumaBytes(const uint8_t* p, size_t n) {
  uint32_t h = 2166136261UL;
  for (size_t i = 0; i < n; i++) { h ^= p[i]; h *= 16777619UL; }
  return h;
}

static void guardarConfig(const riego::Config& c) {
  CfgFlash f;
  memset(&f, 0, sizeof(f));
  f.magia = CFG_MAGIA;
  f.ver = c.ver;
  f.intervalo_s = c.intervalo_s;
  f.suelo_on = c.suelo_on;
  f.suelo_off = c.suelo_off;
  f.suelo_sat = c.suelo_sat;
  f.riego_max_s = c.riego_max_s;
  f.espera_s = c.espera_s;
  f.temp_max = c.temp_max;
  f.auto_riego = c.auto_riego ? 1 : 0;
  f.suma = sumaBytes(reinterpret_cast<const uint8_t*>(&f), offsetof(CfgFlash, suma));
  EEPROM.put(0, f);
  if (!EEPROM.commit()) Serial.println("CFG: no se pudo guardar en la memoria flash");
}

static void cargarConfig() {
  CfgFlash f;
  EEPROM.get(0, f);
  if (f.magia == CFG_MAGIA && f.suma == sumaBytes(reinterpret_cast<const uint8_t*>(&f), offsetof(CfgFlash, suma))) {
    riego::Config c = riego::configPorDefecto();
    c.ver         = f.ver;
    c.intervalo_s = f.intervalo_s;
    c.suelo_on    = f.suelo_on;
    c.suelo_off   = f.suelo_off;
    c.suelo_sat   = f.suelo_sat;
    c.temp_max    = f.temp_max;
    c.riego_max_s = f.riego_max_s;
    c.espera_s    = f.espera_s;
    c.auto_riego  = (f.auto_riego != 0);
    if (ctl.aplicarConfig(c)) Serial.printf("CFG: cargada de la memoria (ver %lu)\n", (unsigned long)c.ver);
    else Serial.println("CFG: la guardada es invalida; se usan los valores por defecto");
  } else {
    Serial.println("CFG: sin configuracion guardada; valores por defecto del contrato");
  }
}

static void imprimirConfig(const char* prefijo) {
  const riego::Config& c = ctl.config();
  Serial.printf("%s ver=%lu intervalo=%us suelo on/off/sat=%u/%u/%u temp_max=%.1fC riego_max=%us espera=%us riego_auto=%s\n",
                prefijo, (unsigned long)c.ver, (unsigned)c.intervalo_s, (unsigned)c.suelo_on, (unsigned)c.suelo_off,
                (unsigned)c.suelo_sat, (double)c.temp_max, (unsigned)c.riego_max_s, (unsigned)c.espera_s,
                c.auto_riego ? "ACTIVADO" : "DESACTIVADO");
}

/* ---------------------------------------------------------------------
   RONDA DE MEDICION (no bloquea mas de ~550 ms)
   --------------------------------------------------------------------- */
static void imprimirEstado() {
  Serial.println("---------------------------------------------");
  Serial.printf("[%lu s] ", (unsigned long)ctl.uptimeS());
  if (ultima.temp_ok) Serial.printf("Temp %.1f C | ", (double)ultima.temp); else Serial.print("Temp sin lectura | ");
  if (ultima.hum_ok)  Serial.printf("Humedad aire %.1f %%\n", (double)ultima.hum); else Serial.println("Humedad aire sin lectura");
#if !NODO_MASTIL
  if (ultima.suelo_ok) {
    Serial.printf("Suelo: %d (0-1023) -> %s, %d %% | ", ultima.suelo_raw,
                  riego::nombreBanda(ctl.banda(ultima.suelo_raw)), sensores::porcentajeLocal(ultima.suelo_raw));
  } else {
    Serial.print("Suelo: SIN LECTURA VALIDA | ");
  }
  Serial.printf("Bomba: %s | Estado: %s", ctl.bombaEncendida() ? "ENCENDIDA" : "apagada", riego::nombreEst(ctl.estado()));
  if (ctl.esperaRestanteS()) Serial.printf(" (espera %lu s)", (unsigned long)ctl.esperaRestanteS());
  Serial.println();
#endif
#if USAR_BH1750
  if (ultima.luz_ok) Serial.printf("Luz: %.0f lx\n", (double)ultima.luz);
#endif
#if USAR_ANEMOMETRO
  if (ultima.viento_ok) Serial.printf("Viento: %.1f m/s\n", (double)ultima.viento);
#endif
}

/* ---------------------------------------------------------------------
   TABLA DE ESTADO (una fila cada TABLA_SERIAL_S segundos; el encabezado se repite cada 15 filas
   y despues de cualquier evento: bomba, orden o cambio de configuracion)
   --------------------------------------------------------------------- */
static void imprimirEncabezadoTabla() {
  Serial.println();
  Serial.println("  Tiempo  | Temp C | Aire % | Suelo | Banda    | Bomba  | Estado      | Espera | Auto | WiFi dBm | Red     | Fallas");
  Serial.println("----------+--------+--------+-------+----------+--------+-------------+--------+------+----------+---------+-----------");
}

static void imprimirFilaTabla() {
  if (filas_tabla == 0) imprimirEncabezadoTabla();
  filas_tabla = (uint8_t)((filas_tabla + 1) % 15);

  char temp[10] = "--", aire[10] = "--", suelo[10] = "--", bomba[20] = "off", wifi[12] = "sin red", red_txt[20] = "-", fallas[32] = "";
  const char* banda = "-";
  if (ultima.temp_ok) snprintf(temp, sizeof(temp), "%.1f", (double)ultima.temp);
  if (ultima.hum_ok)  snprintf(aire, sizeof(aire), "%.1f", (double)ultima.hum);
#if !NODO_MASTIL
  if (ultima.suelo_ok) {
    snprintf(suelo, sizeof(suelo), "%d", ultima.suelo_raw);
    banda = riego::nombreBanda(ctl.banda(ultima.suelo_raw));
  }
#else
  snprintf(suelo, sizeof(suelo), "n/a");
#endif
  if (ctl.bombaEncendida()) snprintf(bomba, sizeof(bomba), "ON %lus", (unsigned long)ctl.riegoS());
  if (!redActiva())          snprintf(wifi, sizeof(wifi), "local");
  else if (redConectada())   snprintf(wifi, sizeof(wifi), "%d", redRssi());
  if (redActiva()) {
    if (red_fallando)         snprintf(red_txt, sizeof(red_txt), "FALLO");
    else if (red_ultima_ok)   snprintf(red_txt, sizeof(red_txt), "ok #%lu", (unsigned long)red_ultima_ok);
  }
  if (!ultima.hay) {
    snprintf(fallas, sizeof(fallas), "midiendo...");
  } else {
    if (!ultima.temp_ok) strncat(fallas, "dht", sizeof(fallas) - strlen(fallas) - 1);
#if !NODO_MASTIL
    if (!ultima.suelo_ok) strncat(fallas, fallas[0] ? ",suelo" : "suelo", sizeof(fallas) - strlen(fallas) - 1);
#endif
    if (!fallas[0]) snprintf(fallas, sizeof(fallas), "ninguna");
  }
  const unsigned long up = (unsigned long)ctl.uptimeS();
  Serial.printf(" %02lu:%02lu:%02lu | %6s | %6s | %5s | %-8s | %-6s | %-11s | %6lu | %-4s | %8s | %-7s | %s\n",
                up / 3600UL, (up / 60UL) % 60UL, up % 60UL, temp, aire, suelo, banda, bomba,
                riego::nombreEst(ctl.estado()), (unsigned long)ctl.esperaRestanteS(),
                ctl.config().auto_riego ? "SI" : "NO", wifi, red_txt, fallas);
}

static void finalizarRonda() {
  riego::Lectura l;
  l.suelo_ok  = ronda.suelo_ok;
  l.suelo_raw = ronda.suelo_raw;
  if (ronda.con_dht) {
    ultima.temp_ok = ronda.temp_ok;  ultima.temp = ronda.temp;
    ultima.hum_ok  = ronda.hum_ok;   ultima.hum  = ronda.hum;
  }                                                   // sin lectura de DHT (bomba encendida): se conserva el ultimo valor
  l.temp_ok = ultima.temp_ok;
  l.temp    = ultima.temp;
  ultima.suelo_ok = ronda.suelo_ok;  ultima.suelo_raw = ronda.suelo_raw;
  ultima.luz_ok = ronda.luz_ok;      ultima.luz = ronda.luz;
  ultima.viento_ok = ronda.viento_ok; ultima.viento = ronda.viento;
  ultima.hay = true;

  ctl.nuevaLectura(l, millis());                      // aqui se decide iniciar o cortar el riego
  aplicarBomba();
  ronda.activa = false;
  primera_muestra = true;
  t_ultima_muestra = millis();
#if TABLA_SERIAL_S == 0
  imprimirEstado();                                   // sin tabla: el bloque largo de siempre, una vez por medicion
#endif
}

static void intentarDHT() {
  ronda.intentos_dht++;
  float t = 0, h = 0;
  if (sensores::leerDHT(t, h)) {
    if (aviso_dht) { aviso_dht = false; Serial.println("OK: DHT22 recuperado"); }
    ronda.temp_ok = ronda.hum_ok = true;
    ronda.temp = t;
    ronda.hum = h;
    finalizarRonda();
    return;
  }
  if (ronda.intentos_dht >= REINTENTOS_DHT) {
    if (!aviso_dht) {
      aviso_dht = true;
      /* Diagnostico: nivel de la linea DATA en reposo, SIN la resistencia interna (con ella un cable suelto tambien daria ALTO). */
      pinMode(PIN_DHT, INPUT);
      delay(2);
      const bool alto = digitalRead(PIN_DHT) == HIGH;
      pinMode(PIN_DHT, INPUT_PULLUP);
      Serial.println("AVISO: sin lectura valida del DHT22 (se avisa una sola vez)");
      Serial.println(alto ? "       DATA en reposo = ALTO: el modulo esta alimentado y el cable de datos llega; revise que + y - esten bien y pruebe otro sensor"
                          : "       DATA en reposo = BAJO: el modulo no esta alimentado o el cable de DATA no llega a D5 (revise +, - y el cable de DATA)");
    }
    ronda.temp_ok = ronda.hum_ok = false;
    finalizarRonda();
    return;
  }
  ronda.t_dht = millis();                             // proximo intento cuando pasen REINTENTO_DHT_MS
}

static void iniciarRonda() {
  memset(&ronda, 0, sizeof(ronda));
  ronda.activa = true;
#if !NODO_MASTIL
  const sensores::Suelo s = sensores::medirSuelo();
  ronda.suelo_ok = s.ok;  ronda.suelo_raw = s.raw10;  ronda.dispersion = s.dispersion;
  if (!s.ok && !aviso_suelo) {
    aviso_suelo = true;                               // se avisa una sola vez; la tabla sigue mostrando la falla
    if (s.raw10 < SUELO_RAW_MIN_VALIDO) Serial.printf("AVISO: suelo sin sensor (lectura %d, minimo %d): revise AO->A0, VCC->D7 y GND del YL-38\n", s.raw10, SUELO_RAW_MIN_VALIDO);
    else Serial.printf("AVISO: lectura de suelo inestable (dispersion %d): revise el cableado del YL-38\n", s.dispersion);
  } else if (s.ok && aviso_suelo) {
    aviso_suelo = false;
    Serial.println("OK: sensor de suelo recuperado");
  }
#endif
#if USAR_BH1750
  ronda.luz_ok = sensores::leerLuz(ronda.luz);
#endif
#if USAR_ANEMOMETRO
  ronda.viento_ok = sensores::leerViento(ronda.viento);
#endif
  if (ctl.bombaEncendida()) {                         // mientras riega no se lee el DHT22
    ronda.con_dht = false;
    finalizarRonda();
    return;
  }
  ronda.con_dht = true;
  ronda.intentos_dht = 0;
  intentarDHT();
}

static void avanzarRonda() {
  if (ronda.activa && ronda.con_dht && desde(millis(), ronda.t_dht) >= REINTENTO_DHT_MS) intentarDHT();
}

/* ---------------------------------------------------------------------
   TRAMAS: armar, enviar, procesar la respuesta
   --------------------------------------------------------------------- */
static bool hayNovedades() {
  return ctl.ultimoEventoSeq() > ev_incluido_max || ctl.ultimoAckSeq() > ack_incluido_max;
}

static void armarTrama() {
  ctl.tick(millis());                                 // el reloj interno debe estar al dia para calcular "ago"
  aplicarBomba();                                     // (si ese tick corto el riego, el rele lo sigue de inmediato)
  protocolo::DatosTrama& d = datos;
  memset(&d, 0, sizeof(d));

  d.fw = FW_VERSION;
  d.boot = boot_id;
  d.seq = ++seq_trama;
  d.up = ctl.uptimeS();
  d.temp_ok = ultima.temp_ok;  d.temp = ultima.temp;
  d.hum_ok  = ultima.hum_ok;   d.hum  = ultima.hum;
  d.suelo_ok = ultima.suelo_ok; d.suelo_raw = ultima.suelo_raw;
  d.con_luz = (USAR_BH1750 != 0);  d.luz_ok = ultima.luz_ok;  d.luz = ultima.luz;
  d.con_viento = (USAR_ANEMOMETRO != 0);  d.viento_ok = ultima.viento_ok;  d.viento = ultima.viento;
  d.bomba = ctl.bombaEncendida();
  d.riego_s = ctl.riegoS();
#if NODO_MASTIL
  d.est = "idle";
#else
  d.est = riego::nombreEst(ctl.estado());
#endif
  d.esp = ctl.esperaRestanteS();
  d.con_rssi = true;
  d.rssi = redRssi();

#if !NODO_MASTIL
  if (!ultima.suelo_ok) d.fallas[d.n_fallas++] = "suelo";
#endif
  if (!ultima.temp_ok) d.fallas[d.n_fallas++] = "dht";
#if USAR_ANEMOMETRO
  if (!ultima.viento_ok && d.n_fallas < protocolo::MAX_FALLAS) d.fallas[d.n_fallas++] = "viento";
#endif
  if (tramas_aviso_wdt > 0 && d.n_fallas < protocolo::MAX_FALLAS) { d.fallas[d.n_fallas++] = "reinicio_wdt"; tramas_aviso_wdt--; }

  d.n_ev = ctl.eventosPendientes();
  for (uint8_t i = 0; i < d.n_ev; i++) { d.ev[i] = ctl.evento(i); d.ev_ago_s[i] = ctl.agoEventoS(i); }
  d.n_ack = ctl.acksPendientes();
  for (uint8_t i = 0; i < d.n_ack; i++) d.ack[i] = ctl.ack(i);

  const size_t n = protocolo::construirTrama(msg_pend.cuerpo, sizeof(msg_pend.cuerpo), d);
  msg_pend.n = (uint16_t)n;
  msg_pend.seq = d.seq;
  ev_hasta_pend  = d.n_ev  ? d.ev[d.n_ev - 1].seq : 0;
  ack_hasta_pend = d.n_ack ? d.ack[d.n_ack - 1].seq : 0;
  if (ev_hasta_pend  > ev_incluido_max)  ev_incluido_max  = ev_hasta_pend;
  if (ack_hasta_pend > ack_incluido_max) ack_incluido_max = ack_hasta_pend;
}

static void aplicarCfgRecibida(const protocolo::Respuesta& resp) {
  if (!resp.tiene_cfg) return;
  if (resp.cfg_invalida) { Serial.println("CFG: la del servidor es INVALIDA; se ignora completa"); return; }
  if (riego::configIgual(resp.cfg, ctl.config())) return;
  if (ctl.aplicarConfig(resp.cfg)) {
    guardarConfig(resp.cfg);
    imprimirConfig("CFG: aplicada y guardada");
    filas_tabla = 0;
  }
}

static void atenderOrdenes(protocolo::Respuesta& resp, uint32_t recibida_ms) {
  if (resp.ordenes_ignoradas) Serial.printf("ORDEN: %u ignorada(s) por formato invalido\n", (unsigned)resp.ordenes_ignoradas);
  if (resp.n_ordenes) filas_tabla = 0;
  for (uint8_t i = 0; i < resp.n_ordenes; i++) {
    riego::Orden& o = resp.ordenes[i];
    o.recibida_ms = recibida_ms;
    const riego::ResultadoOrden r = ctl.atenderOrden(o, millis());
    if (r.ignorada) Serial.printf("ORDEN %s: repetida, se ignora\n", o.id);
    else Serial.printf("ORDEN %s -> %s (%s)\n", o.id, r.ejecutada ? "ejecutada" : "rechazada", r.detalle);
    aplicarBomba();
  }
}

static void procesarRespuesta(const MsgRx& rx) {
  if (!plan.enVuelo() || rx.seq != msg_pend.seq) return;       // respuesta tardia o de otra trama
  const uint32_t intervalo_ms = (uint32_t)ctl.config().intervalo_s * 1000UL;

  static protocolo::Respuesta resp;                             // estatico: evita ocupar la pila
  bool cuerpo_ok = false;
  if (rx.http == 200 && rx.n > 0) cuerpo_ok = protocolo::parsearRespuesta(rx.cuerpo, rx.n, ctl.config(), resp) && resp.ok;
  if (rx.http == 200 && !cuerpo_ok) Serial.printf("RED: respuesta 200 ilegible (%u bytes): %.160s\n", (unsigned)rx.n, rx.cuerpo);   // diagnostico

  const envio::Resultado r = plan.respuesta(millis(), rx.http, cuerpo_ok, rx.retry_after_s, intervalo_ms);
  switch (r) {
    case envio::EXITO:
      ctl.descartarEventosHasta(ev_hasta_pend);
      ctl.descartarAcksHasta(ack_hasta_pend);
      red_ultima_ok = msg_pend.seq;                   // se muestra en la columna «Red» de la tabla
      red_fallando = false;
      aplicarCfgRecibida(resp);
      atenderOrdenes(resp, rx.recibido_ms);
      break;
    case envio::REINTENTAR:
      red_fallando = true;
      Serial.printf("RED: trama %lu fallo (HTTP %d), se reintenta igual (intento %u de %u)\n",
                    (unsigned long)msg_pend.seq, rx.http, (unsigned)plan.intentos(), (unsigned)envio::INTENTOS_MAX);
      break;
    case envio::DESCARTAR:
      red_fallando = true;
      Serial.printf("RED: trama %lu descartada (HTTP %d%s)\n", (unsigned long)msg_pend.seq, rx.http,
                    rx.http == 401 ? ": token rechazado, revise DEVICE_TOKEN" : "");
      break;
    case envio::DESCARTAR_Y_LIMPIAR:
      red_fallando = true;
      ctl.vaciarColas();
      Serial.printf("RED: el servidor rechaza la trama (HTTP %d) tres veces seguidas; se vacian las colas\n", rx.http);
      break;
  }
}

static void gestionarEnvio() {
  if (!redActiva()) return;
  const uint32_t intervalo_ms = (uint32_t)ctl.config().intervalo_s * 1000UL;

  static MsgRx rx;                                              // estatico: no ocupa la pila de loop()
  while (redRecibir(rx)) procesarRespuesta(rx);

  uint32_t ahora = millis();
  if (plan.vencioEnVuelo(ahora)) {
    Serial.println("RED: sin respuesta (30 s)");
    plan.respuesta(ahora, -99, false, 0, intervalo_ms);
  }

  /* SIN RED CON LA BOMBA ENCENDIDA. Un POST bloquea el bucle hasta HTTP_TIMEOUT_MS y el corte de la
     bomba por tiempo debe evaluarse en cada vuelta. Los eventos y acuses quedan en cola (hasta 8) y
     viajan apenas la bomba se apaga (un riego dura como maximo 30 s). */
  if (ctl.bombaEncendida()) return;

  const bool listo = ultima.hay && redConectada();
  const bool novedades = hayNovedades();
  const envio::Accion a = plan.decidir(ahora, listo, novedades);

  if (a == envio::ENVIAR_NUEVA) {
    /* Trama PERIODICA: si hay una medicion en curso se espera a que termine, y si la ultima tiene
       mas de 10 s (y la bomba esta apagada) se mide antes de enviar, asi los datos que llegan al
       dashboard son recientes. Las tramas POR EVENTO (bomba, acuses) salen de inmediato. */
    if (!novedades) {
      if (ronda.activa) return;
      if (desde(ahora, t_ultima_muestra) > 10000UL) { iniciarRonda(); return; }
    }
    armarTrama();
    if (msg_pend.n > 0 && redEnviar(msg_pend)) plan.entregada(millis());
  } else if (a == envio::REENVIAR) {
    if (redEnviar(msg_pend)) plan.entregada(millis());
  }
}

/* ---------------------------------------------------------------------
   CONSOLA POR USB (solo si CONSOLA_SERIAL 1): r = regar 10 s, p = parar, s = estado
   Son ordenes locales: se ejecutan con las mismas reglas de seguridad, sin acuse al servidor.
   --------------------------------------------------------------------- */
#if CONSOLA_SERIAL
static void consolaSerie() {
  while (Serial.available()) {
    const int c = Serial.read();
    riego::Orden o;
    memset(&o, 0, sizeof(o));
    o.recibida_ms = millis();
    o.vence_s = 5;
    if (c == 'r' || c == 'R') {
      o.tipo = riego::ORDEN_RIEGO;
      o.dur_s = 10;
      const riego::ResultadoOrden r = ctl.atenderOrden(o, millis());
      Serial.printf("CONSOLA regar 10 s -> %s (%s)\n", r.ejecutada ? "ejecutada" : "rechazada", r.detalle);
      aplicarBomba();
    } else if (c == 'p' || c == 'P') {
      o.tipo = riego::ORDEN_PARAR;
      const riego::ResultadoOrden r = ctl.atenderOrden(o, millis());
      Serial.printf("CONSOLA parar -> %s\n", r.detalle);
      aplicarBomba();
    } else if (c == 's' || c == 'S') {
      imprimirEstado();
      imprimirConfig("CFG:");
    } else if (c == '?' || c == 'h' || c == 'H') {
      Serial.println("Consola: r = regar 10 s | p = parar la bomba | s = estado y configuracion");
    }
  }
}
#endif

/* ---------------------------------------------------------------------
   SETUP / LOOP
   El ESP8266 trae dos perros guardianes (por software ~3 s y por hardware ~8 s): reinician la placa
   si el bucle deja de ceder el control. Aqui todas las esperas usan delay(), que lo cede, y
   ESP.wdtFeed() lo alimenta en cada vuelta.
   --------------------------------------------------------------------- */
void setup() {
  /* 1) LO PRIMERO: la bomba apagada. */
  sensores::releIniciarSeguro();

  Serial.begin(115200);
  delay(50);
  EEPROM.begin(sizeof(CfgFlash));

  /* 2) Motivo del reinicio. Si el nodo se reinicio con la bomba encendida, se parte con la espera
        activa para no repetir el riego de inmediato (evita un bucle de reinicios con la bomba). */
  const rst_info* ri = ESP.getResetInfoPtr();
  const uint32_t motivo = ri ? ri->reason : (uint32_t)REASON_DEFAULT_RST;
  const bool por_wdt = (motivo == REASON_WDT_RST || motivo == REASON_SOFT_WDT_RST || motivo == REASON_EXCEPTION_RST);
  const bool interrumpido = (motivo != REASON_DEFAULT_RST) && rtcBombaEstabaActiva();
  rtcGuardarBomba(false);
  if (por_wdt) tramas_aviso_wdt = TRAMAS_AVISO_WDT;

  ctl.iniciar(millis(), interrumpido);
  ctl.bloquearRiegoAutoAlArrancar(ARRANQUE_SIN_RIEGO_S);
#if NODO_MASTIL
  ctl.sinBomba(true);
#endif
  cargarConfig();
  sensores::iniciar();
  boot_id = RANDOM_REG32;                             // generador de numeros aleatorios por hardware
  redIniciar();
  plan.iniciar(millis());

  Serial.println();
  Serial.println("=============================================");
  Serial.printf(" Invernadero: nodo %s  (firmware %s, ESP8266)\n", NODO_MASTIL ? "del mastil" : "de riego", FW_VERSION);
  Serial.println("=============================================");
  if (interrumpido) Serial.println("AVISO: el nodo se reinicio con la bomba encendida; espera de seguridad activa");
  if (por_wdt)      Serial.println("AVISO: reinicio por watchdog");
#if ARRANQUE_SIN_RIEGO_S > 0
  Serial.printf("AVISO: sin riego automatico los primeros %d s tras encender (la bomba no se activa sola al arrancar)\n", (int)ARRANQUE_SIN_RIEGO_S);
#endif
  imprimirConfig("CFG:");
#if CONSOLA_SERIAL
  Serial.println("Consola por USB: r = regar 10 s | p = parar | s = estado");
#endif
#if TABLA_SERIAL_S > 0
  Serial.printf("Tabla de estado cada %d s (cambie TABLA_SERIAL_S; 0 = desactivada)\n", (int)TABLA_SERIAL_S);
  t_tabla = millis() + 3000UL - (uint32_t)TABLA_SERIAL_S * 1000UL;   // primera fila a los ~3 s
#endif
}

void loop() {
  ESP.wdtFeed();

  /* Corte de seguridad: SIEMPRE lo primero, en cada vuelta. */
  ctl.tick(millis());
  aplicarBomba();

  /* Mediciones. */
  avanzarRonda();
  if (!ronda.activa) {
    const uint32_t periodo_ms = ctl.bombaEncendida() ? (uint32_t)MUESTREO_RIEGO_S * 1000UL
                                                     : (uint32_t)ctl.config().intervalo_s * 1000UL;
    if (!primera_muestra || desde(millis(), t_ultima_muestra) >= periodo_ms || ctl.quiereMuestraYa()) iniciarRonda();
  }

  /* Red: mantiene el WiFi (sin bloquear) y envia/recibe tramas. Con la bomba encendida no hace POST. */
  redMantener();
  gestionarEnvio();

#if TABLA_SERIAL_S > 0
  if (desde(millis(), t_tabla) >= (uint32_t)TABLA_SERIAL_S * 1000UL) {
    t_tabla = millis();
    imprimirFilaTabla();
  }
#endif

#if CONSOLA_SERIAL
  consolaSerie();
#endif

  delay(PERIODO_LOOP_MS);
}
