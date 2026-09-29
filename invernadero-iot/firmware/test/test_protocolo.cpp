/* test_protocolo.cpp - pruebas de la trama y de la respuesta (protocolo.h) en el PC.
   Necesita la libreria ArduinoJson (v7): ver README.md para el -I. */
#define _CRT_SECURE_NO_WARNINGS
#include <string>
#include "mini_test.h"
#include "protocolo.h"

using namespace protocolo;

static DatosTrama base() {
  DatosTrama d; memset(&d, 0, sizeof(d));
  d.fw = "1.0.0"; d.boot = 3735928559u; d.seq = 42; d.up = 12630;
  d.temp_ok = true;  d.temp = 24.3f;
  d.hum_ok = true;   d.hum = 61.2f;
  d.suelo_ok = true; d.suelo_raw = 512;
  d.con_luz = true;  d.luz_ok = true; d.luz = 18234.4f;
  d.bomba = false; d.riego_s = 0; d.est = "idle"; d.esp = 0;
  d.con_rssi = true; d.rssi = -61;
  return d;
}

static std::string armar(DatosTrama& d, size_t cap = TX_MAX) {
  std::vector<char> buf(cap);
  const size_t n = construirTrama(buf.data(), cap, d);
  return n ? std::string(buf.data(), n) : std::string();
}

static bool jsonValido(const std::string& s, JsonDocument& doc) {
  return !deserializeJson(doc, s.c_str(), s.size());
}

static riego::Evento ev(bool on, uint8_t motivo, uint16_t dur, const char* cmd) {
  riego::Evento e; memset(&e, 0, sizeof(e));
  e.encendido = on; e.motivo = motivo; e.dur_s = dur; strncpy(e.cmd, cmd, riego::ID_MAX - 1);
  return e;
}
static riego::AckOrden ack(const char* id, bool ok, const char* det) {
  riego::AckOrden a; memset(&a, 0, sizeof(a));
  strncpy(a.id, id, riego::ID_MAX - 1); a.ejecutada = ok; strncpy(a.detalle, det, riego::DETALLE_MAX - 1);
  return a;
}

/* ===================================================================== TRAMA */
TEST(trama_basica_exacta) {
  DatosTrama d = base();
  const std::string s = armar(d);
  CHECK_STR(s.c_str(),
    "{\"v\":1,\"fw\":\"1.0.0\",\"boot\":3735928559,\"seq\":42,\"up\":12630,\"temp\":24.3,\"hum_aire\":61.2,"
    "\"suelo_raw\":512,\"luz\":18234,\"bomba\":0,\"riego_s\":0,\"est\":\"idle\",\"esp\":0,\"rssi\":-61,\"fallas\":[]}");
}

TEST(la_trama_es_json_valido_con_los_tipos_del_contrato) {
  DatosTrama d = base();
  d.bomba = true; d.riego_s = 12; d.est = "riego";
  const std::string s = armar(d);
  JsonDocument doc;
  CHECK(jsonValido(s, doc));
  CHECK_EQ(doc["v"].as<int>(), 1);
  CHECK_STR(doc["fw"].as<const char*>(), "1.0.0");
  CHECK(doc["boot"].is<uint32_t>());
  CHECK_EQ((long long)doc["boot"].as<uint32_t>(), 3735928559LL);
  CHECK_EQ(doc["seq"].as<int>(), 42);
  CHECK(doc["temp"].is<float>());
  CHECK_NEAR(doc["temp"].as<float>(), 24.3, 1e-4);
  CHECK_NEAR(doc["hum_aire"].as<float>(), 61.2, 1e-4);
  CHECK(doc["suelo_raw"].is<int>());
  CHECK_EQ(doc["suelo_raw"].as<int>(), 512);
  CHECK_EQ(doc["bomba"].as<int>(), 1);
  CHECK_EQ(doc["riego_s"].as<int>(), 12);
  CHECK_STR(doc["est"].as<const char*>(), "riego");
  CHECK_EQ(doc["rssi"].as<int>(), -61);
  CHECK(doc["fallas"].is<JsonArray>());
  CHECK(doc["ev"].isNull());                         // sin eventos, la clave no viaja
  CHECK(doc["acks"].isNull());
  CHECK(doc["snr"].isNull());                        // WiFi: sin SNR
}

