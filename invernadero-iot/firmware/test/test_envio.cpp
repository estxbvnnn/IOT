/* test_envio.cpp - pruebas de la politica de envio de tramas (envio.h) en el PC. */
#define _CRT_SECURE_NO_WARNINGS
#include "mini_test.h"
#include "envio.h"

using namespace envio;

static const uint32_t I = 300000;   // intervalo de telemetria: 300 s (el del informe)

/* Simula un envio fallido de la MISMA trama: entrega en t, responde 100 ms despues. Devuelve el resultado. */
static Resultado fallo(Plan& p, uint32_t t, int http = -1) {
  p.entregada(t);
  return p.respuesta(t + 100, http, false, 0, I);
}

/* Recorre los tres intentos de una trama (con las esperas de 3 s y 6 s) y devuelve el instante del ultimo fallo. */
static uint32_t tresFallos(Plan& p, uint32_t t, Resultado* ultimo = nullptr) {
  CHECK_EQ(fallo(p, t), REINTENTAR);
  t += 100 + 3000;
  CHECK_EQ(p.decidir(t, true, false), REENVIAR);
  CHECK_EQ(fallo(p, t), REINTENTAR);
  t += 100 + 6000;
  CHECK_EQ(p.decidir(t, true, false), REENVIAR);
  const Resultado r = fallo(p, t);
  if (ultimo) *ultimo = r;
  return t + 100;
}

TEST(la_primera_trama_sale_apenas_hay_datos_y_red) {
  Plan p; p.iniciar(1000);
  CHECK_EQ(p.decidir(1000, false, false), NADA);      // sin datos o sin red: espera
  CHECK_EQ(p.decidir(1000, false, true), NADA);
  CHECK_EQ(p.decidir(1000, true, false), ENVIAR_NUEVA);
}

TEST(un_solo_envio_en_vuelo_a_la_vez) {
  Plan p; p.iniciar(0);
  p.entregada(0);
  CHECK(p.enVuelo());
  CHECK(p.hayPendiente());
  CHECK_EQ(p.decidir(5000, true, true), NADA);
  CHECK_EQ(p.decidir(500000, true, true), NADA);
}

TEST(exito_reinicia_el_periodo_y_las_novedades_salen_de_inmediato) {
  Plan p; p.iniciar(0);
  p.entregada(1000);
  CHECK_EQ(p.respuesta(1050, 200, true, 0, I), EXITO);
  CHECK(!p.enVuelo());
  CHECK(!p.hayPendiente());
  CHECK_EQ(p.decidir(1050 + I - 1, true, false), NADA);
  CHECK_EQ(p.decidir(1050 + I, true, false), ENVIAR_NUEVA);
  CHECK_EQ(p.decidir(1500, true, true), NADA);        // novedad, pero faltan para los 2 s de separacion
  CHECK_EQ(p.decidir(2999, true, true), NADA);
  CHECK_EQ(p.decidir(3000, true, true), ENVIAR_NUEVA);   // 2 s despues del ultimo envio (t = 1000)
  CHECK_EQ(p.decidir(3000, false, true), NADA);       // sin red no hay envio aunque haya novedades
}

TEST(las_fallas_reintentan_la_misma_trama_tres_veces_y_luego_backoff) {
  Plan p; p.iniciar(0);
  uint32_t t = 0;
  Resultado r = EXITO;
  t = tresFallos(p, t, &r);
  CHECK_EQ(r, DESCARTAR);                             // tercer intento fallido: se abandona la trama
  CHECK(!p.hayPendiente());
  /* Espera creciente entre TRAMAS (no entre intentos): 10 s, 20 s, 40 s, 80 s, 160 s, 300 s, 300 s. */
  const uint32_t esperas[] = {10000, 20000, 40000, 80000, 160000, 300000, 300000};
  for (int k = 0; k < 7; k++) {
    CHECK_EQ(p.decidir(t + esperas[k] - 1, true, false), NADA);
    t += esperas[k];
    CHECK_EQ(p.decidir(t, true, false), ENVIAR_NUEVA);      // trama NUEVA, no un reintento
    if (k < 6) t = tresFallos(p, t, &r);
  }
}

