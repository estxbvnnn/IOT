/* =====================================================================
   red.h  -  WIFI Y CLIENTE HTTP(S) PARA ESP8266 (un solo nucleo, sin FreeRTOS)

   A diferencia del ESP32, el ESP8266 no tiene un segundo nucleo ni tareas:
   un POST HTTP bloquea el bucle mientras dura (0,3 a 8 s). Para que eso
   nunca afecte al riego, el sketch aplica UNA regla (ver gestionarEnvio):

       NUNCA se hace red con la bomba encendida.

   Asi el corte de la bomba por tiempo se evalua en cada vuelta (~10 ms) y
   ningun POST puede alargar un riego. Los eventos (bomba encendida/apagada)
   y los acuses quedan en cola y viajan apenas la bomba se apaga.

   La interfaz es la misma que en el ESP32 (redEnviar / redRecibir ...), pero
   redEnviar() hace el POST en el momento y deja la respuesta lista para
   redRecibir(). La conexion WiFi es asincrona y se mantiene con redMantener().
   ===================================================================== */
#ifndef RED_H
#define RED_H

#include <Arduino.h>
#include <ESP8266WiFi.h>
#include <ESP8266HTTPClient.h>
#include <WiFiClientSecure.h>
#include <time.h>
#include "config.h"
#include "protocolo.h"

/* Credenciales: WIFI_SSID, WIFI_PASS, SERVER_URL, DEVICE_TOKEN (y CA_ROOT_PEM o TLS_INSEGURO si se
   usa HTTPS) salen del bloque CONFIGURACION DEL USUARIO, al inicio de este archivo. Con los valores
   de ejemplo el nodo funciona en modo local. */

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

/* Certificado raiz para verificar al servidor por HTTPS (solo si se definio CA_ROOT_PEM). */
#if defined(CA_ROOT_PEM) && !defined(TLS_INSEGURO)
static BearSSL::X509List ca_raiz(CA_ROOT_PEM);
#endif

