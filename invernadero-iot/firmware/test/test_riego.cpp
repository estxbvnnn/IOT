/* test_riego.cpp - pruebas del controlador de riego (riego.h) en el PC.
   Sin frameworks: solo mini_test.h. Ver README.md para compilar y ejecutar.

   El controlador recibe el tiempo como parametro, asi que aqui el "reloj" es una variable:
   se puede simular horas de operacion en milisegundos de CPU y cruzar el desborde de millis(). */
#define _CRT_SECURE_NO_WARNINGS   // MSVC: permite strncpy/strcpy en las ayudas de prueba
#include "mini_test.h"
#include "riego.h"
#include <stdlib.h>

using namespace riego;

/* ---------- ayudas ---------- */
static Lectura L(int raw, float t = 25.0f) {
  Lectura l; l.suelo_ok = true; l.suelo_raw = raw; l.temp_ok = true; l.temp = t; return l;
}
static Lectura LSueloMalo(float t = 25.0f) { Lectura l = L(0, t); l.suelo_ok = false; return l; }
static Lectura LTempMala(int raw)          { Lectura l = L(raw); l.temp_ok = false; return l; }

struct Banco {
  Controlador c;
  uint32_t ahora;
  explicit Banco(uint32_t t0 = 1000u) : ahora(t0) { c.iniciar(t0, false); }

  /* Avanza el reloj llamando a tick() cada "paso" ms (como hace loop() cada ~10-100 ms). */
  void avanza(uint32_t ms, uint32_t paso = 100) {
    const uint32_t fin = ahora + ms;
    while ((int32_t)(fin - ahora) > 0) {
      uint32_t p = fin - ahora;
      if (p > paso) p = paso;
      ahora += p;
      c.tick(ahora);
    }
  }
  void lee(int raw, float t = 25.0f) { c.nuevaLectura(L(raw, t), ahora); }
  void lee(const Lectura& l) { c.nuevaLectura(l, ahora); }

  ResultadoOrden orden(const char* id, TipoOrden tipo, uint16_t dur = 0, uint32_t vence_s = 60, uint32_t hace_ms = 0) {
    Orden o; memset(&o, 0, sizeof(o));
    strncpy(o.id, id, ID_MAX - 1);
    o.tipo = tipo; o.dur_s = dur; o.vence_s = vence_s; o.recibida_ms = ahora - hace_ms;
    return c.atenderOrden(o, ahora);
  }
  const Evento& ultimoEvento() const { return c.evento((uint8_t)(c.eventosPendientes() - 1)); }
  const AckOrden& ultimoAck() const { return c.ack((uint8_t)(c.acksPendientes() - 1)); }
};

/* Lleva el controlador a "bomba encendida por riego automatico" y devuelve el banco listo. */
static void arrancaAuto(Banco& b) { b.lee(800); }

/* ===================================================================== */
TEST(arranque_seguro) {
  Banco b;
  CHECK(!b.c.bombaEncendida());
  CHECK_EQ(b.c.eventosPendientes(), 0);
  CHECK_EQ(b.c.acksPendientes(), 0);
  CHECK_EQ(b.c.estado(), EST_BLOQ_SENSOR);          // aun no hay lectura: no se decide nada
  CHECK(configValida(b.c.config()));
  CHECK_EQ(b.c.esperaRestanteS(), 0);
  b.avanza(120000);                                   // sin lecturas, la bomba sigue apagada
  CHECK(!b.c.bombaEncendida());
}

TEST(arranque_tras_riego_interrumpido) {
  Controlador c;
  c.iniciar(5000, true);                              // el nodo se reinicio con la bomba encendida
  CHECK(!c.bombaEncendida());
  CHECK_EQ(c.esperaRestanteS(), 300);                 // parte con la espera activa
  CHECK_EQ(c.eventosPendientes(), 1);
  CHECK(!c.evento(0).encendido);
  CHECK_EQ(c.evento(0).motivo, OFF_SEGURIDAD);
  c.nuevaLectura(L(800), 5100);                       // seco, pero hay que esperar
  CHECK(!c.bombaEncendida());
  CHECK_EQ(c.estado(), EST_ESPERA);
  uint32_t t = 5100;
  for (int i = 0; i < 3000; i++) { t += 100; c.tick(t); }   // 300 s
  CHECK(c.quiereMuestraYa());                         // terminada la espera con demanda: pide medir de nuevo
  c.nuevaLectura(L(800), t);
  CHECK(c.bombaEncendida());
}

TEST(banda_del_suelo_segun_la_imagen) {
  Controlador c;
  CHECK_EQ(c.banda(0),    BANDA_SATURADO);
  CHECK_EQ(c.banda(299),  BANDA_SATURADO);
  CHECK_EQ(c.banda(300),  BANDA_OPTIMO);
  CHECK_EQ(c.banda(699),  BANDA_OPTIMO);
  CHECK_EQ(c.banda(700),  BANDA_SECO);
  CHECK_EQ(c.banda(1023), BANDA_SECO);
  CHECK_STR(nombreBanda(BANDA_SATURADO), "SATURADO");
  CHECK_STR(nombreBanda(BANDA_OPTIMO), "OPTIMO");
  CHECK_STR(nombreBanda(BANDA_SECO), "SECO");
}

