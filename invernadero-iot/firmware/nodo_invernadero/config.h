/* =====================================================================
   config.h  -  AJUSTES DEL NODO (pines, tiempos y opciones)

   Aqui va todo lo que se puede necesitar cambiar. Lo secreto (WiFi,
   servidor, token) va en secrets.h, NO aqui.

   TABLA DE CONEXIONES (mapa por defecto: ESP32 DevKit V1, tabla 18 del informe)
   +------------------+-------------------+-------------------------------------+
   | Componente       | Pin del componente| Pin del ESP32                       |
   +------------------+-------------------+-------------------------------------+
   | DHT22            | VCC / DATA / GND  | 3V3 / GPIO4 / GND (10k DATA-3V3)    |
   | YL-38 (YL-69)    | VCC / A0 / GND    | GPIO25 / GPIO34 / GND               |
   | Rele (bomba)     | VCC / IN / GND    | 5V / GPIO26 / GND                   |
   | BH1750 (opcional)| VCC / SDA/SCL/GND | 3V3 / GPIO21 / GPIO22 / GND         |
   | LED indicador    | (de la placa)     | GPIO2 (encendido = regando)         |
   | Anemometro (opc.)| senal 0-5 V       | GPIO32 mediante divisor de tension  |
   +------------------+-------------------+-------------------------------------+
   En la Heltec WiFi LoRa 32 V2 ese mapa CHOCA con el radio LoRa y la pantalla
   OLED (GPIO26 = DIO0 del SX1276, GPIO4 = SDA del OLED, GPIO34 = DIO2, GPIO25 =
   LED, GPIO21 = Vext). Por eso, al elegir esa placa se usa otro mapa (abajo).
   Detalle y verificacion: docs/hardware.md
   ===================================================================== */
#ifndef CONFIG_H
#define CONFIG_H

#define FW_VERSION "1.0.0"

/* ---------------------------------------------------------------------
   ROL Y OPCIONES DEL NODO
   --------------------------------------------------------------------- */
/* Cada opcion puede fijarse aqui o desde la linea de comandos (-DNODO_MASTIL=1 ...). */
#ifndef NODO_MASTIL
#define NODO_MASTIL      0   // 0 = nodo de invernadero (DHT22 + suelo + bomba)
                             // 1 = nodo del mastil: SIN suelo ni bomba (solo DHT22 y viento)
#endif
#ifndef USAR_ANEMOMETRO
#define USAR_ANEMOMETRO  0   // 1 = lee el anemometro (poner junto con NODO_MASTIL 1)
#endif
#ifndef USAR_BH1750
#define USAR_BH1750      1   // 1 = intenta leer el BH1750; si no responde, "luz" va null (sin falla)
#endif
#ifndef CONSOLA_SERIAL
#define CONSOLA_SERIAL   1   // 1 = acepta comandos por USB (r = regar 10 s, p = parar, s = estado)
                             // El informe pide deshabilitar el puerto de depuracion en produccion: poner 0.
#endif

/* Para forzar el mapa de la Heltec V2 al usar otra placa en el IDE, quitar el // : */
// #define PLACA_HELTEC_V2

#if defined(ARDUINO_HELTEC_WIFI_LORA_32_V2) && !defined(PLACA_HELTEC_V2)
  #define PLACA_HELTEC_V2    // la placa Heltec V2 se detecta sola
#endif

/* ---------------------------------------------------------------------
   PINES
   Regla: el sensor de suelo debe ir en un pin del ADC1 (GPIO32 a GPIO39);
   el ADC2 no funciona mientras el WiFi esta activo.
   --------------------------------------------------------------------- */
#if defined(PLACA_HELTEC_V2)
  /* Mapa alternativo: usa solo pines que el core NO asigna al radio (5, 14, 18, 19, 26,
     27, 34, 35), a la pantalla (4, 15, 16), al LED (25) ni a Vext (21). */
  #define PIN_DHT           13   // DATA del DHT22
  #define PIN_SUELO         33   // A0 del YL-38 (ADC1_CH5)
  #define PIN_SUELO_VCC      2   // VCC del YL-38: se energiza solo al medir
  #define PIN_RELE          17   // IN del modulo de rele
  #define PIN_LED           25   // LED blanco de la placa
  #define PIN_SDA           22   // I2C del BH1750
  #define PIN_SCL           23