namespace red {

static bool   activa = false;
static bool   hay_rx = false;          // hay una respuesta lista para redRecibir()
static MsgRx  rx;                      // estatico: es grande y no debe ir a la pila

static uint32_t t_intento_wifi = 0;
static uint32_t espera_wifi_ms = WIFI_REINTENTO_MS;
static bool     hubo_intento_wifi = false;
static bool     estaba_conectado = false;

/* Mantiene el WiFi SIN bloquear: WiFi.begin() conecta en segundo plano. Si no se logra, reintenta con
   espera creciente (20 s, 40 s, 80 s ... tope 5 min). Se llama en cada vuelta del bucle. */
inline void mantenerWiFi() {
  if (WiFi.status() == WL_CONNECTED) {
    if (!estaba_conectado) {
      estaba_conectado = true;
      Serial.printf("WiFi: conectado, IP %s, RSSI %d dBm\n", WiFi.localIP().toString().c_str(), (int)WiFi.RSSI());
    }
    espera_wifi_ms = WIFI_REINTENTO_MS;
    hubo_intento_wifi = false;
    return;
  }
  if (estaba_conectado) {
    estaba_conectado = false;
    Serial.println("WiFi: conexion perdida");
  }
  const uint32_t ahora = millis();
  if (hubo_intento_wifi && (uint32_t)(ahora - t_intento_wifi) < espera_wifi_ms) return;
  if (hubo_intento_wifi && espera_wifi_ms < 300000UL) {
    espera_wifi_ms *= 2;
    if (espera_wifi_ms > 300000UL) espera_wifi_ms = 300000UL;
  }
  hubo_intento_wifi = true;
  t_intento_wifi = ahora;
  Serial.printf("WiFi: conectando a \"%s\" ...\n", WIFI_SSID);
  WiFi.disconnect(false);
  WiFi.begin(WIFI_SSID, WIFI_PASS);
}

/* Hace el POST de una trama y deja el resultado en r. BLOQUEA hasta HTTP_TIMEOUT_MS (por eso nunca
   se llama con la bomba encendida). */
inline void enviarPost(const MsgTx& t, MsgRx& r) {
  r.seq = t.seq;
  r.http = -1;
  r.n = 0;
  r.retry_after_s = 0;
  r.recibido_ms = millis();
  r.cuerpo[0] = 0;
  if (WiFi.status() != WL_CONNECTED) return;

  const bool https = strncmp(SERVER_URL, "https://", 8) == 0;
  WiFiClient*                plano  = nullptr;
  BearSSL::WiFiClientSecure* seguro = nullptr;
  HTTPClient http;
  bool ok = false;

  if (https) {
#if defined(TLS_INSEGURO) || defined(CA_ROOT_PEM)
    if (ESP.getFreeHeap() < 20000) { r.http = -3; return; }          // sin memoria para TLS: se reintenta despues
    seguro = new BearSSL::WiFiClientSecure();
    seguro->setBufferSizes(TLS_BUFFER_RX, TLS_BUFFER_TX);
  #if defined(TLS_INSEGURO)
    seguro->setInsecure();                                            // SOLO DESARROLLO: no verifica al servidor
  #else
    const time_t ahora_utc = time(nullptr);
    if (ahora_utc < 1700000000) { delete seguro; r.http = -2; return; }   // aun sin hora NTP: no se puede validar
    seguro->setX509Time(ahora_utc);
    seguro->setTrustAnchors(&ca_raiz);                                // verifica la cadena contra CA_ROOT_PEM
  #endif
    ok = http.begin(*seguro, URL_INGEST);
#else
    return;                                                           // no se llega aqui: redIniciar() no arranca la red sin CA
#endif
  } else {
    plano = new WiFiClient();
    ok = http.begin(*plano, URL_INGEST);
  }

  if (ok) {
    http.setTimeout(HTTP_TIMEOUT_MS);    // conexion y lectura. El servidor puede tardar ~1,2 s por trama y hasta
                                         // ~5 s tras un periodo inactivo (conexion "fria" a la base).
    http.setReuse(false);
    http.setUserAgent("nodo-invernadero/" FW_VERSION);
    http.addHeader("Content-Type", "application/json");
    http.addHeader("Authorization", "Bearer " DEVICE_TOKEN);
    const char* claves[] = {"Retry-After"};
    http.collectHeaders(claves, 1);

    const int codigo = http.POST((const uint8_t*)t.cuerpo, t.n);
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

}  // namespace red

/* ---------- Interfaz para el bucle de control ---------- */

inline bool redActiva() { return red::activa; }

inline void redIniciar() {
  if (credencialesDeEjemplo()) {
    Serial.println("RED: la CONFIGURACION DEL USUARIO tiene valores de ejemplo -> sin conexion. El riego local sigue funcionando.");
    return;
  }
  if (httpsSinCA()) {
    Serial.println("RED: SERVER_URL es https:// pero la CONFIGURACION DEL USUARIO no define CA_ROOT_PEM (ni TLS_INSEGURO para desarrollo).");
    Serial.println("     No se enviara nada para no exponer el token. El riego local sigue funcionando.");
    return;
  }
  WiFi.persistent(false);              // no escribe las credenciales en la flash en cada arranque
  WiFi.mode(WIFI_STA);
  WiFi.setAutoReconnect(true);
  WiFi.setSleepMode(WIFI_NONE_SLEEP);  // el nodo va con alimentacion de red: prioriza estabilidad sobre consumo
#if defined(CA_ROOT_PEM) && !defined(TLS_INSEGURO)
  configTime(0, 0, "pool.ntp.org", "time.google.com");   // la validacion de certificados necesita la hora
#endif
  red::activa = true;
  red::mantenerWiFi();                 // primer intento de conexion, sin esperar
}

/* Mantiene el WiFi. Barato: se llama en cada vuelta. */
inline void redMantener() {
  if (red::activa) red::mantenerWiFi();
}

inline bool redConectada() { return red::activa && WiFi.status() == WL_CONNECTED; }
inline int  redRssi()      { return WiFi.status() == WL_CONNECTED ? (int)WiFi.RSSI() : 0; }

/* Hace el POST de la trama AHORA (bloquea hasta HTTP_TIMEOUT_MS) y deja la respuesta para redRecibir().
   false si la red no esta activa o aun hay una respuesta sin recoger. */
inline bool redEnviar(const MsgTx& m) {
  if (!red::activa || red::hay_rx) return false;
  red::enviarPost(m, red::rx);
  red::hay_rx = true;
  return true;
}

/* Recoge la respuesta del ultimo POST, si la hay. */
inline bool redRecibir(MsgRx& m) {
  if (!red::activa || !red::hay_rx) return false;
  memcpy(&m, &red::rx, sizeof(MsgRx));
  red::hay_rx = false;
  return true;
}

#endif  // RED_H