TEST(histeresis_inicio_y_fin) {
  Banco b;
  b.lee(650);                                         // entre suelo_off (500) y suelo_on (700): no inicia
  CHECK(!b.c.bombaEncendida());
  CHECK_EQ(b.c.estado(), EST_IDLE);
  b.lee(699);
  CHECK(!b.c.bombaEncendida());
  b.lee(700);                                         // limite inclusivo: 700 ya es SECO
  CHECK(b.c.bombaEncendida());
  CHECK(b.ultimoEvento().encendido);
  CHECK_EQ(b.ultimoEvento().motivo, ON_AUTO);
  b.avanza(5000); b.lee(650);                         // dentro de la banda de histeresis: sigue regando
  CHECK(b.c.bombaEncendida());
  b.avanza(5000); b.lee(501);
  CHECK(b.c.bombaEncendida());
  b.avanza(5000); b.lee(500);                         // llego al objetivo (<= suelo_off)
  CHECK(!b.c.bombaEncendida());
  CHECK(!b.ultimoEvento().encendido);
  CHECK_EQ(b.ultimoEvento().motivo, OFF_OBJETIVO);
  CHECK_EQ(b.ultimoEvento().dur_s, 15);
  b.avanza(300000);                                   // termina la espera
  CHECK(!b.c.quiereMuestraYa());                      // la ultima lectura no pedia riego: no hace falta medir ya
  b.lee(699);
  CHECK(!b.c.bombaEncendida());
  b.lee(700);
  CHECK(b.c.bombaEncendida());
}

TEST(corte_por_tiempo_exacto_con_bucle_de_100ms) {
  Banco b;
  arrancaAuto(b);
  CHECK(b.c.bombaEncendida());
  b.avanza(29900);
  CHECK(b.c.bombaEncendida());                        // 29,9 s: aun encendida
  CHECK_EQ(b.c.riegoS(), 29);
  b.avanza(100);                                      // 30,0 s: corte
  CHECK(!b.c.bombaEncendida());
  CHECK_EQ(b.ultimoEvento().motivo, OFF_TIEMPO_MAX);
  CHECK_EQ(b.ultimoEvento().dur_s, 30);
}

TEST(corte_por_tiempo_aunque_las_lecturas_sigan_secas) {
  Banco b;
  arrancaAuto(b);
  for (int i = 0; i < 5; i++) { b.avanza(5000); if (b.c.bombaEncendida()) b.lee(800); }   // sigue seco
  CHECK(b.c.bombaEncendida());                        // a los 25 s todavia regando
  b.avanza(5000);
  CHECK(!b.c.bombaEncendida());
  CHECK_EQ(b.ultimoEvento().motivo, OFF_TIEMPO_MAX);
}

TEST(corte_por_tiempo_sin_ninguna_lectura_nueva) {
  Banco b;
  arrancaAuto(b);
  b.avanza(30000);                                    // solo tick(): el corte NO depende de las lecturas
  CHECK(!b.c.bombaEncendida());
}

TEST(corte_inmediato_tras_un_retraso_grande_del_bucle) {
  Banco b;
  arrancaAuto(b);
  b.ahora += 45000;                                   // el bucle estuvo detenido 45 s
  b.c.tick(b.ahora);
  CHECK(!b.c.bombaEncendida());                       // en la primera vuelta que ocurre, corta
  CHECK_EQ(b.ultimoEvento().motivo, OFF_TIEMPO_MAX);
  CHECK_EQ(b.ultimoEvento().dur_s, 45);               // y se informa el tiempo REAL, no el limite
}

TEST(corte_por_tiempo_respeta_un_maximo_reducido_durante_el_riego) {
  Banco b;
  arrancaAuto(b);
  b.avanza(12000);
  Config c = b.c.config(); c.ver = 2; c.riego_max_s = 10;
  CHECK(b.c.aplicarConfig(c));
  b.avanza(100);
  CHECK(!b.c.bombaEncendida());                       // ya llevaba 12 s: corta en la siguiente vuelta
  CHECK_EQ(b.ultimoEvento().motivo, OFF_TIEMPO_MAX);
}