#else
  /* Mapa por defecto: ESP32 DevKit V1 (tabla 18 del informe). */
  #define PIN_DHT            4
  #define PIN_SUELO         34   // solo entrada, ADC1_CH6
  #define PIN_SUELO_VCC     25
  #define PIN_RELE          26
  #define PIN_LED            2
  #define PIN_SDA           21
  #define PIN_SCL           22
#endif
#define PIN_ANEMOMETRO      32   // ADC1_CH4, libre en ambos mapas (solo si USAR_ANEMOMETRO 1)

#if !NODO_MASTIL
  static_assert(PIN_SUELO >= 32 && PIN_SUELO <= 39, "El sensor de suelo debe ir en el ADC1 (GPIO32-39)");
#endif

/* La mayoria de los modulos de rele son ACTIVOS EN BAJO: cierran el contacto con el pin en LOW.
   Si el suyo funciona al reves, cambiar a false. */
#define RELE_ACTIVO_EN_BAJO  true

/* ---------------------------------------------------------------------
   SENSOR DHT22
   --------------------------------------------------------------------- */
#define TIPO_DHT             DHT22
#define REINTENTOS_DHT       3      // intentos por ronda de medicion
#define REINTENTO_DHT_MS     2100   // el DHT22 pide >= 2 s entre lecturas

/* ---------------------------------------------------------------------
   SENSOR DE SUELO YL-38 / YL-69
   El ADC del ESP32 es de 12 bits (0-4095). Se promedian varias muestras y
   se lleva a la escala de 10 bits (0-1023) de la tabla de la imagen:
        0-299   SATURADO   sumergido / muy humedo
      300-699   OPTIMO     suelo humedo, adecuado para la mayoria de las plantas
      700-1023  SECO       tierra seca o sensor fuera del suelo (aire)
   --------------------------------------------------------------------- */
#define SUELO_MUESTRAS            10
#define SUELO_ESTABILIZACION_MS   50    // la sonda se energiza solo durante la medicion
#define SUELO_ENTRE_MUESTRAS_MS   20
#define SUELO_DISPERSION_MAX_12B  400   // diferencia max-min entre muestras (0-4095) mas alla de
                                        // la cual la lectura se considera inestable (cable suelto)

/* Calibracion LOCAL: solo sirve para mostrar el % por el Monitor Serie. El % que ve el
   dashboard lo calcula el servidor con la calibracion del nodo (cal_dry / cal_wet). */
#define SUELO_RAW_AIRE_LOCAL   1023     // lectura con el sensor al aire   -> 0 %
#define SUELO_RAW_AGUA_LOCAL      0     // lectura con el sensor en agua   -> 100 %

/* ---------------------------------------------------------------------
   BH1750 (I2C, direccion 0x23) y ANEMOMETRO (0-5 V = 0-45 m/s)
   Divisor para el anemometro: R_ARRIBA = 20 k (entre la senal y el pin) y
   R_ABAJO = 10 k (entre el pin y GND) => 5 V -> 1,67 V, dentro de la zona
   lineal del ADC.
   --------------------------------------------------------------------- */
#define BH1750_DIRECCION      0x23
#define ANEMOMETRO_R_ARRIBA   20000.0f
#define ANEMOMETRO_R_ABAJO    10000.0f
#define ANEMOMETRO_V_MAX      5.0f
#define ANEMOMETRO_MS_MAX     45.0f

/* ---------------------------------------------------------------------
   TIEMPOS DEL BUCLE
   --------------------------------------------------------------------- */
#define MUESTREO_RIEGO_S      5       // mientras la bomba esta encendida se mide cada 5 s
#define PERIODO_LOOP_MS       10      // pausa por vuelta (el corte por tiempo se evalua en cada una)
#define WDT_TIMEOUT_S         15      // el watchdog reinicia el nodo si el bucle se cuelga
#define REINICIO_RED_TRABADA_S 120    // si la tarea de red no responde en tanto tiempo, se reinicia el nodo
#define TRAMAS_AVISO_WDT      3       // cuantas tramas informan "reinicio_wdt" tras un reinicio por watchdog

#endif  // CONFIG_H
