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
#ifndef RIEGO_H
#define RIEGO_H

#include <stdint.h>
#include <string.h>
#include <stdio.h>
#include <math.h>

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

static const uint16_t ESPERA_MIN_S    = 60;
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
  return c;
}

/* Una configuracion que viole cualquiera de estas reglas se IGNORA completa. */
inline bool configValida(const Config& c) {
  if (c.intervalo_s < INTERVALO_MIN_S || c.intervalo_s > INTERVALO_MAX_S) return false;
  if (c.suelo_sat < 1 || c.suelo_on > SUELO_MAX_RAW) return false;
  if (!(c.suelo_sat < c.suelo_off && c.suelo_off < c.suelo_on)) return false;
  if (!(c.temp_max >= TEMP_MAX_MIN && c.temp_max <= TEMP_MAX_MAX)) return false;  // falso tambien con NaN
  if (c.riego_max_s < RIEGO_MAX_MIN_S || c.riego_max_s > RIEGO_MAX_MAX_S) return false;
  if (c.espera_s < ESPERA_MIN_S || c.espera_s > ESPERA_MAX_S) return false;
  return true;
}

inline bool configIgual(const Config& a, const Config& b) {
  return a.ver == b.ver && a.intervalo_s == b.intervalo_s && a.suelo_on == b.suelo_on &&
         a.suelo_off == b.suelo_off && a.suelo_sat == b.suelo_sat && a.temp_max == b.temp_max &&
         a.riego_max_s == b.riego_max_s && a.espera_s == b.espera_s;
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
    if (bomba_) {
      const uint64_t trans = reloj_ - t_inicio_;
      const uint64_t tope  = (uint64_t)cfg_.riego_max_s * 1000ULL;
      if (manual_ && trans >= dur_orden_ms_) apagar(OFF_ORDEN, cmd_activa_);
      else if (trans >= tope)                apagar(OFF_TIEMPO_MAX, cmd_activa_);
    } else if (espera_activa_) {
      if (reloj_ - t_fin_ >= (uint64_t)cfg_.espera_s * 1000ULL) {
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
    if (espera_activa_) return EST_ESPERA;
    if (lec_.suelo_raw >= (int)cfg_.suelo_on && (!lec_.temp_ok || lec_.temp > cfg_.temp_max)) return EST_BLOQ_TEMP;
    return EST_IDLE;
  }

  uint32_t esperaRestanteS() const {
    if (!espera_activa_ || bomba_) return 0;
    const uint64_t total = (uint64_t)cfg_.espera_s * 1000ULL;
    const uint64_t pasado = reloj_ - t_fin_;
    if (pasado >= total) return 0;
    return (uint32_t)((total - pasado + 999ULL) / 1000ULL);   // redondeo hacia arriba
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

  Evento   ev_[COLA_MAX];
  uint8_t  n_ev_;
  uint32_t ev_seq_;
  AckOrden ack_[COLA_MAX];
  uint8_t  n_ack_;
  uint32_t ack_seq_;

  char     ids_[IDS_RECORDADOS][ID_MAX];
  uint8_t  ids_pos_;

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

#endif  // RIEGO_H