TEST(espera_entre_riegos_y_medicion_inmediata) {
  Banco b;
  arrancaAuto(b);
  b.avanza(30000);                                    // corte por tiempo
  CHECK(!b.c.bombaEncendida());
  b.avanza(100000);
  b.lee(800);                                         // sigue seco, pero el motor descansa
  CHECK(!b.c.bombaEncendida());
  CHECK_EQ(b.c.estado(), EST_ESPERA);
  CHECK_EQ(b.c.esperaRestanteS(), 200);
  b.avanza(199900);
  CHECK(!b.c.bombaEncendida());
  CHECK_EQ(b.c.esperaRestanteS(), 1);                 // redondeo hacia arriba
  CHECK(!b.c.quiereMuestraYa());
  b.avanza(100);                                      // 300 s desde el fin del riego
  CHECK_EQ(b.c.esperaRestanteS(), 0);
  CHECK(!b.c.bombaEncendida());                       // NO arranca sola con una lectura vieja...
  CHECK(b.c.quiereMuestraYa());                       // ...pide medir de nuevo, una sola vez
  CHECK(!b.c.quiereMuestraYa());
  b.lee(800);
  CHECK(b.c.bombaEncendida());
}

TEST(bloqueo_por_temperatura) {
  Banco b;
  b.lee(800, 41.0f);
  CHECK(!b.c.bombaEncendida());
  CHECK_EQ(b.c.estado(), EST_BLOQ_TEMP);
  b.lee(800, 40.1f);
  CHECK(!b.c.bombaEncendida());
  b.lee(800, 40.0f);                                  // igual a temp_max: no bloquea
  CHECK(b.c.bombaEncendida());
  b.avanza(5000);
  b.lee(800, 55.0f);                                  // la temperatura solo IMPIDE INICIAR: no corta un riego en curso
  CHECK(b.c.bombaEncendida());
}

TEST(bloqueo_por_temperatura_invalida) {
  Banco b;
  b.lee(LTempMala(800));
  CHECK(!b.c.bombaEncendida());
  CHECK_EQ(b.c.estado(), EST_BLOQ_TEMP);
  Lectura nan = L(800); nan.temp = NAN;               // temp_ok=true pero con un NaN: se descarta igual
  b.lee(nan);
  CHECK(!b.c.bombaEncendida());
  Lectura fuera = L(800, 81.0f);                      // fuera del rango del DHT22
  b.lee(fuera);
  CHECK(!b.c.bombaEncendida());
  b.lee(L(650, 41.0f));                               // sin demanda de riego el bloqueo no se informa
  CHECK_EQ(b.c.estado(), EST_IDLE);
}

TEST(suelo_saturado_no_riega_y_rechaza_ordenes) {
  Banco b;
  b.lee(250);
  CHECK(!b.c.bombaEncendida());
  CHECK_EQ(b.c.estado(), EST_SATURADO);
  const ResultadoOrden r = b.orden("sat-1", ORDEN_RIEGO, 20);
  CHECK(!r.ejecutada);
  CHECK_STR(r.detalle, "suelo saturado");
  CHECK(!b.c.bombaEncendida());
  b.lee(299);
  CHECK_EQ(b.c.estado(), EST_SATURADO);
  b.lee(300);
  CHECK_EQ(b.c.estado(), EST_IDLE);                   // 300 ya es OPTIMO
}

TEST(sensor_de_suelo_invalido) {
  Banco b;
  b.lee(LSueloMalo());
  CHECK(!b.c.bombaEncendida());
  CHECK_EQ(b.c.estado(), EST_BLOQ_SENSOR);
  Banco b2;
  arrancaAuto(b2);
  b2.avanza(5000);
  b2.lee(LSueloMalo());                               // falla del sensor durante el riego: corta
  CHECK(!b2.c.bombaEncendida());
  CHECK_EQ(b2.ultimoEvento().motivo, OFF_SEGURIDAD);
  b.lee(1024);                                        // lectura imposible: se trata como sensor invalido
  CHECK_EQ(b.c.estado(), EST_BLOQ_SENSOR);
  b.lee(-1);
  CHECK_EQ(b.c.estado(), EST_BLOQ_SENSOR);
}

TEST(orden_manual_aceptada_y_terminada_por_orden) {
  Banco b;
  b.lee(650);
  const ResultadoOrden r = b.orden("cmd-1", ORDEN_RIEGO, 20);
  CHECK(r.ejecutada);
  CHECK(!r.ignorada);
  CHECK_STR(r.detalle, "regando 20 s");
  CHECK(b.c.bombaEncendida());
  CHECK_EQ(b.c.eventosPendientes(), 1);
  CHECK(b.ultimoEvento().encendido);
  CHECK_EQ(b.ultimoEvento().motivo, ON_MANUAL);
  CHECK_STR(b.ultimoEvento().cmd, "cmd-1");
  CHECK_EQ(b.c.acksPendientes(), 1);
  CHECK_STR(b.ultimoAck().id, "cmd-1");
  CHECK(b.ultimoAck().ejecutada);
  b.avanza(19900);
  CHECK(b.c.bombaEncendida());
  b.avanza(100);
  CHECK(!b.c.bombaEncendida());
  CHECK(!b.ultimoEvento().encendido);
  CHECK_EQ(b.ultimoEvento().motivo, OFF_ORDEN);
  CHECK_EQ(b.ultimoEvento().dur_s, 20);
  CHECK_STR(b.ultimoEvento().cmd, "cmd-1");
}