TEST(valores_sin_lectura_viajan_como_null) {
  DatosTrama d = base();
  d.temp_ok = false; d.hum_ok = false; d.suelo_ok = false; d.luz_ok = false;
  const std::string s = armar(d);
  JsonDocument doc;
  CHECK(jsonValido(s, doc));
  CHECK(doc["temp"].isNull());
  CHECK(s.find("\"temp\":null") != std::string::npos);
  CHECK(s.find("\"hum_aire\":null") != std::string::npos);
  CHECK(s.find("\"suelo_raw\":null") != std::string::npos);
  CHECK(s.find("\"luz\":null") != std::string::npos);
}

TEST(luz_y_viento_solo_viajan_si_el_nodo_los_usa) {
  DatosTrama d = base();
  d.con_luz = false;
  std::string s = armar(d);
  CHECK(s.find("\"luz\"") == std::string::npos);
  CHECK(s.find("\"viento\"") == std::string::npos);
  d.con_viento = true; d.viento_ok = true; d.viento = 7.25f;
  s = armar(d);
  CHECK(s.find("\"viento\":7.2") != std::string::npos || s.find("\"viento\":7.3") != std::string::npos);
  d.viento_ok = false;
  s = armar(d);
  CHECK(s.find("\"viento\":null") != std::string::npos);
  JsonDocument doc;
  CHECK(jsonValido(s, doc));
}

TEST(fallas_y_rssi_opcional) {
  DatosTrama d = base();
  d.fallas[d.n_fallas++] = "suelo";
  d.fallas[d.n_fallas++] = "dht";
  d.con_rssi = false;
  const std::string s = armar(d);
  CHECK(s.find("\"fallas\":[\"suelo\",\"dht\"]") != std::string::npos);
  CHECK(s.find("\"rssi\"") == std::string::npos);
}

TEST(eventos_y_acuses_con_el_formato_del_contrato) {
  DatosTrama d = base();
  d.ev[0] = ev(true, riego::ON_AUTO, 0, "");             d.ev_ago_s[0] = 95;
  d.ev[1] = ev(false, riego::OFF_TIEMPO_MAX, 30, "");     d.ev_ago_s[1] = 65;
  d.ev[2] = ev(true, riego::ON_MANUAL, 0, "0b6c1a52");    d.ev_ago_s[2] = 0;
  d.n_ev = 3;
  d.ack[0] = ack("0b6c1a52-7c1e-4f0e-9a0c-2f3e7a9d1c11", true, "regando 20 s");
  d.ack[1] = ack("otro-id", false, "en espera entre riegos (faltan 143 s)");
  d.n_ack = 2;
  const std::string s = armar(d);
  CHECK(s.find("\"ev\":[{\"t\":\"pump_on\",\"why\":\"auto\",\"ago\":95},"
               "{\"t\":\"pump_off\",\"why\":\"tiempo_max\",\"ago\":65,\"dur\":30},"
               "{\"t\":\"pump_on\",\"why\":\"manual\",\"ago\":0,\"cmd\":\"0b6c1a52\"}]") != std::string::npos);
  CHECK(s.find("\"acks\":[{\"id\":\"0b6c1a52-7c1e-4f0e-9a0c-2f3e7a9d1c11\",\"estado\":\"ejecutada\",\"detalle\":\"regando 20 s\"},"
               "{\"id\":\"otro-id\",\"estado\":\"rechazada\",\"detalle\":\"en espera entre riegos (faltan 143 s)\"}]") != std::string::npos);
  JsonDocument doc;
  CHECK(jsonValido(s, doc));
  CHECK_EQ((int)doc["ev"].size(), 3);
  CHECK_EQ(doc["ev"][1]["dur"].as<int>(), 30);
  CHECK(doc["ev"][0]["dur"].isNull());                   // pump_on no lleva "dur"
  CHECK_STR(doc["acks"][1]["estado"].as<const char*>(), "rechazada");
}

