/* =====================================================================
   sensores.h  -  LECTURA DE SENSORES Y CONTROL DEL RELE (usa Arduino)

   DHT22 (temperatura y humedad del aire) | YL-38/YL-69 (humedad de suelo)
   BH1750 (luz, opcional)                 | anemometro (viento, opcional)
   Modulo de rele de la bomba.

   Ninguna funcion bloquea mas de ~250 ms (la medicion del suelo es la mas
   larga: 50 ms de estabilizacion + 10 muestras separadas 20 ms).
   ===================================================================== */
#ifndef SENSORES_H
#define SENSORES_H

#include <Arduino.h>
#include <Wire.h>
#include <DHT.h>
#include <driver/gpio.h>
#include "config.h"

#define NIVEL_RELE_ON   (RELE_ACTIVO_EN_BAJO ? LOW : HIGH)
#define NIVEL_RELE_OFF  (RELE_ACTIVO_EN_BAJO ? HIGH : LOW)

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
  pinMode(PIN_LED, OUTPUT);
  digitalWrite(PIN_LED, LOW);
#endif
}

/* Idempotente: se puede llamar en cada vuelta. */
inline void releAplicar(bool encendida) {
#if !NODO_MASTIL
  digitalWrite(PIN_RELE, encendida ? NIVEL_RELE_ON : NIVEL_RELE_OFF);
  digitalWrite(PIN_LED, encendida ? HIGH : LOW);
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
  int  raw10;      // 0..1023: escala de la tabla de la imagen
  int  raw12;      // 0..4095: lectura original del ADC
  int  dispersion; // max - min entre las muestras (en cuentas de 12 bits)
};

/* El YL-69 es resistivo: si se mantiene energizado, la corriente continua entre sus electrodos
   lo corroe por electrolisis en pocas semanas. Por eso se alimenta desde un pin del ESP32 y solo
   se enciende durante la medicion (50 ms + 10 muestras). */
inline Suelo medirSuelo() {
  Suelo s = {false, 0, 0, 0};
#if !NODO_MASTIL
  digitalWrite(PIN_SUELO_VCC, HIGH);
  delay(SUELO_ESTABILIZACION_MS);
  long suma = 0;
  int minimo = 4095, maximo = 0;
  for (int i = 0; i < SUELO_MUESTRAS; i++) {
    const int v = analogRead(PIN_SUELO);
    suma += v;
    if (v < minimo) minimo = v;
    if (v > maximo) maximo = v;
    delay(SUELO_ENTRE_MUESTRAS_MS);
  }
  digitalWrite(PIN_SUELO_VCC, LOW);
  s.raw12 = (int)(suma / SUELO_MUESTRAS);
  s.raw10 = s.raw12 / 4;                       // 12 bits (0-4095) -> 10 bits (0-1023)
  s.dispersion = maximo - minimo;
  s.ok = (s.dispersion <= SUELO_DISPERSION_MAX_12B);
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

/* ---------- Anemometro (solo nodo del mastil): senal 0-5 V = 0-45 m/s ---------- */
#if USAR_ANEMOMETRO
inline bool leerViento(float& ms) {
  long suma_mv = 0;
  for (int i = 0; i < 10; i++) { suma_mv += analogReadMilliVolts(PIN_ANEMOMETRO); delay(2); }
  const float mv_pin = (float)suma_mv / 10.0f;                         // tension en el pin (ya calibrada)
  const float divisor = (ANEMOMETRO_R_ARRIBA + ANEMOMETRO_R_ABAJO) / ANEMOMETRO_R_ABAJO;
  const float v_sensor = mv_pin / 1000.0f * divisor;                   // reconstruye los 0-5 V del sensor
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
  analogReadResolution(12);                    // ESP32: 0 a 4095
#if !NODO_MASTIL
  pinMode(PIN_SUELO_VCC, OUTPUT);
  digitalWrite(PIN_SUELO_VCC, LOW);            // sonda sin energia mientras no se mide
  /* El modulo YL-38 se alimenta desde este pin y consume del orden de 20 mA con la sonda
     energizada (tabla 3 del informe). Se sube el pin a la mayor capacidad de corriente que ofrece
     el ESP32 (GPIO_DRIVE_CAP_3 = "strongest" en el SDK) para que el modulo no arrastre la tension
     del pin ni falsee la lectura. Si su modulo consume mas, alimentelo con un transistor. */
  gpio_set_drive_capability((gpio_num_t)PIN_SUELO_VCC, GPIO_DRIVE_CAP_3);
  analogSetPinAttenuation(PIN_SUELO, ADC_11db);   // rango completo del ADC (~0 a 3,3 V)
  pinMode(PIN_SUELO, INPUT);
#endif
  dht.begin();
#if USAR_BH1750
  Wire.begin(PIN_SDA, PIN_SCL);
  Wire.setTimeOut(50);                         // un bus colgado no debe bloquear el bucle
  if (luzDetectar()) delay(180);               // primera medicion del BH1750
#endif
#if USAR_ANEMOMETRO
  analogSetPinAttenuation(PIN_ANEMOMETRO, ADC_11db);
#endif
}

}  // namespace sensores

#endif  // SENSORES_H