TEST(orden_manual_no_termina_por_objetivo_de_humedad) {
  Banco b;
  b.lee(650);
  b.orden("cmd-2", ORDEN_RIEGO, 20);
  b.avanza(5000); b.lee(400);                         // ya en OPTIMO: el operador decidio regar 20 s
  CHECK(b.c.bombaEncendida());
  b.avanza(5000); b.lee(310);
  CHECK(b.c.bombaEncendida());
  b.avanza(5000); b.lee(250);                         // pero al llegar a SATURADO si corta
  CHECK(!b.c.bombaEncendida());
  CHECK_EQ(b.ultimoEvento().motivo, OFF_SATURADO);
}

TEST(orden_rechazada_si_ya_esta_regando) {
  Banco b;
  b.lee(650);
  b.orden("a", ORDEN_RIEGO, 20);
  const ResultadoOrden r = b.orden("b", ORDEN_RIEGO, 20);
  CHECK(!r.ejecutada);
  CHECK_STR(r.detalle, "ya esta regando");
  CHECK_EQ(b.c.acksPendientes(), 2);
  CHECK(!b.ultimoAck().ejecutada);
  CHECK_STR(b.ultimoAck().id, "b");
}

TEST(orden_rechazada_en_espera_entre_riegos) {
  Banco b;
  b.lee(650);
  b.orden("a", ORDEN_RIEGO, 10);
  b.avanza(10000);                                    // termino
  b.avanza(60000);                                    // pasaron 60 s de los 300 s de espera
  const ResultadoOrden r = b.orden("b", ORDEN_RIEGO, 10);
  CHECK(!r.ejecutada);
  CHECK_STR(r.detalle, "en espera entre riegos (faltan 240 s)");
  CHECK(!b.c.bombaEncendida());
  b.avanza(240000);
  const ResultadoOrden r2 = b.orden("c", ORDEN_RIEGO, 10);   // terminada la espera si se acepta
  CHECK(r2.ejecutada);
}

TEST(orden_vencida) {
  Banco b;
  b.lee(650);
  const ResultadoOrden r = b.orden("v1", ORDEN_RIEGO, 20, /*vence_s=*/5, /*hace_ms=*/10000);   // llego hace 10 s, vale 5 s
  CHECK(!r.ejecutada);
  CHECK_STR(r.detalle, "vencida");
  const ResultadoOrden r0 = b.orden("v2", ORDEN_RIEGO, 20, /*vence_s=*/0);
  CHECK(!r0.ejecutada);
  CHECK_STR(r0.detalle, "vencida");
  const ResultadoOrden ok = b.orden("v3", ORDEN_RIEGO, 20, /*vence_s=*/5, /*hace_ms=*/4900);
  CHECK(ok.ejecutada);                                // aun dentro de su plazo
  CHECK(b.c.bombaEncendida());
}

TEST(orden_con_duracion_invalida_o_acortada) {
  Banco b;
  b.lee(650);
  CHECK(!b.orden("d0", ORDEN_RIEGO, 0).ejecutada);
  CHECK(!b.orden("d4", ORDEN_RIEGO, 4).ejecutada);
  CHECK(!b.orden("d121", ORDEN_RIEGO, 121).ejecutada);
  CHECK(!b.c.bombaEncendida());
  const ResultadoOrden r = b.orden("d100", ORDEN_RIEGO, 100);     // valida (<=120) pero mayor que riego_max_s (30)
  CHECK(r.ejecutada);
  CHECK_STR(r.detalle, "regando 30 s (acortada por el maximo)");
  b.avanza(29900);
  CHECK(b.c.bombaEncendida());
  b.avanza(100);
  CHECK(!b.c.bombaEncendida());
  CHECK_EQ(b.ultimoEvento().dur_s, 30);
  CHECK_EQ(b.ultimoEvento().motivo, OFF_ORDEN);       // termino el tiempo aceptado de la orden

  Banco b5;                                           // limite inferior valido: 5 s
  b5.lee(650);
  CHECK(b5.orden("d5", ORDEN_RIEGO, 5).ejecutada);
  b5.avanza(5000);
  CHECK(!b5.c.bombaEncendida());
}

TEST(orden_riego_maximo_permitido_120s_se_acota_al_maximo_configurado) {
  Banco b;
  Config c = b.c.config(); c.ver = 1; c.riego_max_s = 120;
  CHECK(b.c.aplicarConfig(c));
  b.lee(650);
  const ResultadoOrden r = b.orden("d120", ORDEN_RIEGO, 120);
  CHECK(r.ejecutada);
  CHECK_STR(r.detalle, "regando 120 s");
  b.avanza(119900);
  CHECK(b.c.bombaEncendida());
  b.avanza(100);
  CHECK(!b.c.bombaEncendida());
}

