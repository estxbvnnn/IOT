/* =====================================================================
   red.h  -  WIFI Y CLIENTE HTTP(S) EN UNA TAREA APARTE (nucleo 0)

   La red puede tardar segundos (reconectar el WiFi, un servidor lento).
   Si eso ocurriera en loop(), el corte de la bomba por tiempo se
   retrasaria. Por eso TODO lo que espera a la red vive en esta tarea de
   FreeRTOS, y el bucle de control (nucleo 1) solo se comunica con ella
   por dos colas, sin esperar nunca:

       loop() --- MsgTx (cuerpo JSON ya armado) ---> tarea de red --> POST
       loop() <-- MsgRx (codigo HTTP + respuesta) --- tarea de red <-- 200/4xx/5xx

   La tarea de red no interpreta el JSON: solo transporta. Asi el riego
   automatico sigue funcionando aunque no haya WiFi ni servidor.
   ===================================================================== */
#ifndef RED_H
#define RED_H

#include <Arduino.h>
#include <WiFi.h>
#include <HTTPClient.h>
#include <WiFiClientSecure.h>
#include <freertos/FreeRTOS.h>
#include <freertos/task.h>
#include <freertos/queue.h>
#include "config.h"
#include "protocolo.h"

/* Credenciales: secrets.h (no se sube a Git). Si no existe, se usa la plantilla de ejemplo y
   el nodo funciona en modo local. */
#if __has_include("secrets.h")
  #include "secrets.h"
#else
  #include "secrets.example.h"
#endif

#define URL_INGEST  SERVER_URL "/api/ingest"

struct MsgTx {
  uint32_t seq;                       // seq de la trama (para casar la respuesta)
  uint16_t n;
  char     cuerpo[protocolo::TX_MAX];
};

struct MsgRx {
  uint32_t seq;
  int      http;                      // codigo HTTP, o el error de HTTPClient (negativo: sin red, timeout...)
  uint16_t n;
  uint16_t retry_after_s;
  uint32_t recibido_ms;               // millis() al recibir la respuesta (para el vencimiento de ordenes)
  char     cuerpo[protocolo::RX_MAX];
};

/* Valores de la plantilla: el nodo NO intenta conectarse. */
inline bool credencialesDeEjemplo() {
  return strcmp(DEVICE_TOKEN, "PEGAR_AQUI_EL_TOKEN_DEL_NODO") == 0 || strcmp(WIFI_SSID, "NOMBRE_DE_LA_RED") == 0;
}

/* URL https:// sin certificado raiz (CA_ROOT_PEM) y sin TLS_INSEGURO: se prefiere NO enviar antes que
   enviar sin verificar al servidor. Se avisa una sola vez al arrancar (ver redIniciar). */
inline bool httpsSinCA() {
#if defined(TLS_INSEGURO) || defined(CA_ROOT_PEM)
  return false;
#else
  return strncmp(SERVER_URL, "https://", 8) == 0;
#endif
}

/* Recibe el cuerpo de la respuesta en un buffer fijo. Si el servidor envia mas de lo que cabe,
   deja de aceptar (HTTPClient aborta la lectura) en vez de agotar la memoria. */
class BufferAcotado : public Stream {
 public:
  BufferAcotado(char* buf, size_t cap) : b_(buf), cap_(cap), n_(0) { if (cap_) b_[0] = 0; }
  size_t write(uint8_t c) override {
    if (n_ + 1 >= cap_) return 0;
    b_[n_++] = (char)c;
    b_[n_] = 0;
    return 1;
  }
  size_t write(const uint8_t* datos, size_t largo) override {
    size_t k = 0;
    while (k < largo && write(datos[k])) k++;
    return k;
  }
  int available() override { return 0; }
  int read() override { return -1; }
  int peek() override { return -1; }
  size_t largo() const { return n_; }
 private:
  char* b_; size_t cap_; size_t n_;
};

