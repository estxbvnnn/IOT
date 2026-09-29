// PARA ARDUINO IDE USE ../nodo_invernadero_unico/nodo_invernadero_unico.ino
// (todo en un solo archivo, no depende de otros). Esta version modular es la
// fuente y la que tiene pruebas de host.
/* =====================================================================
   NODO DEL INVERNADERO  -  monitoreo y riego automatico (ESP32)
   Evolucion del "Codigo unificado" (seccion 17 del informe):
     DHT22 + YL-38/YL-69 + bomba de agua por rele  ->  dashboard (Supabase)

   Placas: ESP32 DevKit V1 (mapa de pines por defecto) y Heltec WiFi LoRa 32 V2
           (mapa alternativo, se elige solo). Ver config.h y docs/hardware.md.
   Librerias (Gestor de librerias del IDE):
           "DHT sensor library" + "Adafruit Unified Sensor" (Adafruit), "ArduinoJson" (v7)
   Antes de compilar: copiar secrets.example.h como secrets.h y completarlo.

   COMO SE ORGANIZA
     riego.h      reglas del riego (logica pura, probada en el PC)
     envio.h      cuando enviar/reintentar tramas (logica pura, probada en el PC)
     protocolo.h  JSON de la trama y de la respuesta (contrato de la API)
     sensores.h   DHT22, YL-38, BH1750, anemometro y rele
     red.h        WiFi + HTTP(S) en una tarea aparte
     este archivo une todo en setup() y loop()

   REGLA DE ORO: loop() NUNCA espera a la red. El corte de la bomba por tiempo
   se evalua en cada vuelta (cada ~10 ms). Sin WiFi ni servidor el riego
   automatico sigue funcionando con la ultima configuracion guardada.
   ===================================================================== */
#include <Arduino.h>
#include <Preferences.h>
#include <esp_task_wdt.h>
#include <esp_system.h>
#include <esp_attr.h>
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
static Preferences        prefs;

/* Memoria RTC que sobrevive a reinicios por software, watchdog o panico (no a un corte de
   energia). Sirve para saber si el nodo se reinicio CON LA BOMBA ENCENDIDA. */
RTC_NOINIT_ATTR uint32_t rtc_magia;
RTC_NOINIT_ATTR uint32_t rtc_bomba_activa;
static const uint32_t RTC_MAGIA = 0xB0B4C0DEUL;

/* Ultimos valores medidos (los que viajan en la trama). */
struct Ultima {
  bool  hay;
  bool  temp_ok;   float temp;
  bool  hum_ok;    float hum;
  bool  suelo_ok;  int   suelo_raw;  int suelo_raw12;
  bool  luz_ok;    float luz;
  bool  viento_ok; float viento;
};
static Ultima ultima = {false, false, 0, false, 0, false, 0, 0, false, 0, false, 0};

/* Ronda de medicion en curso. El DHT22 puede pedir reintentos separados 2,1 s: se hacen sin
   bloquear el bucle. */