TEST(motivos_de_apagado_del_contrato) {
  const char* esperado[] = {"objetivo", "tiempo_max", "orden", "seguridad", "saturado"};
  for (uint8_t m = 0; m <= riego::OFF_SATURADO; m++) CHECK_STR(riego::nombreOff(m), esperado[m]);
  CHECK_STR(riego::nombreOn(riego::ON_AUTO), "auto");
  CHECK_STR(riego::nombreOn(riego::ON_MANUAL), "manual");
}

TEST(los_textos_se_escapan) {
  DatosTrama d = base();
  d.ack[0] = ack("id-1", false, "dijo \"hola\" \\ y\nnueva linea\ttab");
  d.n_ack = 1;
  d.fw = "1.0\"x";
  const std::string s = armar(d);
  JsonDocument doc;
  CHECK(jsonValido(s, doc));
  CHECK_STR(doc["acks"][0]["detalle"].as<const char*>(), "dijo \"hola\" \\ y\nnueva linea\ttab");
  CHECK_STR(doc["fw"].as<const char*>(), "1.0\"x");
}

TEST(formatos_numericos_extremos) {
  DatosTrama d = base();
  d.up = 4294967295u; d.seq = 4294967295u; d.temp = -0.04f; d.hum = 100.0f; d.suelo_raw = 0; d.rssi = -127; d.luz = 65535.0f;
  const std::string s = armar(d);
  CHECK(s.find("\"up\":4294967295") != std::string::npos);
  CHECK(s.find("\"seq\":4294967295") != std::string::npos);
  CHECK(s.find("\"temp\":-0.0") != std::string::npos);   // "-0.0" es JSON valido
  CHECK(s.find("\"hum_aire\":100.0") != std::string::npos);
  CHECK(s.find("\"suelo_raw\":0") != std::string::npos);
  CHECK(s.find("\"luz\":65535") != std::string::npos);
  JsonDocument doc;
  CHECK(jsonValido(s, doc));
  CHECK_EQ((long long)doc["seq"].as<uint32_t>(), 4294967295LL);
}

TEST(si_no_cabe_se_quitan_eventos_y_acuses_del_final) {
  DatosTrama d = base();
  for (int i = 0; i < 8; i++) { d.ev[i] = ev(i % 2 == 0, riego::OFF_ORDEN, 30, "cmd-largo-0123456789abcdef"); d.ev_ago_s[i] = 100 + i; }
  d.n_ev = 8;
  for (int i = 0; i < 8; i++) d.ack[i] = ack("ack-largo-0123456789abcdef", true, "regando 20 s");
  d.n_ack = 8;
  const std::string s = armar(d, 420);
  CHECK(!s.empty());
  CHECK(s.size() < 420);
  CHECK(d.n_ev < 8 || d.n_ack < 8);                      // se recorto algo
  JsonDocument doc;
  CHECK(jsonValido(s, doc));                             // y lo que sale sigue siendo JSON valido
  CHECK_EQ((int)doc["ev"].size(), (int)d.n_ev);          // n_ev / n_ack reflejan lo que realmente viajo
  const std::string chico = armar(d, 60);                // ni siquiera cabe la trama minima
  CHECK(chico.empty());
}