TEST(reintentos_intermedios_no_avanzan_antes_de_su_espera) {
  Plan p; p.iniciar(0);
  p.entregada(0);
  CHECK_EQ(p.respuesta(100, 500, false, 0, I), REINTENTAR);
  CHECK(p.hayPendiente());
  CHECK_EQ(p.decidir(3099, true, false), NADA);
  CHECK_EQ(p.decidir(3100, true, false), REENVIAR);
  p.entregada(3100);
  CHECK_EQ(p.intentos(), 2);
  CHECK_EQ(p.respuesta(3200, -1, false, 0, I), REINTENTAR);
  CHECK_EQ(p.decidir(3200 + 5999, true, false), NADA);
  CHECK_EQ(p.decidir(3200 + 6000, true, false), REENVIAR);
  p.entregada(9200);
  CHECK_EQ(p.intentos(), 3);
  /* Si el reintento tiene exito, todo vuelve a la normalidad. */
  CHECK_EQ(p.respuesta(9300, 200, true, 0, I), EXITO);
  CHECK(!p.hayPendiente());
  CHECK_EQ(p.decidir(9300 + I, true, false), ENVIAR_NUEVA);
}

TEST(backoff_nunca_supera_el_intervalo_normal) {
  Plan p; p.iniciar(0);
  uint32_t t = 0;
  p.entregada(t);
  for (int k = 0; k < 2; k++) { if (k) p.entregada(t); p.respuesta(t + 100, -1, false, 0, 20000); t += 100 + (k == 0 ? 3000 : 6000); }
  p.entregada(t);
  CHECK_EQ(p.respuesta(t + 100, -1, false, 0, 20000), DESCARTAR);   // intervalo de 20 s
  t += 100;
  CHECK_EQ(p.decidir(t + 9999, true, false), NADA);
  CHECK_EQ(p.decidir(t + 10000, true, false), ENVIAR_NUEVA);         // 1.o: 10 s
  /* Con un intervalo de 5 s el backoff es de 5 s (minimo), no de 10 s. */
  Plan q; q.iniciar(0);
  q.entregada(0); q.respuesta(10, -1, false, 0, 5000);
  q.decidir(3010, true, false); q.entregada(3010); q.respuesta(3020, -1, false, 0, 5000);
  q.decidir(9020, true, false); q.entregada(9020);
  CHECK_EQ(q.respuesta(9030, -1, false, 0, 5000), DESCARTAR);
  CHECK_EQ(q.decidir(9030 + 4999, true, false), NADA);
  CHECK_EQ(q.decidir(9030 + 5000, true, false), ENVIAR_NUEVA);
}

TEST(las_novedades_no_saltan_una_penalizacion) {
  Plan p; p.iniciar(0);
  uint32_t t = 0;
  t = tresFallos(p, t);                               // trama abandonada; backoff de 10 s
  CHECK_EQ(p.decidir(t + 5000, true, true), NADA);    // hay eventos nuevos, pero se respeta el backoff
  CHECK_EQ(p.decidir(t + 10000, true, true), ENVIAR_NUEVA);
  p.entregada(t + 10000);
  CHECK_EQ(p.respuesta(t + 10100, 200, true, 0, I), EXITO);
  CHECK_EQ(p.decidir(t + 10100 + 2100, true, true), ENVIAR_NUEVA);   // recuperado: las novedades vuelven a salir de inmediato
}

TEST(respuesta_401_espera_60_segundos_sin_reintentar) {
  Plan p; p.iniciar(0);
  p.entregada(0);
  CHECK_EQ(p.respuesta(100, 401, false, 0, I), DESCARTAR);
  CHECK(!p.hayPendiente());
  CHECK_EQ(p.decidir(100 + 59999, true, true), NADA);
  CHECK_EQ(p.decidir(100 + 60000, true, false), ENVIAR_NUEVA);
}

TEST(respuesta_429_respeta_retry_after) {
  {
    Plan p; p.iniciar(0); p.entregada(0);
    CHECK_EQ(p.respuesta(100, 429, false, 45, I), DESCARTAR);
    CHECK_EQ(p.decidir(100 + 44999, true, false), NADA);
    CHECK_EQ(p.decidir(100 + 45000, true, false), ENVIAR_NUEVA);
  }
  {
    Plan p; p.iniciar(0); p.entregada(0);              // sin cabecera: 30 s por defecto
    CHECK_EQ(p.respuesta(100, 429, false, 0, I), DESCARTAR);
    CHECK_EQ(p.decidir(100 + 29999, true, false), NADA);
    CHECK_EQ(p.decidir(100 + 30000, true, false), ENVIAR_NUEVA);
  }
  {
    Plan p; p.iniciar(0); p.entregada(0);              // valor absurdo: tope de 10 minutos
    CHECK_EQ(p.respuesta(100, 429, false, 100000, I), DESCARTAR);
    CHECK_EQ(p.decidir(100 + 599999, true, false), NADA);
    CHECK_EQ(p.decidir(100 + 600000, true, false), ENVIAR_NUEVA);
  }
}