struct Ronda {
  bool     activa;
  bool     con_dht;
  uint8_t  intentos_dht;
  uint32_t t_dht;
  bool     suelo_ok;  int suelo_raw;  int suelo_raw12;  int dispersion;
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
static uint8_t              entregas_sin_rx = 0;    // tramas entregadas a la tarea de red que aun no devolvieron nada
static uint32_t             t_entrega_ms = 0;       // desde cuando se espera la respuesta mas antigua
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
    rtc_bomba_activa = on ? 1 : 0;
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
   CONFIGURACION EN MEMORIA NO VOLATIL (NVS): sobrevive a reinicios
   --------------------------------------------------------------------- */
static void guardarConfig(const riego::Config& c) {
  prefs.begin("nodo", false);
  prefs.putUInt("cver", c.ver);
  prefs.putUShort("cint", c.intervalo_s);
  prefs.putUShort("con", c.suelo_on);
  prefs.putUShort("coff", c.suelo_off);
  prefs.putUShort("csat", c.suelo_sat);
  prefs.putFloat("ctmx", c.temp_max);
  prefs.putUShort("crmx", c.riego_max_s);
  prefs.putUShort("cesp", c.espera_s);
  prefs.end();
}

static void cargarConfig() {
  prefs.begin("nodo", false);
  if (prefs.isKey("cver")) {
    riego::Config c = riego::configPorDefecto();
    c.ver         = prefs.getUInt("cver", c.ver);
    c.intervalo_s = prefs.getUShort("cint", c.intervalo_s);
    c.suelo_on    = prefs.getUShort("con", c.suelo_on);
    c.suelo_off   = prefs.getUShort("coff", c.suelo_off);
    c.suelo_sat   = prefs.getUShort("csat", c.suelo_sat);
    c.temp_max    = prefs.getFloat("ctmx", c.temp_max);
    c.riego_max_s = prefs.getUShort("crmx", c.riego_max_s);
    c.espera_s    = prefs.getUShort("cesp", c.espera_s);
    if (ctl.aplicarConfig(c)) Serial.printf("CFG: cargada de la memoria (ver %lu)\n", (unsigned long)c.ver);
    else Serial.println("CFG: la guardada es invalida; se usan los valores por defecto");
  } else {
    Serial.println("CFG: sin configuracion guardada; valores por defecto del contrato");
  }
  prefs.end();
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
    Serial.printf("Suelo: %d (0-1023; ADC 12 bits: %d) -> %s, %d %% | ", ultima.suelo_raw, ultima.suelo_raw12,
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
  ultima.suelo_ok = ronda.suelo_ok;  ultima.suelo_raw = ronda.suelo_raw;  ultima.suelo_raw12 = ronda.suelo_raw12;
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
  ronda.suelo_ok = s.ok;  ronda.suelo_raw = s.raw10;  ronda.suelo_raw12 = s.raw12;  ronda.dispersion = s.dispersion;
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
  /* Cualquier respuesta prueba que la tarea de red esta viva (aunque sea de una trama vieja). */
  if (entregas_sin_rx) { entregas_sin_rx--; t_entrega_ms = millis(); }
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

/* Registra que una trama se entrego a la tarea de red. */
static void entregada() {
  plan.entregada(millis());
  if (entregas_sin_rx == 0) t_entrega_ms = millis();
  if (entregas_sin_rx < 250) entregas_sin_rx++;
}

static void gestionarEnvio() {
  if (!redActiva()) return;
  const uint32_t intervalo_ms = (uint32_t)ctl.config().intervalo_s * 1000UL;

  static MsgRx rx;                                              // estatico: no ocupa la pila de loop()
  while (redRecibir(rx)) procesarRespuesta(rx);

  uint32_t ahora = millis();
  if (plan.vencioEnVuelo(ahora)) {                              // la tarea de red no contesta
    Serial.println("RED: sin respuesta de la tarea de red (30 s)");
    plan.respuesta(ahora, -99, false, 0, intervalo_ms);
  }
  /* Si la tarea de red lleva minutos sin devolver nada, esta trabada: se reinicia el nodo
     (la bomba queda apagada; al volver se aplica la espera conservadora). */
  if (entregas_sin_rx && desde(ahora, t_entrega_ms) >= (uint32_t)REINICIO_RED_TRABADA_S * 1000UL) {
    Serial.println("RED: tarea de red trabada; reiniciando el nodo por seguridad");
    sensores::releAplicar(false);
    delay(100);
    ESP.restart();
  }

  const bool listo = ultima.hay && redConectada();
  const bool novedades = hayNovedades();
  const envio::Accion a = plan.decidir(ahora, listo, novedades);

  if (a == envio::ENVIAR_NUEVA) {
    /* Trama PERIODICA: si hay una medicion en curso se espera a que termine, y si la ultima tiene
       mas de 10 s (y la bomba esta apagada) se mide antes de enviar, asi los datos que llegan al
       dashboard son recientes. Las tramas POR EVENTO (bomba, acuses) salen de inmediato. */
    if (!novedades) {
      if (ronda.activa) return;
      if (!ctl.bombaEncendida() && desde(ahora, t_ultima_muestra) > 10000UL) { iniciarRonda(); return; }
    }
    armarTrama();
    if (msg_pend.n > 0 && redEnviar(msg_pend)) entregada();
  } else if (a == envio::REENVIAR) {
    if (redEnviar(msg_pend)) entregada();
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
   WATCHDOG: si loop() se cuelga mas de WDT_TIMEOUT_S, el ESP32 se reinicia (y la bomba queda apagada).
   Compatibilidad: el core 3.x (ESP-IDF 5) ya inicializa el watchdog de tareas, por eso se
   reconfigura con esp_task_wdt_config_t; el core 2.x (ESP-IDF 4) usa esp_task_wdt_init(segundos, panico).
   --------------------------------------------------------------------- */
static void iniciarWatchdog() {
#if defined(ESP_ARDUINO_VERSION_MAJOR) && ESP_ARDUINO_VERSION_MAJOR >= 3
  esp_task_wdt_config_t cfg;
  cfg.timeout_ms = (uint32_t)WDT_TIMEOUT_S * 1000UL;
  cfg.idle_core_mask = (1U << portNUM_PROCESSORS) - 1U;        // vigila tambien las tareas IDLE de cada nucleo
  cfg.trigger_panic = true;
  if (esp_task_wdt_reconfigure(&cfg) != ESP_OK) esp_task_wdt_init(&cfg);
#else
  esp_task_wdt_init(WDT_TIMEOUT_S, true);
#endif
  esp_task_wdt_add(NULL);                                       // suscribe la tarea de loop()
}

/* ---------------------------------------------------------------------
   SETUP / LOOP
   --------------------------------------------------------------------- */
void setup() {
  /* 1) LO PRIMERO: la bomba apagada. */
  sensores::releIniciarSeguro();

  Serial.begin(115200);
  delay(300);

  /* 2) Motivo del reinicio. Si el nodo se reinicio con la bomba encendida, se parte con la espera
        activa para no repetir el riego de inmediato (evita un bucle de reinicios con la bomba). */
  const esp_reset_reason_t motivo = esp_reset_reason();
  const bool por_wdt = (motivo == ESP_RST_TASK_WDT || motivo == ESP_RST_INT_WDT || motivo == ESP_RST_WDT);
  const bool interrumpido = (motivo != ESP_RST_POWERON) && rtc_magia == RTC_MAGIA && rtc_bomba_activa == 1;
  rtc_magia = RTC_MAGIA;
  rtc_bomba_activa = 0;
  if (por_wdt) tramas_aviso_wdt = TRAMAS_AVISO_WDT;

  ctl.iniciar(millis(), interrumpido);
#if NODO_MASTIL
  ctl.sinBomba(true);
#endif
  cargarConfig();
  sensores::iniciar();
  boot_id = esp_random();
  iniciarWatchdog();
  redIniciar();
  plan.iniciar(millis());

  Serial.println();
  Serial.println("=============================================");
  Serial.printf(" Invernadero: nodo %s  (firmware %s)\n", NODO_MASTIL ? "del mastil" : "de riego", FW_VERSION);
  Serial.println("=============================================");
  if (interrumpido) Serial.println("AVISO: el nodo se reinicio con la bomba encendida; espera de seguridad activa");
  if (por_wdt)      Serial.println("AVISO: reinicio por watchdog");
  imprimirConfig("CFG:");
#if CONSOLA_SERIAL
  Serial.println("Consola por USB: r = regar 10 s | p = parar | s = estado");
#endif
}

void loop() {
  esp_task_wdt_reset();

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

  /* Red (no bloquea: solo mueve mensajes entre colas). */
  gestionarEnvio();

#if CONSOLA_SERIAL
  consolaSerie();
#endif

  delay(PERIODO_LOOP_MS);
}