TEST(orden_parar) {
  Banco b;
  arrancaAuto(b);
  b.avanza(10000);
  const ResultadoOrden r = b.orden("p1", ORDEN_PARAR);
  CHECK(r.ejecutada);
  CHECK_STR(r.detalle, "bomba apagada");
  CHECK(!b.c.bombaEncendida());
  CHECK_EQ(b.ultimoEvento().motivo, OFF_ORDEN);
  CHECK_EQ(b.ultimoEvento().dur_s, 10);
  CHECK_STR(b.ultimoEvento().cmd, "p1");
  const ResultadoOrden r2 = b.orden("p2", ORDEN_PARAR);          // ya estaba apagada
  CHECK(r2.ejecutada);
  CHECK_STR(r2.detalle, "ya estaba apagada");
  /* Detener es la direccion segura: se ejecuta aunque la orden ya haya vencido. */
  Banco c;
  arrancaAuto(c);
  const ResultadoOrden r3 = c.orden("p3", ORDEN_PARAR, 0, /*vence_s=*/0);
  CHECK(r3.ejecutada);
  CHECK(!c.c.bombaEncendida());
}

TEST(orden_duplicada_no_se_ejecuta_ni_se_acusa_de_nuevo) {
  Banco b;
  b.lee(650);
  const ResultadoOrden r1 = b.orden("dup-1", ORDEN_RIEGO, 10);
  CHECK(r1.ejecutada);
  CHECK_EQ(b.c.acksPendientes(), 1);
  CHECK_EQ(b.c.eventosPendientes(), 1);
  const ResultadoOrden r2 = b.orden("dup-1", ORDEN_RIEGO, 10);   // el servidor la reentrego
  CHECK(r2.ignorada);
  CHECK_EQ(b.c.acksPendientes(), 1);                             // sin acuse nuevo
  CHECK_EQ(b.c.eventosPendientes(), 1);                          // sin evento nuevo
  b.avanza(10000);
  const uint8_t n_ev = b.c.eventosPendientes();
  const ResultadoOrden r3 = b.orden("dup-1", ORDEN_RIEGO, 10);   // tampoco despues de terminar
  CHECK(r3.ignorada);
  CHECK_EQ(b.c.eventosPendientes(), n_ev);
  CHECK(!b.c.bombaEncendida());
  /* Tambien se recuerdan las ordenes rechazadas. */
  Banco s;
  s.lee(250);
  CHECK(!s.orden("rej-1", ORDEN_RIEGO, 10).ejecutada);
  s.lee(650);
  CHECK(s.orden("rej-1", ORDEN_RIEGO, 10).ignorada);
}

TEST(memoria_de_ordenes_recuerda_las_ultimas_ocho) {
  Banco b;
  char id[16];
  for (int i = 0; i < 9; i++) { snprintf(id, sizeof(id), "id-%d", i); b.orden(id, ORDEN_PARAR); }
  CHECK(b.orden("id-8", ORDEN_PARAR).ignorada);       // la mas reciente sigue recordada
  CHECK(b.orden("id-1", ORDEN_PARAR).ignorada);       // la 2.a mas antigua tambien (8 recordadas: id-1..id-8)
  CHECK(!b.orden("id-0", ORDEN_PARAR).ignorada);      // id-0 fue desplazada por la 9.a
}

TEST(orden_desconocida_y_orden_local_y_nodo_sin_bomba) {
  Banco b;
  b.lee(650);
  Orden o; memset(&o, 0, sizeof(o));
  strcpy(o.id, "x1"); o.tipo = ORDEN_DESCONOCIDA; o.vence_s = 30; o.recibida_ms = b.ahora;
  const ResultadoOrden r = b.c.atenderOrden(o, b.ahora);
  CHECK(!r.ejecutada);
  CHECK_STR(r.detalle, "tipo de orden desconocido");
  CHECK_EQ(b.c.acksPendientes(), 1);

  /* Orden local (consola Serie, id vacio): sin dedupe y sin acuse. */
  const uint8_t acks = b.c.acksPendientes();
  CHECK(b.orden("", ORDEN_RIEGO, 5).ejecutada);
  b.avanza(5000);
  b.avanza(300000);
  CHECK(b.orden("", ORDEN_RIEGO, 5).ejecutada);       // se puede repetir
  CHECK_EQ(b.c.acksPendientes(), acks);

  Banco m;                                            // nodo del mastil
  m.c.sinBomba(true);
  m.lee(650);
  const ResultadoOrden rm = m.orden("m1", ORDEN_RIEGO, 20);
  CHECK(!rm.ejecutada);
  CHECK_STR(rm.detalle, "nodo sin bomba");
  CHECK(!m.c.bombaEncendida());
  CHECK(m.orden("m2", ORDEN_PARAR).ejecutada);
}