TEST(peor_caso_cabe_en_el_buffer_de_la_trama) {
  DatosTrama d = base();
  char cmd39[riego::ID_MAX], det55[riego::DETALLE_MAX];
  memset(cmd39, 'c', riego::ID_MAX - 1); cmd39[riego::ID_MAX - 1] = 0;
  memset(det55, 'd', riego::DETALLE_MAX - 1); det55[riego::DETALLE_MAX - 1] = 0;
  d.up = 4294967295u; d.seq = 4294967295u; d.boot = 4294967295u; d.riego_s = 4294967295u; d.esp = 4294967295u;
  d.temp = -39.9f; d.luz = 65535.0f; d.con_viento = true; d.viento_ok = true; d.viento = 45.0f;
  d.est = "bloq_sensor";
  d.fallas[0] = "suelo"; d.fallas[1] = "dht"; d.fallas[2] = "viento"; d.fallas[3] = "reinicio_wdt"; d.n_fallas = 4;
  for (int i = 0; i < 8; i++) { d.ev[i] = ev(false, riego::OFF_SATURADO, 65535, cmd39); d.ev_ago_s[i] = 86400; d.ack[i] = ack(cmd39, false, det55); }
  d.n_ev = 8; d.n_ack = 8;
  const std::string s = armar(d);
  printf("    (peor caso: %d bytes de %d)\n", (int)s.size(), (int)TX_MAX);
  CHECK(!s.empty());
  CHECK(s.size() < TX_MAX);
  CHECK_EQ(d.n_ev, 8);                                   // no hizo falta recortar nada
  CHECK_EQ(d.n_ack, 8);
  CHECK(s.size() < 4096);                                // el servidor acepta hasta 4 KB
}

/* ===================================================================== RESPUESTA */
static const char* RESPUESTA_CONTRATO =
  "{\"ok\":true,\"t\":\"2026-09-28T22:52:48Z\",\"cfg\":{\"ver\":3,\"intervalo_s\":300,\"suelo_on\":700,\"suelo_off\":500,"
  "\"suelo_sat\":300,\"temp_max\":40,\"riego_max_s\":30,\"espera_s\":300},\"ordenes\":[{\"id\":\"0b6c1a52-7c1e-4f0e-9a0c-2f3e7a9d1c11\","
  "\"tipo\":\"riego\",\"dur_s\":20,\"vence_s\":240}]}";

static bool parsea(const char* json, Respuesta& r, const riego::Config& actual = riego::configPorDefecto()) {
  return parsearRespuesta(json, strlen(json), actual, r);
}

TEST(respuesta_del_ejemplo_del_contrato) {
  Respuesta r;
  CHECK(parsea(RESPUESTA_CONTRATO, r));
  CHECK(r.ok);
  CHECK(!r.dup);
  CHECK(r.tiene_cfg);
  CHECK(!r.cfg_invalida);
  CHECK_EQ((long long)r.cfg.ver, 3);
  CHECK_EQ(r.cfg.intervalo_s, 300);
  CHECK_EQ(r.cfg.suelo_on, 700);
  CHECK_EQ(r.cfg.suelo_off, 500);
  CHECK_EQ(r.cfg.suelo_sat, 300);
  CHECK_NEAR(r.cfg.temp_max, 40.0, 1e-6);
  CHECK_EQ(r.cfg.riego_max_s, 30);
  CHECK_EQ(r.cfg.espera_s, 300);
  CHECK_EQ(r.n_ordenes, 1);
  CHECK_STR(r.ordenes[0].id, "0b6c1a52-7c1e-4f0e-9a0c-2f3e7a9d1c11");
  CHECK_EQ(r.ordenes[0].tipo, riego::ORDEN_RIEGO);
  CHECK_EQ(r.ordenes[0].dur_s, 20);
  CHECK_EQ((long long)r.ordenes[0].vence_s, 240);
  CHECK_EQ(r.ordenes_ignoradas, 0);
}

TEST(respuesta_dup_y_no_ok) {
  Respuesta r;
  CHECK(parsea("{\"ok\":true,\"dup\":true,\"cfg\":{\"ver\":1}}", r));
  CHECK(r.ok); CHECK(r.dup);
  CHECK(parsea("{\"ok\":false,\"error\":\"unauthorized\"}", r));
  CHECK(!r.ok);
  CHECK(!r.tiene_cfg);
  CHECK_EQ(r.n_ordenes, 0);
  CHECK(parsea("{}", r));
  CHECK(!r.ok);                                          // sin "ok": no se considera exito
}

