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
#ifndef ENVIO_H
#define ENVIO_H

#include <stdint.h>

namespace envio {

static const uint32_t SEPARACION_MIN_MS    = 2000;
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

#endif  // ENVIO_H
