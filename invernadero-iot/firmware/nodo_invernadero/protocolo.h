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
#ifndef PROTOCOLO_H
#define PROTOCOLO_H

#include <stdint.h>
#include <stddef.h>
#include <stdio.h>
#include <stdarg.h>
#include <string.h>
#include <math.h>
#include <ArduinoJson.h>
#include "riego.h"

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

#endif  // PROTOCOLO_H
