/* =====================================================================
   NODO DEL INVERNADERO  -  monitoreo y riego automatico (ESP8266)
   Evolucion del "Codigo unificado" (seccion 17 del informe):
     DHT22 + YL-38/YL-69 + bomba de agua por rele  ->  dashboard (Supabase)

   Placas: NodeMCU 1.0 (ESP-12E), Wemos/LOLIN D1 mini y clones con ESP8266.
   Librerias (Gestor de librerias del IDE):
           "DHT sensor library" + "Adafruit Unified Sensor" (Adafruit), "ArduinoJson" (v7)

   COMO SE ORGANIZA
     riego.h      reglas del riego (logica pura, probada en el PC; igual que en el ESP32)
     envio.h      cuando enviar/reintentar tramas (logica pura, probada en el PC)
     protocolo.h  JSON de la trama y de la respuesta (contrato de la API)
     sensores.h   DHT22, YL-38, BH1750, anemometro y rele
     red.h        WiFi + HTTP(S)
     este archivo une todo en setup() y loop()

   REGLA DE ORO: la bomba se corta por tiempo en CADA vuelta de loop() (~10 ms). El ESP8266 tiene
   un solo nucleo y no tiene FreeRTOS: un POST bloquea el bucle durante segundos, asi que NUNCA se
   hace red con la bomba encendida (los eventos quedan en cola y salen al apagarse). Sin WiFi ni
   servidor el riego automatico sigue funcionando con la ultima configuracion guardada.
   ===================================================================== */
#include <Arduino.h>
#include <EEPROM.h>
#include "config.h"
#include "riego.h"
#include "envio.h"
#include "protocolo.h"
#include "sensores.h"
#include "red.h"

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
  uint32_t suma;          // control de integridad (FNV-1a de todo lo anterior)
};
static const uint32_t CFG_MAGIA = 0xC0F16A02UL;

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
    if (ctl.aplicarConfig(c)) Serial.printf("CFG: cargada de la memoria (ver %lu)\n", (unsigned long)c.ver);
    else Serial.println("CFG: la guardada es invalida; se usan los valores por defecto");
  } else {
    Serial.println("CFG: sin configuracion guardada; valores por defecto del contrato");
  }
}

static void imprimirConfig(const char* prefijo) {
  const riego::Config& c = ctl.config();
  Serial.printf("%s ver=%lu intervalo=%us suelo on/off/sat=%u/%u/%u temp_max=%.1fC riego_max=%us espera=%us\n",
                prefijo, (unsigned long)c.ver, (unsigned)c.intervalo_s, (unsigned)c.suelo_on, (unsigned)c.suelo_off,
                (unsigned)c.suelo_sat, (double)c.temp_max, (unsigned)c.riego_max_s, (unsigned)c.espera_s);
}

/* ---------------------------------------------------------------------
   RONDA DE MEDICION (no bloquea mas de ~250 ms)
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
  imprimirEstado();
}

static void intentarDHT() {
  ronda.intentos_dht++;
  float t = 0, h = 0;
  if (sensores::leerDHT(t, h)) {
    ronda.temp_ok = ronda.hum_ok = true;
    ronda.temp = t;
    ronda.hum = h;
    finalizarRonda();
    return;
  }
  if (ronda.intentos_dht >= REINTENTOS_DHT) {
    Serial.println("ERROR: sin lectura valida del DHT22 (revise el cableado y la resistencia de 10k)");
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
  if (!s.ok) Serial.printf("ERROR: lectura de suelo inestable (dispersion %d): revise el cableado del YL-38\n", s.dispersion);
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
  }
}

static void atenderOrdenes(protocolo::Respuesta& resp, uint32_t recibida_ms) {
  if (resp.ordenes_ignoradas) Serial.printf("ORDEN: %u ignorada(s) por formato invalido\n", (unsigned)resp.ordenes_ignoradas);
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

  const envio::Resultado r = plan.respuesta(millis(), rx.http, cuerpo_ok, rx.retry_after_s, intervalo_ms);
  switch (r) {
    case envio::EXITO:
      ctl.descartarEventosHasta(ev_hasta_pend);
      ctl.descartarAcksHasta(ack_hasta_pend);
      Serial.printf("RED: trama %lu enviada%s\n", (unsigned long)msg_pend.seq, resp.dup ? " (el servidor ya la tenia)" : "");
      aplicarCfgRecibida(resp);
      atenderOrdenes(resp, rx.recibido_ms);
      break;
    case envio::REINTENTAR:
      Serial.printf("RED: trama %lu fallo (HTTP %d), se reintenta igual (intento %u de %u)\n",
                    (unsigned long)msg_pend.seq, rx.http, (unsigned)plan.intentos(), (unsigned)envio::INTENTOS_MAX);
      break;
    case envio::DESCARTAR:
      Serial.printf("RED: trama %lu descartada (HTTP %d%s)\n", (unsigned long)msg_pend.seq, rx.http,
                    rx.http == 401 ? ": token rechazado, revise DEVICE_TOKEN" : "");
      break;
    case envio::DESCARTAR_Y_LIMPIAR:
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
  delay(300);
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
  imprimirConfig("CFG:");
#if CONSOLA_SERIAL
  Serial.println("Consola por USB: r = regar 10 s | p = parar | s = estado");
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

#if CONSOLA_SERIAL
  consolaSerie();
#endif

  delay(PERIODO_LOOP_MS);
}