TEST(cfg_parcial_del_nodo_del_mastil_conserva_el_resto) {
  riego::Config actual = riego::configPorDefecto();
  actual.ver = 2; actual.suelo_on = 800; actual.suelo_off = 600; actual.espera_s = 120;
  Respuesta r;
  CHECK(parsea("{\"ok\":true,\"cfg\":{\"ver\":7,\"intervalo_s\":60}}", r, actual));
  CHECK(r.tiene_cfg);
  CHECK(!r.cfg_invalida);
  CHECK_EQ((long long)r.cfg.ver, 7);
  CHECK_EQ(r.cfg.intervalo_s, 60);
  CHECK_EQ(r.cfg.suelo_on, 800);                          // lo que no vino se conserva
  CHECK_EQ(r.cfg.suelo_off, 600);
  CHECK_EQ(r.cfg.espera_s, 120);
}

TEST(cfg_invalida_se_marca_y_no_toca_la_vigente) {
  const char* malas[] = {
    "{\"ok\":true,\"cfg\":{\"ver\":1,\"suelo_on\":70000}}",                 // no cabe en 16 bits (no debe dar la vuelta a 4464)
    "{\"ok\":true,\"cfg\":{\"ver\":1,\"suelo_on\":\"700\"}}",               // texto en vez de numero
    "{\"ok\":true,\"cfg\":{\"ver\":1,\"suelo_on\":700.5}}",                 // decimal en un campo entero
    "{\"ok\":true,\"cfg\":{\"ver\":1,\"suelo_on\":-5}}",                    // negativo
    "{\"ok\":true,\"cfg\":{\"ver\":1,\"temp_max\":\"40\"}}",                // texto en vez de numero
    "{\"ok\":true,\"cfg\":{\"ver\":1,\"temp_max\":100}}",                   // fuera de 30..60
    "{\"ok\":true,\"cfg\":{\"ver\":1,\"suelo_off\":800}}",                  // off >= on
    "{\"ok\":true,\"cfg\":{\"ver\":1,\"riego_max_s\":121}}",
    "{\"ok\":true,\"cfg\":{\"ver\":1,\"espera_s\":59}}",
    "{\"ok\":true,\"cfg\":{\"ver\":1,\"intervalo_s\":4}}",
    "{\"ok\":true,\"cfg\":{\"ver\":\"tres\"}}",                             // version no numerica
    "{\"ok\":true,\"cfg\":{\"ver\":-1}}",
  };
  const riego::Config actual = riego::configPorDefecto();
  for (size_t i = 0; i < sizeof(malas) / sizeof(malas[0]); i++) {
    Respuesta r;
    const bool ok = parsea(malas[i], r, actual);
    if (!(ok && r.cfg_invalida)) printf("  no se marco invalida: %s\n", malas[i]);
    CHECK(ok);
    CHECK(r.tiene_cfg);
    CHECK(r.cfg_invalida);
    CHECK(riego::configIgual(r.cfg, actual));             // la configuracion resultante es la vigente
  }
}

TEST(ordenes_variadas_y_hostiles) {
  Respuesta r;
  CHECK(parsea(
    "{\"ok\":true,\"ordenes\":["
    "{\"id\":\"a1\",\"tipo\":\"riego\",\"dur_s\":25,\"vence_s\":60},"
    "{\"id\":\"a2\",\"tipo\":\"parar\",\"vence_s\":30},"
    "{\"id\":\"a3\",\"tipo\":\"reiniciar\",\"vence_s\":30},"
    "{\"id\":\"a b\",\"tipo\":\"parar\",\"vence_s\":30},"
    "{\"id\":\"x\\\"y\",\"tipo\":\"parar\",\"vence_s\":30},"
    "{\"tipo\":\"parar\",\"vence_s\":30},"
    "\"no soy un objeto\","
    "{\"id\":\"a4\",\"tipo\":\"riego\",\"vence_s\":30}"
    "]}", r));
  CHECK_EQ(r.n_ordenes, 4);                               // a1, a2, a3 (tipo desconocido) y a4
  CHECK_EQ(r.ordenes_ignoradas, 4);                       // id con espacio, id con comillas, sin id, no-objeto
  CHECK_STR(r.ordenes[0].id, "a1");  CHECK_EQ(r.ordenes[0].tipo, riego::ORDEN_RIEGO);  CHECK_EQ(r.ordenes[0].dur_s, 25);
  CHECK_STR(r.ordenes[1].id, "a2");  CHECK_EQ(r.ordenes[1].tipo, riego::ORDEN_PARAR);
  CHECK_STR(r.ordenes[2].id, "a3");  CHECK_EQ(r.ordenes[2].tipo, riego::ORDEN_DESCONOCIDA);   // se rechazara con un acuse
  CHECK_STR(r.ordenes[3].id, "a4");  CHECK_EQ(r.ordenes[3].dur_s, 0);                          // sin dur_s: el controlador la rechaza
}