TEST(orden_manual_con_sensor_invalido_no_se_corta_por_suelo) {
  Banco b;
  b.lee(LSueloMalo());
  const ResultadoOrden r = b.orden("ms-1", ORDEN_RIEGO, 20);
  CHECK(r.ejecutada);                                 // el operador decide
  CHECK_STR(r.detalle, "regando 20 s (suelo sin lectura)");
  b.avanza(5000); b.lee(LSueloMalo());
  CHECK(b.c.bombaEncendida());                        // no se corta por la falla que ya existia
  b.avanza(15000);
  CHECK(!b.c.bombaEncendida());
  CHECK_EQ(b.ultimoEvento().motivo, OFF_ORDEN);

  Banco s;                                            // sensor valido al aceptar y falla despues: si corta
  s.lee(650);
  s.orden("ms-2", ORDEN_RIEGO, 20);
  s.avanza(5000); s.lee(LSueloMalo());
  CHECK(!s.c.bombaEncendida());
  CHECK_EQ(s.ultimoEvento().motivo, OFF_SEGURIDAD);

  Banco n;                                            // orden antes de la primera lectura
  CHECK(n.orden("ms-3", ORDEN_RIEGO, 10).ejecutada);
}

TEST(configuracion_invalida_se_ignora_completa) {
  Banco b;
  const Config base = b.c.config();
  Config c;
  struct Caso { const char* nombre; Config cfg; };
  std::vector<Caso> malos;
  #define MAL(nom, expr) c = base; c.ver = 9; expr; malos.push_back({nom, c});
  MAL("intervalo 4",        c.intervalo_s = 4)
  MAL("intervalo 3601",     c.intervalo_s = 3601)
  MAL("suelo_off >= on",    c.suelo_off = 700)
  MAL("suelo_off > on",     c.suelo_off = 800)
  MAL("suelo_sat >= off",   c.suelo_sat = 500)
  MAL("suelo_sat = 0",      c.suelo_sat = 0)
  MAL("suelo_on 1024",      c.suelo_on = 1024)
  MAL("temp_max 29.9",      c.temp_max = 29.9f)
  MAL("temp_max 60.1",      c.temp_max = 60.1f)
  MAL("temp_max NaN",       c.temp_max = NAN)
  MAL("riego_max 4",        c.riego_max_s = 4)
  MAL("riego_max 121",      c.riego_max_s = 121)
  MAL("espera 59",          c.espera_s = 59)
  MAL("espera 3601",        c.espera_s = 3601)
  #undef MAL
  for (size_t i = 0; i < malos.size(); i++) {
    const bool aplicada = b.c.aplicarConfig(malos[i].cfg);
    if (aplicada) printf("  la configuracion \"%s\" NO debio aplicarse\n", malos[i].nombre);
    CHECK(!aplicada);
    CHECK(configIgual(b.c.config(), base));           // la vigente no cambio
  }
  /* Limites validos (incluidos los extremos). */
  Config ok = base; ok.ver = 3;
  ok.intervalo_s = 5;     CHECK(b.c.aplicarConfig(ok));
  ok.intervalo_s = 3600;  CHECK(b.c.aplicarConfig(ok));
  ok.riego_max_s = 5;     CHECK(b.c.aplicarConfig(ok));
  ok.riego_max_s = 120;   CHECK(b.c.aplicarConfig(ok));
  ok.espera_s = 60;       CHECK(b.c.aplicarConfig(ok));
  ok.espera_s = 3600;     CHECK(b.c.aplicarConfig(ok));
  ok.temp_max = 30.0f;    CHECK(b.c.aplicarConfig(ok));
  ok.temp_max = 60.0f;    CHECK(b.c.aplicarConfig(ok));
  ok.suelo_sat = 1; ok.suelo_off = 2; ok.suelo_on = 1023;  CHECK(b.c.aplicarConfig(ok));
}

TEST(configuracion_valida_cambia_el_comportamiento) {
  Banco b;
  Config c = b.c.config(); c.ver = 4; c.suelo_on = 800; c.suelo_off = 600; c.temp_max = 35.0f; c.espera_s = 120;
  CHECK(b.c.aplicarConfig(c));
  b.lee(750);
  CHECK(!b.c.bombaEncendida());                       // 750 ya no es "seco" con suelo_on = 800
  b.lee(800, 36.0f);
  CHECK(!b.c.bombaEncendida());                       // 36 C > temp_max = 35
  b.lee(800, 35.0f);
  CHECK(b.c.bombaEncendida());
  b.avanza(5000); b.lee(601);
  CHECK(b.c.bombaEncendida());
  b.avanza(5000); b.lee(600);                         // nuevo objetivo
  CHECK(!b.c.bombaEncendida());
  CHECK_EQ(b.c.esperaRestanteS(), 120);
}

