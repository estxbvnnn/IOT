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
   | YL-38 (YL-69)    | VCC / A0 / GND    | D7 (GPIO13) / A0 / GND                |
   | Rele (bomba)     | VCC / IN / GND    | VIN (5 V) / D6 (GPIO12) / GND         |
   | BH1750 (opcional)| VCC / SDA/SCL/GND | 3V3 / D2 (GPIO4) / D1 (GPIO5) / GND   |
   | LED indicador    | (de la placa)     | GPIO2 = D4 (encendido = regando)      |
   | Anemometro (opc.)| senal 0-5 V       | A0 con divisor (solo NODO_MASTIL 1)   |
   +------------------+-------------------+---------------------------------------+
   El ESP8266 tiene UNA sola entrada analogica (A0): la usa el suelo (YL-38) o, en el
   nodo del mastil, el anemometro. Nunca los dos en la misma placa.
   El YL-38 se alimenta desde D7 y solo se energiza al medir (evita que la sonda se
   corroa). Si su modulo consume mas de ~12 mA, alimentelo con un transistor.
   Detalle y comparacion con el ESP32: docs/hardware.md
   ===================================================================== */
#ifndef CONFIG_H
#define CONFIG_H

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

#if USAR_ANEMOMETRO && !NODO_MASTIL
  #error "En ESP8266 el anemometro usa el unico pin analogico (A0), el mismo del suelo: use USAR_ANEMOMETRO solo junto con NODO_MASTIL 1 (nodo del mastil, sin suelo)."
#endif

/* ---------------------------------------------------------------------
   PINES (numeros GPIO; entre parentesis la etiqueta de la placa NodeMCU / D1 mini)
   Se evitan los pines de arranque: GPIO0 (D3), GPIO2 (D4, solo el LED) y GPIO15 (D8).
   --------------------------------------------------------------------- */
#define PIN_DHT            14   // D5: DATA del DHT22
#define PIN_SUELO          A0   // unica entrada analogica: A0 del YL-38
#define PIN_SUELO_VCC      13   // D7: VCC del YL-38 (se energiza solo al medir)
#define PIN_RELE           12   // D6: IN del modulo de rele
#define PIN_LED             2   // D4: LED de la placa (en la NodeMCU/D1 mini se enciende con LOW)
#define PIN_SDA             4   // D2: I2C del BH1750
#define PIN_SCL             5   // D1
#define PIN_ANEMOMETRO     A0   // solo con NODO_MASTIL 1

/* La mayoria de los modulos de rele son ACTIVOS EN BAJO: cierran el contacto con el pin en LOW.
   Si el suyo funciona al reves, cambiar a false. */
#define RELE_ACTIVO_EN_BAJO  true
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
#define SUELO_ESTABILIZACION_MS   50    // la sonda se energiza solo durante la medicion
#define SUELO_ENTRE_MUESTRAS_MS   20
#define SUELO_DISPERSION_MAX      100   // diferencia max-min entre muestras (0-1023) mas alla de
                                        // la cual la lectura se considera inestable (cable suelto)

/* Calibracion LOCAL: solo sirve para mostrar el % por el Monitor Serie. El % que ve el
   dashboard lo calcula el servidor con la calibracion del nodo (cal_dry / cal_wet). */
#define SUELO_RAW_AIRE_LOCAL   1023     // lectura con el sensor al aire   -> 0 %
#define SUELO_RAW_AGUA_LOCAL      0     // lectura con el sensor en agua   -> 100 %

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
#define PERIODO_LOOP_MS       10      // pausa por vuelta (el corte por tiempo se evalua en cada una)
#define TRAMAS_AVISO_WDT      3       // cuantas tramas informan "reinicio_wdt" tras un reinicio por watchdog
#define HTTP_TIMEOUT_MS       8000    // tiempo maximo de un POST. El ESP8266 no tiene otro nucleo: mientras
                                      // dura, el bucle espera; por eso NUNCA se hace con la bomba encendida.
#define WIFI_REINTENTO_MS     20000   // primer reintento de conexion WiFi; luego se duplica hasta 5 min

/* HTTPS en ESP8266 (BearSSL): memoria para los buffers de TLS. Con 16 KB de entrada cabe cualquier
   servidor pero casi toda la RAM libre se va en eso; con menos, algunos servidores fallan. */
#define TLS_BUFFER_RX         4096
#define TLS_BUFFER_TX         1024

#endif  // CONFIG_H