TEST(orden_con_campos_mal_formados_es_segura) {
  Respuesta r;
  CHECK(parsea(
    "{\"ok\":true,\"ordenes\":["
    "{\"id\":\"s1\",\"tipo\":\"riego\",\"dur_s\":\"20\",\"vence_s\":60},"      // dur_s como texto
    "{\"id\":\"s2\",\"tipo\":\"riego\",\"dur_s\":20.5,\"vence_s\":60},"        // dur_s decimal
    "{\"id\":\"s3\",\"tipo\":\"riego\",\"dur_s\":70000,\"vence_s\":60},"       // dur_s fuera de 16 bits
    "{\"id\":\"s4\",\"tipo\":\"riego\",\"dur_s\":20},"                         // sin vence_s
    "{\"id\":\"s5\",\"tipo\":\"riego\",\"dur_s\":20,\"vence_s\":-1}"           // vence_s negativo
    "]}", r));
  CHECK_EQ(r.n_ordenes, 4);                               // tope de 4 ordenes por respuesta
  CHECK_EQ(r.ordenes_ignoradas, 1);
  CHECK_EQ(r.ordenes[0].dur_s, 0);                        // todas quedan con dur_s = 0 => "duracion invalida"
  CHECK_EQ(r.ordenes[1].dur_s, 0);
  CHECK_EQ(r.ordenes[2].dur_s, 0);
  CHECK_EQ((long long)r.ordenes[3].vence_s, 0);           // sin vence_s => vencida (lado seguro)
}

TEST(no_es_json_o_no_es_objeto) {
  Respuesta r;
  CHECK(!parsea("", r));
  CHECK(!parsea("{\"ok\":tr", r));
  CHECK(!parsea("[1,2,3]", r));
  CHECK(!parsea("\"texto\"", r));
  CHECK(!parsea("<html>portal cautivo</html>", r));
  CHECK(parsea("{\"ok\":true,\"campo_nuevo\":{\"x\":[1,2,3]}}", r));   // campos desconocidos se ignoran
  CHECK(r.ok);
}

TEST(identificadores_de_orden) {
  CHECK(idValido("0b6c1a52-7c1e-4f0e-9a0c-2f3e7a9d1c11"));
  CHECK(idValido("cmd_1-A"));
  CHECK(!idValido(""));
  CHECK(!idValido(nullptr));
  CHECK(!idValido("con espacio"));
  CHECK(!idValido("comilla\""));
  CHECK(!idValido("acentu\xc3\xa1"));
  char largo[64]; memset(largo, 'a', 39); largo[39] = 0;
  CHECK(idValido(largo));                                  // 39 caracteres: cabe
  largo[39] = 'a'; largo[40] = 0;
  CHECK(!idValido(largo));                                 // 40: no cabe
}

TEST(la_configuracion_recibida_pasa_por_el_controlador) {
  /* De punta a punta: respuesta del servidor -> controlador -> comportamiento. */
  riego::Controlador c;
  c.iniciar(1000, false);
  Respuesta r;
  CHECK(parsea("{\"ok\":true,\"cfg\":{\"ver\":5,\"suelo_on\":800,\"suelo_off\":600,\"suelo_sat\":300,\"temp_max\":35,\"riego_max_s\":20,\"espera_s\":120,\"intervalo_s\":10}}", r, c.config()));
  CHECK(!r.cfg_invalida);
  CHECK(c.aplicarConfig(r.cfg));
  CHECK_EQ(c.config().suelo_on, 800);
  CHECK_EQ(c.config().riego_max_s, 20);
  CHECK_EQ(c.config().intervalo_s, 10);
}

int main() { return correr(); }