TEST(tramas_rechazadas_400_413_se_descartan_y_a_la_tercera_se_limpian_las_colas) {
  Plan p; p.iniciar(0);
  uint32_t t = 0;
  p.entregada(t);
  CHECK_EQ(p.respuesta(t + 100, 400, false, 0, I), DESCARTAR);
  CHECK(!p.hayPendiente());                           // una trama defectuosa NO se reintenta
  t += 10100;
  CHECK_EQ(p.decidir(t, true, false), ENVIAR_NUEVA);
  p.entregada(t);
  CHECK_EQ(p.respuesta(t + 100, 413, false, 0, I), DESCARTAR);
  t += 10100;
  p.entregada(t);
  CHECK_EQ(p.respuesta(t + 100, 400, false, 0, I), DESCARTAR_Y_LIMPIAR);   // tercera seguida
  /* Un exito en medio reinicia la cuenta. */
  Plan q; q.iniciar(0);
  q.entregada(0);      CHECK_EQ(q.respuesta(10, 400, false, 0, I), DESCARTAR);
  q.entregada(20000);  CHECK_EQ(q.respuesta(20010, 400, false, 0, I), DESCARTAR);
  q.entregada(40000);  CHECK_EQ(q.respuesta(40010, 200, true, 0, I), EXITO);
  q.entregada(400000); CHECK_EQ(q.respuesta(400010, 400, false, 0, I), DESCARTAR);
}

TEST(un_200_con_cuerpo_ilegible_cuenta_como_falla) {
  Plan p; p.iniciar(0);
  p.entregada(0);
  CHECK_EQ(p.respuesta(50, 200, false, 0, I), REINTENTAR);   // p. ej. la pagina de un portal cautivo
  CHECK(p.hayPendiente());
}

TEST(tiempo_maximo_en_vuelo) {
  Plan p; p.iniciar(0);
  p.entregada(1000);
  CHECK(!p.vencioEnVuelo(1000 + 29999));
  CHECK(p.vencioEnVuelo(1000 + 30000));
  CHECK_EQ(p.respuesta(31000, -99, false, 0, I), REINTENTAR);
  CHECK(!p.enVuelo());
  CHECK(!p.vencioEnVuelo(100000));
}

static void escenarioCompleto(uint32_t t0) {
  Plan p; p.iniciar(t0);
  CHECK_EQ(p.decidir(t0, true, false), ENVIAR_NUEVA);
  p.entregada(t0);
  CHECK_EQ(p.respuesta(t0 + 100, 200, true, 0, I), EXITO);
  CHECK_EQ(p.decidir(t0 + 100 + I - 1, true, false), NADA);
  CHECK_EQ(p.decidir(t0 + 100 + I, true, false), ENVIAR_NUEVA);
  p.entregada(t0 + 100 + I);
  uint32_t t = t0 + 100 + I;
  CHECK_EQ(p.respuesta(t + 100, -1, false, 0, I), REINTENTAR);
  t += 100 + 3000;
  CHECK_EQ(p.decidir(t, true, false), REENVIAR);
  p.entregada(t);
  CHECK_EQ(p.respuesta(t + 100, 200, true, 0, I), EXITO);
  CHECK_EQ(p.decidir(t + 100 + 2000, true, true), ENVIAR_NUEVA);
}

TEST(el_desborde_de_millis_no_altera_los_plazos) {
  escenarioCompleto(1000);
  escenarioCompleto(0xFFFFFFFFu - 1000u);             // el escenario cruza el desborde
  escenarioCompleto(0xFFFFFFFFu - 150000u);
  escenarioCompleto(0xFFFFFFFFu - 300000u);
}

TEST(una_hora_atrasada_cuenta_como_cero_transcurrido) {
  Plan p; p.iniciar(0);
  p.entregada(10000);
  CHECK_EQ(p.respuesta(10100, 200, true, 0, I), EXITO);
  /* Un millis() capturado ANTES del envio: no debe interpretarse como "pasaron 49 dias". */
  CHECK_EQ(p.decidir(9000, true, true), NADA);
  CHECK_EQ(p.decidir(9000, true, false), NADA);
  Plan q; q.iniciar(0);
  q.entregada(50000);
  CHECK(!q.vencioEnVuelo(49000));
}

int main() { return correr(); }
