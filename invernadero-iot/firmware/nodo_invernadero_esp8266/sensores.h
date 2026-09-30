/* =====================================================================
   sensores.h  -  LECTURA DE SENSORES Y CONTROL DEL RELE (ESP8266)

   DHT22 (temperatura y humedad del aire) | YL-38/YL-69 (humedad de suelo)
   BH1750 (luz, opcional)                 | anemometro (viento, opcional; solo mastil)
   Modulo de rele de la bomba.

   Ninguna funcion bloquea mas de ~250 ms (la medicion del suelo es la mas
   larga: 50 ms de estabilizacion + 10 muestras separadas 20 ms). Todas las
   esperas usan delay(), que cede el control al WiFi y al perro guardian.
   ===================================================================== */
#ifndef SENSORES_H
#define SENSORES_H

#include <Arduino.h>
#include <Wire.h>
#include <DHT.h>
#include "config.h"

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
   durante la medicion (50 ms + 10 muestras). */
inline Suelo medirSuelo() {
  Suelo s = {false, 0, 0};
#if !NODO_MASTIL
  digitalWrite(PIN_SUELO_VCC, HIGH);
  delay(SUELO_ESTABILIZACION_MS);
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
  s.ok = (s.dispersion <= SUELO_DISPERSION_MAX);
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

#endif  // SENSORES_H