namespace red {

static QueueHandle_t colaTx = nullptr;
static QueueHandle_t colaRx = nullptr;

/* Buffers de la tarea de red (estaticos: no van a la pila). */
static MsgTx tx;
static MsgRx rx;

static uint32_t t_intento_wifi = 0;
static uint32_t espera_wifi_ms = 5000;
static bool     hubo_intento_wifi = false;

/* Conecta (o reconecta) el WiFi con espera creciente: 5 s, 10 s, 20 s ... tope 5 min. */
inline void asegurarWiFi() {
  if (WiFi.status() == WL_CONNECTED) { espera_wifi_ms = 5000; return; }
  const uint32_t ahora = millis();
  if (hubo_intento_wifi && (uint32_t)(ahora - t_intento_wifi) < espera_wifi_ms) return;
  hubo_intento_wifi = true;
  t_intento_wifi = ahora;

  Serial.printf("WiFi: conectando a \"%s\" ...\n", WIFI_SSID);
  WiFi.disconnect(false, false);
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  const uint32_t t0 = millis();
  while (WiFi.status() != WL_CONNECTED && (uint32_t)(millis() - t0) < 10000) vTaskDelay(pdMS_TO_TICKS(250));

  if (WiFi.status() == WL_CONNECTED) {
    Serial.printf("WiFi: conectado, IP %s, RSSI %d dBm\n", WiFi.localIP().toString().c_str(), WiFi.RSSI());
    espera_wifi_ms = 5000;
  } else {
    Serial.printf("WiFi: sin conexion, se reintenta en %lu s\n", (unsigned long)(espera_wifi_ms / 1000));
    if (espera_wifi_ms < 300000UL) espera_wifi_ms *= 2;
    if (espera_wifi_ms > 300000UL) espera_wifi_ms = 300000UL;
  }
}

/* Hace el POST de una trama y deja el resultado en rx. */
inline void enviarPost(const MsgTx& t, MsgRx& r) {
  r.seq = t.seq;
  r.http = -1;
  r.n = 0;
  r.retry_after_s = 0;
  r.recibido_ms = millis();
  r.cuerpo[0] = 0;
  if (WiFi.status() != WL_CONNECTED) return;

  const bool https = strncmp(SERVER_URL, "https://", 8) == 0;
  WiFiClient*       plano  = nullptr;
  WiFiClientSecure* seguro = nullptr;
  HTTPClient http;
  bool ok = false;

  if (https) {
#if defined(TLS_INSEGURO) || defined(CA_ROOT_PEM)
    seguro = new WiFiClientSecure();
  #if defined(TLS_INSEGURO)
    seguro->setInsecure();                       // SOLO DESARROLLO: no verifica al servidor
  #else
    seguro->setCACert(CA_ROOT_PEM);              // verifica la cadena contra la CA de secrets.h
  #endif
    ok = http.begin(*seguro, URL_INGEST);
#else
    return;                                      // no se llega aqui: redIniciar() no arranca la red sin CA
#endif
  } else {
    plano = new WiFiClient();
    ok = http.begin(*plano, URL_INGEST);
  }

  if (ok) {
    http.setConnectTimeout(5000);
    http.setTimeout(10000);              // lectura: el servidor puede tardar ~1,2 s por trama y hasta ~5 s tras un
                                         // periodo inactivo (conexion "fria" a la base). Solo bloquea a la tarea de red.
    http.setReuse(false);
    http.setUserAgent("nodo-invernadero/" FW_VERSION);
    http.addHeader("Content-Type", "application/json");
    http.addHeader("Authorization", "Bearer " DEVICE_TOKEN);
    const char* claves[] = {"Retry-After"};
    http.collectHeaders(claves, 1);

    const int codigo = http.POST((uint8_t*)t.cuerpo, t.n);
    r.http = codigo;
    r.recibido_ms = millis();
    if (codigo > 0) {
      BufferAcotado salida(r.cuerpo, sizeof(r.cuerpo));
      http.writeToStream(&salida);               // acotado; si excede, r.n queda en lo leido
      r.n = (uint16_t)salida.largo();
      const String ra = http.header("Retry-After");
      if (ra.length()) r.retry_after_s = (uint16_t)constrain(ra.toInt(), 0, 3600);
    }
    http.end();
  }
  delete plano;
  delete seguro;
}

/* Tarea de red: espera tramas, las envia y devuelve el resultado. */
inline void tarea(void*) {
  for (;;) {
    asegurarWiFi();
    if (xQueueReceive(colaTx, &tx, pdMS_TO_TICKS(500)) == pdTRUE) {
      enviarPost(tx, rx);
      xQueueSend(colaRx, &rx, 0);
    }
  }
}

}  // namespace red

/* ---------- Interfaz para el bucle de control (nunca bloquea) ---------- */

inline bool redActiva() { return red::colaTx != nullptr; }

inline void redIniciar() {
  if (credencialesDeEjemplo()) {
    Serial.println("RED: secrets.h con valores de ejemplo -> sin conexion. El riego local sigue funcionando.");
    return;
  }
  if (httpsSinCA()) {
    Serial.println("RED: SERVER_URL es https:// pero secrets.h no define CA_ROOT_PEM (ni TLS_INSEGURO para desarrollo).");
    Serial.println("     No se enviara nada para no exponer el token. El riego local sigue funcionando.");
    return;
  }
  red::colaTx = xQueueCreate(1, sizeof(MsgTx));
  red::colaRx = xQueueCreate(2, sizeof(MsgRx));
  if (!red::colaTx || !red::colaRx) {
    Serial.println("RED: sin memoria para las colas -> sin conexion");
    red::colaTx = nullptr;
    return;
  }
  WiFi.persistent(false);              // no escribe las credenciales en la flash en cada arranque
  WiFi.mode(WIFI_STA);
  WiFi.setAutoReconnect(true);
  WiFi.setSleep(false);                // el nodo va con alimentacion de red: prioriza estabilidad sobre consumo
  xTaskCreatePinnedToCore(red::tarea, "red", 10240, nullptr, 1, nullptr, 0);
}

inline bool redConectada() { return redActiva() && WiFi.status() == WL_CONNECTED; }
inline int  redRssi()      { return WiFi.status() == WL_CONNECTED ? WiFi.RSSI() : 0; }

/* Entrega una trama a la tarea de red. false si la cola esta ocupada. */
inline bool redEnviar(const MsgTx& m) { return redActiva() && xQueueSend(red::colaTx, &m, 0) == pdTRUE; }

/* Recoge un resultado si hay uno. */
inline bool redRecibir(MsgRx& m) { return redActiva() && xQueueReceive(red::colaRx, &m, 0) == pdTRUE; }

#endif  // RED_H