TEST(desborde_de_millis_durante_un_ciclo_completo) {
  Banco b(0xFFFFFFFFu - 60000u);                      // 60 s antes del desborde de millis()
  arrancaAuto(b);
  b.avanza(30000);
  CHECK(!b.c.bombaEncendida());
  uint32_t previo = b.c.esperaRestanteS();
  CHECK_EQ(previo, 300);
  for (int i = 0; i < 29; i++) {                      // la espera de 300 s cruza el desborde
    b.avanza(10000);
    const uint32_t r = b.c.esperaRestanteS();
    CHECK(r < previo);
    previo = r;
  }
  CHECK(b.ahora < 0x80000000u);                       // efectivamente ya se desbordo
  CHECK_EQ(b.c.esperaRestanteS(), 10);
  b.avanza(10000);
  CHECK(b.c.quiereMuestraYa());
  b.lee(800);
  CHECK(b.c.bombaEncendida());
}

TEST(desborde_de_millis_en_medio_de_un_riego) {
  Banco b(0xFFFFFFFFu - 10000u);
  arrancaAuto(b);
  b.avanza(29900);                                    // el desborde ocurre a los 10 s de riego
  CHECK(b.ahora < 0x80000000u);
  CHECK(b.c.bombaEncendida());
  b.avanza(100);                                      // 30 s: corte, ya del otro lado del desborde
  CHECK(!b.c.bombaEncendida());
  CHECK_EQ(b.ultimoEvento().dur_s, 30);
  CHECK_EQ(b.ultimoEvento().motivo, OFF_TIEMPO_MAX);
}

TEST(reloj_de_64_bits_no_confunde_dias_de_inactividad) {
  Banco b(0xFFFFFF00u);
  arrancaAuto(b);
  b.avanza(30000);
  b.avanza(400000);                                   // espera cumplida
  for (int i = 0; i < 24 * 60; i++) b.avanza(3600000UL, 3600000UL);   // 60 dias en pasos de 1 hora
  CHECK(b.c.uptimeS() > 4294967UL);                   // mas de 49,7 dias de funcionamiento
  CHECK_EQ(b.c.esperaRestanteS(), 0);
  b.lee(800);
  CHECK(b.c.bombaEncendida());                        // no queda bloqueado por una "espera fantasma"
}

TEST(marcas_de_tiempo_hacia_atras_se_ignoran) {
  Banco b;
  arrancaAuto(b);
  b.avanza(10000);
  const uint32_t up = b.c.uptimeS();
  b.c.tick(b.ahora - 5000);                           // un millis() viejo: no debe mover el reloj interno
  b.c.nuevaLectura(L(800), b.ahora - 3000);
  CHECK_EQ(b.c.uptimeS(), up);
  CHECK(b.c.bombaEncendida());
  b.avanza(19900);
  CHECK(b.c.bombaEncendida());                        // el corte sigue ocurriendo a los 30 s reales
  b.avanza(100);
  CHECK(!b.c.bombaEncendida());
}

TEST(colas_de_eventos_y_acuses_maximo_ocho) {
  Banco b;
  for (int i = 0; i < 5; i++) { arrancaAuto(b); b.avanza(30000); b.avanza(300000); }   // 5 ciclos = 10 eventos
  CHECK_EQ(b.c.eventosPendientes(), 8);               // tope
  CHECK_EQ(b.c.evento(0).seq, 3);                     // los 2 mas antiguos se descartaron
  CHECK_EQ(b.c.ultimoEventoSeq(), 10);
  b.c.descartarEventosHasta(5);
  CHECK_EQ(b.c.eventosPendientes(), 5);
  CHECK_EQ(b.c.evento(0).seq, 6);
  b.c.descartarEventosHasta(100);
  CHECK_EQ(b.c.eventosPendientes(), 0);

  Banco a;
  char id[16];
  for (int i = 0; i < 10; i++) { snprintf(id, sizeof(id), "a-%d", i); a.orden(id, ORDEN_PARAR); }
  CHECK_EQ(a.c.acksPendientes(), 8);
  CHECK_EQ(a.c.ack(0).seq, 3);
  a.c.descartarAcksHasta(4);
  CHECK_EQ(a.c.acksPendientes(), 6);
  a.c.vaciarColas();
  CHECK_EQ(a.c.acksPendientes(), 0);
  CHECK_EQ(a.c.eventosPendientes(), 0);
}

TEST(tiempo_transcurrido_de_un_evento_ago) {
  Banco b;
  arrancaAuto(b);
  b.avanza(30000);
  b.avanza(90000);
  CHECK_EQ(b.c.eventosPendientes(), 2);
  CHECK_EQ(b.c.agoEventoS(1), 90);                    // el pump_off ocurrio hace 90 s
  CHECK_EQ(b.c.agoEventoS(0), 120);                   // el pump_on hace 120 s
}

TEST(prioridad_de_los_estados) {
  Banco b;
  CHECK_EQ(b.c.estado(), EST_BLOQ_SENSOR);
  b.lee(650);                       CHECK_EQ(b.c.estado(), EST_IDLE);
  b.lee(250);                       CHECK_EQ(b.c.estado(), EST_SATURADO);
  b.lee(800, 45.0f);                CHECK_EQ(b.c.estado(), EST_BLOQ_TEMP);
  b.lee(800, 30.0f);                CHECK_EQ(b.c.estado(), EST_RIEGO);
  CHECK_STR(nombreEst(EST_IDLE), "idle");
  CHECK_STR(nombreEst(EST_RIEGO), "riego");
  CHECK_STR(nombreEst(EST_ESPERA), "espera");
  CHECK_STR(nombreEst(EST_BLOQ_TEMP), "bloq_temp");
  CHECK_STR(nombreEst(EST_BLOQ_SENSOR), "bloq_sensor");
  CHECK_STR(nombreEst(EST_SATURADO), "saturado");
  b.avanza(30000);                  CHECK_EQ(b.c.estado(), EST_ESPERA);   // 800 seco + espera activa
}

/* ---------------------------------------------------------------------
   PRUEBA DE PROPIEDADES: 6 horas simuladas con lecturas, ordenes y retrasos aleatorios
   (generador determinista). Invariantes que NUNCA deben romperse:
     1. Ningun riego dura mas de riego_max_s + el retraso maximo de una vuelta.
     2. Entre el fin de un riego y el inicio del siguiente pasan >= espera_s.
     3. Un riego automatico solo inicia con suelo >= suelo_on, temp valida y <= temp_max.
     4. Un riego manual nunca inicia con el suelo SATURADO (si el sensor esta bien).
   --------------------------------------------------------------------- */
static uint32_t xs = 2463534242u;
static uint32_t rnd() { xs ^= xs << 13; xs ^= xs >> 17; xs ^= xs << 5; return xs; }

TEST(propiedades_de_seguridad_con_datos_aleatorios) {
  Banco b(0xFFFFF000u);                               // arranca cerca del desborde a proposito
  const uint32_t MAX_VUELTA_MS = 500;
  uint64_t t_on = 0, t_off = 0; bool hubo_off = false, esta_on = false;
  Lectura ultima = L(650);
  b.lee(ultima);
  uint32_t vistos = 0;
  int ciclos = 0, manuales = 0;
  const uint32_t total_ms = 6UL * 3600UL * 1000UL;
  uint32_t t = 0;
  while (t < total_ms) {
    const uint32_t paso = 1 + rnd() % MAX_VUELTA_MS;  // una vuelta de loop() con jitter de hasta 0,5 s
    b.ahora += paso; t += paso;
    b.c.tick(b.ahora);
    const uint32_t azar = rnd() % 1000;
    if (azar < 30) {                                  // llega una lectura
      Lectura l;
      l.suelo_ok  = (rnd() % 20) != 0;                // 5 % de fallas del sensor de suelo
      l.suelo_raw = (int)(rnd() % 1024);
      l.temp_ok   = (rnd() % 15) != 0;
      l.temp      = 10.0f + (float)(rnd() % 500) / 10.0f;    // 10 a 60 C
      ultima = l;
      b.c.nuevaLectura(l, b.ahora);
    } else if (azar < 33) {                           // llega una orden manual
      const uint32_t tipo = rnd() % 4;
      char id[24]; snprintf(id, sizeof(id), "f-%u", (unsigned)rnd());
      if (tipo == 0) b.orden(id, ORDEN_PARAR);
      else b.orden(id, ORDEN_RIEGO, (uint16_t)(rnd() % 140), rnd() % 30, (rnd() % 20) * 1000);
    } else if (azar < 34) {
      if (b.c.quiereMuestraYa()) b.c.nuevaLectura(ultima, b.ahora);
    }
    /* Revisar los eventos nuevos. */
    for (uint8_t i = 0; i < b.c.eventosPendientes(); i++) {
      const Evento& e = b.c.evento(i);
      if (e.seq <= vistos) continue;
      vistos = e.seq;
      if (e.encendido) {
        esta_on = true; t_on = e.t_ms;
        if (hubo_off) CHECK(t_on - t_off >= 300000ULL);                        // invariante 2
        if (e.motivo == ON_AUTO) {                                              // invariante 3
          CHECK(ultima.suelo_ok && ultima.suelo_raw >= 700);
          CHECK(ultima.temp_ok && ultima.temp <= 40.0f);
        } else {
          manuales++;
          if (ultima.suelo_ok) CHECK(ultima.suelo_raw >= 300);                  // invariante 4
        }
      } else {
        CHECK(esta_on);
        esta_on = false; t_off = e.t_ms; hubo_off = true; ciclos++;
        CHECK(t_off - t_on <= 30000ULL + MAX_VUELTA_MS);                        // invariante 1
      }
    }
    if (b.c.eventosPendientes() >= 6) b.c.descartarEventosHasta(vistos);       // como tras un 200 del servidor
    if (esta_on) CHECK(b.c.bombaEncendida());
    if (esta_on) CHECK(b.c.riegoS() <= 30 + 1);
  }
  printf("    (%d riegos completados, %d manuales en 6 h simuladas)\n", ciclos, manuales);
  CHECK(ciclos > 5);                                  // la prueba realmente ejercito el controlador
}

int main() { return correr(); }
