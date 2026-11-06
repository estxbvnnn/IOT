/* =====================================================================
   MALLA ESP-NOW  -  mismo sketch para todos los nodos (ESP8266, NodeMCU)

   Idea: cada nodo manda sus datos CIFRADOS (RSA-2048 + AES-256-GCM, solo el servidor puede abrirlos) al servidor que hace de
   Raspberry Pi (pasarela del dashboard, por WiFi). Si no consigue que el servidor le responda, los difunde por ESP-NOW: cualquier
   vecino los retransmite (hasta MAX_SALTOS saltos) hasta que lo recibe un nodo CON red, que los sube en nombre del origen.
   Solo la Pi/PC sube a la nube (el servicio «sync»): ningun nodo habla con la nube.

     nodo sin ruta ──ESP-NOW──► vecino (sin red) ──ESP-NOW──► vecino CON red ──POST /relay/nodo-<origen>──► pasarela (PC/Pi)
          ▲                                                                                                       │
          └────────────── respuesta cifrada con la clave de un solo uso (vuelve por inundacion) ◄────────────────┘

   Los relevos NO abren nada: el contenido solo lo abre la pasarela. La identidad del nodo es MI_ID, que va dentro del mensaje
   cifrado; el relevo solo informa «lo subi yo» (cabeceras X-Via y X-Saltos).
   Los nodos NO llevan clave privada: solo la clave PUBLICA del servidor.

   PASOS
     1) Placa NodeMCU 1.0 con el core "esp8266 by ESP8266 Community" 3.1.2. No hay que instalar bibliotecas.
     2) Clave del servidor (el PC/Pi): su par RSA-2048; aqui va solo la PUBLICA:
          node pegar-claves.mjs malla_espnow.ino --socio publica-del-servidor.pem
     3) NO hace falta token: el nodo se identifica con MI_ID (vacio = "nodo-<id de la placa>", unico y automatico, asi el MISMO sketch sirve para todas las placas; o un nombre como "GRUPO-A"). La pasarela en modo de pruebas (ACEPTAR_NODOS_NUEVOS=1) da de alta cada identificador nuevo con su propio invernadero.
     4) Configure WIFI_*, GATEWAY_HOST (IP del PC/Pi en la misma red), nada mas (MI_ID es opcional). Suba. El Monitor Serie (115200) muestra todo.
     5) Canal: con WiFi, ESP-NOW usa el canal del router (todos los nodos del mismo router coinciden). Un nodo que NO consigue conectar
        busca el router por su nombre (WIFI_SSID) y usa SU canal aunque no pueda entrar; solo si ni siquiera lo ve usa CANAL
        (pongalo igual al canal del router: la placa con red lo imprime, «canal N»). Con USAR_WIFI 0 siempre usa CANAL.
   Pruebas: FORZAR_RADIO 1 hace que ESTE nodo mande SIEMPRE por radio (otro nodo con red lo sube). Con GATEWAY_HOST equivocado en un
   nodo con WiFi pasa lo mismo a los 2 fallos.
   ===================================================================== */
#include <Arduino.h>
#include <ESP8266WiFi.h>
#include <ESP8266HTTPClient.h>
#include <espnow.h>
#include <bearssl/bearssl.h>

/* ------------------------------ CONFIGURACION ------------------------------ */
/* PERFIL: un solo archivo para todas las placas (NO guarde copias dentro de esta carpeta: Arduino junta todos los .ino y falla).
     0 = normal: MI_ID vacio (cada placa se llama "nodo-<id de la placa>") y sube por la red; es el que va en TODAS las placas.
     1 = prueba, placa "GRUPO-A": sube por la red (es la que hace de puerta de entrada).
     2 = prueba, placa "GRUPO-B": manda SIEMPRE por radio (para ver que A sube lo suyo).                                          */
#define PERFIL          0
#if PERFIL == 1
  #define MI_ID         "GRUPO-A"
  #define FORZAR_RADIO  0
#elif PERFIL == 2
  #define MI_ID         "GRUPO-B"
  #define FORZAR_RADIO  1
#else
  #define MI_ID         ""                               // identificador de ESTE nodo ("GRUPO-A", "nodo-b"...; letras, numeros, - y _; max 40). Vacio = "nodo-<id de la placa>" automatico
  #define FORZAR_RADIO  0                                // 1 = este nodo envia siempre por radio (SOLO para probar la malla)
#endif
#define PERIODO_S       10                      // segundos entre envios (0 = no envia, solo hace de relevo)

#define USAR_WIFI       1                        // 1 = intenta conectar al router (y puede subir/retransmitir); 0 = solo radio
/* Tu WiFi y la IP de la pasarela van en config_local.h (copie config_local.example.h): ese archivo NO se sube a git.
   Si no existe, se usan estos valores de ejemplo y la placa no conectara. */
#if __has_include("config_local.h")
  #include "config_local.h"
#endif
#ifndef WIFI_SSID
  #define WIFI_SSID     "TU_WIFI"                        // red de 2,4 GHz
#endif
#ifndef WIFI_PASS
  #define WIFI_PASS     "TU_CLAVE"
#endif
#ifndef GATEWAY_HOST
  #define GATEWAY_HOST  "192.168.0.100"                  // IP del PC o de la Pi que corre la pasarela (puerto 3100)
#endif
#define GATEWAY_PORT    3100
#define CANAL           6                        // canal ESP-NOW cuando no hay WiFi (igual al canal del router)

#define MAX_SALTOS      3                        // saltos maximos por radio (TTL inicial)
#define WIFI_REINTENTO_S 30                      // cada cuanto reintenta el WiFi si no esta conectado
/* --------------------------------------------------------------------------- */

/* Clave PUBLICA RSA-2048 del servidor. La rellena pegar-claves.mjs; hasta entonces la placa avisa y no envia. */
// RSA_SOCIO_PUBLICA_INICIO  (clave publica del otro grupo)
static const uint8_t RSA_SOCIO_N[256] = {
  0xba, 0xa6, 0xb9, 0x6c, 0x1a, 0x7c, 0xc3, 0x80, 0xa1, 0x9a, 0x1d, 0xb5, 0x94, 0x12, 0x2b, 0x73,
  0x5e, 0x12, 0xfd, 0x8e, 0x92, 0x40, 0xfb, 0xeb, 0x1b, 0x5e, 0x35, 0x76, 0x17, 0x71, 0x6f, 0xd5,
  0x14, 0x69, 0xd9, 0xa5, 0x81, 0x8b, 0xca, 0x84, 0x79, 0x8e, 0xc6, 0xce, 0xf0, 0x6c, 0xc3, 0x19,
  0x93, 0x12, 0x60, 0xcd, 0xd4, 0xc1, 0xda, 0x0b, 0x66, 0x88, 0xcc, 0x7b, 0x97, 0x63, 0x30, 0xca,
  0xa6, 0xf4, 0x02, 0x93, 0x02, 0xf9, 0xc3, 0xbf, 0x9e, 0xe9, 0x4b, 0x24, 0x03, 0x0f, 0xdd, 0x5d,
  0x28, 0x8d, 0xdd, 0x2e, 0x84, 0x45, 0x38, 0xba, 0x3a, 0x36, 0xe2, 0x6e, 0x36, 0x96, 0x5f, 0xf9,
  0x3d, 0x79, 0x9f, 0x0a, 0xcf, 0xc9, 0x64, 0xe4, 0x54, 0xd1, 0xb1, 0x1f, 0x26, 0x3a, 0x0e, 0xa9,
  0x61, 0xec, 0x1c, 0xa0, 0xd8, 0x16, 0xd4, 0x25, 0xf1, 0xb1, 0x20, 0xc6, 0xda, 0xf1, 0x2c, 0x40,
  0x55, 0xbc, 0x9b, 0x17, 0xf3, 0xa6, 0x08, 0x5d, 0x68, 0x24, 0x1f, 0x5b, 0xca, 0x00, 0xc3, 0x7d,
  0xcc, 0xd2, 0x08, 0x98, 0x7c, 0x8e, 0x6d, 0x15, 0x25, 0x99, 0xd7, 0x4c, 0x9f, 0x66, 0x56, 0xd5,
  0x0f, 0x25, 0x73, 0x5e, 0x28, 0xd6, 0xb4, 0xdb, 0xc8, 0xb0, 0x2a, 0xe1, 0xef, 0x24, 0x89, 0x8b,
  0x12, 0xc2, 0xb0, 0xff, 0x23, 0xb4, 0x65, 0x03, 0x98, 0x5e, 0x3a, 0xcd, 0x70, 0x7b, 0xab, 0xe2,
  0xb4, 0x05, 0xec, 0xe8, 0xe1, 0x8a, 0xc4, 0xd7, 0x08, 0x6d, 0x26, 0x83, 0xcd, 0x3c, 0x7e, 0x68,
  0xb4, 0x8c, 0xa6, 0x2a, 0xbc, 0xb2, 0x59, 0x8e, 0xfd, 0x85, 0x95, 0x49, 0x5f, 0xef, 0x9c, 0xa8,
  0x37, 0x1b, 0xca, 0x1a, 0x30, 0x07, 0x96, 0xa0, 0xd9, 0x89, 0xa2, 0xf2, 0xab, 0x72, 0x7c, 0x86,
  0xdc, 0x8e, 0x81, 0x41, 0x88, 0xe2, 0xc1, 0x0c, 0xbf, 0xa7, 0x39, 0x94, 0x78, 0x28, 0x5c, 0x5f
};
static const uint8_t RSA_SOCIO_E[3] = {
  0x01, 0x00, 0x01
};
// RSA_SOCIO_PUBLICA_FIN

/* ------------------------------ Protocolo ------------------------------
   paquete = MAGIA | tipo | id(4) | seq(4) | idx(4 bits)+ttl(4 bits) | total(4 bits)+intento(4 bits) | fragmento(<=238)
   tipo 0x11 = datos hacia el servidor (id = nodo de origen), 0x12 = respuesta (id = nodo al que va dirigida)   */
static const uint8_t  MAGIA      = 0xE6;
static const uint8_t  TIPO_DATOS = 0x11;
static const uint8_t  TIPO_RESP  = 0x12;
static const size_t   CAB        = 12;
static const size_t   FRAG       = 238;
static const uint8_t  MAX_FRAGS  = 6;
static const size_t   MSG_MAX    = MAX_FRAGS * FRAG;          // 1428 bytes de "rsa1:..." por mensaje
static const size_t   PLANO_MAX  = 700;
static const uint32_t ESPERA_ACUSE_MS = 15000;
static const uint8_t  MAX_INTENTOS = 3;
static const uint32_t RADIO_MS   = 60000;                      // tras 2 fallos de red se usa la radio este tiempo

/* ------------------------------ Estado ------------------------------ */
static uint8_t  BCAST[6] = {0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF};
static uint32_t mi_id = 0, boot_id = 0, envios = 0;
static uint8_t  canal = CANAL;
static bool     srv_ok = false;                                // hay clave publica del servidor
static char     mi_nombre[44];                                // identificador que viaja dentro del mensaje cifrado (lo reconoce la pasarela)
static br_hmac_drbg_context rng;
static volatile bool tx_hecho = false;
static volatile bool puede_subir = false;                      // WiFi conectado y servidor respondiendo: este nodo puede subir tramas
static uint32_t radio_hasta = 0;                               // mientras no se cumpla, la red normal se considera caida
static uint8_t  fallos_red = 0;
static uint32_t t_wifi = 0, t_envio = 0;

struct Slot {                                                   // mensaje que se va armando con los fragmentos (lo llena el callback del SDK)
  volatile bool completo;
  bool          activo;
  uint8_t       total, mask, ttl, intento;
  uint32_t      id, seq, t_ms;
  uint16_t      ultimo, n;
  uint8_t       buf[MSG_MAX];
};
static Slot dat, resp;                                          // dat = datos ajenos que subo yo · resp = respuesta a mis datos

/* Cache de lo ya visto: evita inundar la malla (y que un fragmento dé vueltas). */
struct Visto { uint32_t id, seq; uint8_t tipo, idx, intento, usado; };
static Visto vistos[32];
static uint8_t vistos_i = 0;
static bool yaVisto(uint8_t tipo, uint32_t id, uint32_t seq, uint8_t idx, uint8_t intento) {
  for (uint8_t i = 0; i < 32; i++) {
    const Visto& v = vistos[i];
    if (v.usado && v.tipo == tipo && v.id == id && v.seq == seq && v.idx == idx && v.intento == intento) return true;
  }
  vistos[vistos_i] = { id, seq, tipo, idx, intento, 1 };
  vistos_i = (uint8_t)((vistos_i + 1) % 32);
  return false;
}

/* Cola de reenvio: el callback no puede transmitir; copia el paquete y el bucle lo emite tras un retardo aleatorio (evita choques). */
struct Fwd { uint8_t n; uint8_t d[CAB + FRAG]; uint32_t due; };
static Fwd fwd[10];

/* Mi envio en curso (por radio). */
static uint8_t  msg_pend[MSG_MAX];
static size_t   pend_n = 0;
static uint32_t pend_seq = 0, pend_t = 0;
static uint8_t  pend_intento = 0;
static bool     esperando = false;
static uint8_t  ultima_K[32];
static bool     hay_K = false;
static char     tema_rx_propio[40], tema_tx_propio[40];
static char     repl[MSG_MAX + 8];

/* ------------------------------ Utilidades ------------------------------ */
static void poner32(uint8_t* p, uint32_t v) { p[0] = v >> 24; p[1] = v >> 16; p[2] = v >> 8; p[3] = v; }
static uint32_t leer32(const uint8_t* p) { return ((uint32_t)p[0] << 24) | ((uint32_t)p[1] << 16) | ((uint32_t)p[2] << 8) | p[3]; }

static const char B64T[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
static size_t b64Enc(const uint8_t* in, size_t n, char* out) {
  size_t o = 0;
  for (size_t i = 0; i < n; i += 3) {
    uint32_t v = (uint32_t)in[i] << 16;
    if (i + 1 < n) v |= (uint32_t)in[i + 1] << 8;
    if (i + 2 < n) v |= in[i + 2];
    out[o++] = B64T[(v >> 18) & 63];
    out[o++] = B64T[(v >> 12) & 63];
    out[o++] = (i + 1 < n) ? B64T[(v >> 6) & 63] : '=';
    out[o++] = (i + 2 < n) ? B64T[v & 63] : '=';
  }
  return o;
}
static int b64Val(uint8_t c) {
  if (c >= 'A' && c <= 'Z') return c - 'A';
  if (c >= 'a' && c <= 'z') return c - 'a' + 26;
  if (c >= '0' && c <= '9') return c - '0' + 52;
  if (c == '+') return 62;
  if (c == '/') return 63;
  return -1;
}
/* Decodifica EN SITIO. Devuelve los bytes, o -1 si no es Base64 valido. */
static int b64DecEnSitio(uint8_t* p, size_t n) {
  if (n == 0 || n % 4 != 0) return -1;
  size_t o = 0;
  for (size_t i = 0; i < n; i += 4) {
    const int a = b64Val(p[i]), b = b64Val(p[i + 1]);
    const int c = (p[i + 2] == '=') ? -2 : b64Val(p[i + 2]);
    const int d = (p[i + 3] == '=') ? -2 : b64Val(p[i + 3]);
    if (a < 0 || b < 0 || c == -1 || d == -1) return -1;
    const uint32_t v = ((uint32_t)a << 18) | ((uint32_t)b << 12) | ((c >= 0 ? (uint32_t)c : 0) << 6) | (d >= 0 ? (uint32_t)d : 0);
    p[o++] = (v >> 16) & 255;
    if (c >= 0) p[o++] = (v >> 8) & 255;
    if (d >= 0) p[o++] = v & 255;
  }
  return (int)o;
}

/* AES-GCM con BearSSL: cifra o descifra `datos` EN SITIO; al descifrar verifica la etiqueta (false = alterado o clave/AAD distintos). */
static bool aesGcm(const uint8_t* clave, uint8_t nclave, bool cifrar, const uint8_t* nonce, const char* aad, uint8_t* datos, size_t largo, uint8_t* tag) {
  br_aes_ct_ctr_keys bc;
  br_gcm_context gc;
  br_aes_ct_ctr_init(&bc, clave, nclave);
  br_gcm_init(&gc, &bc.vtable, br_ghash_ctmul32);
  br_gcm_reset(&gc, nonce, 12);
  br_gcm_aad_inject(&gc, aad, strlen(aad));
  br_gcm_flip(&gc);
  br_gcm_run(&gc, cifrar ? 1 : 0, datos, largo);
  if (cifrar) { br_gcm_get_tag(&gc, tag); return true; }
  return br_gcm_check_tag(&gc, tag) == 1;
}

static void rngIniciar() {
  uint32_t semilla[8];
  for (int i = 0; i < 8; i++) semilla[i] = RANDOM_REG32;       // generador por hardware del ESP8266
  br_hmac_drbg_init(&rng, &br_sha256_vtable, semilla, sizeof(semilla));
}
static void rngBytes(uint8_t* out, size_t n) {
  uint32_t extra[4];
  for (int i = 0; i < 4; i++) extra[i] = RANDOM_REG32;         // mas entropia fresca en cada mensaje
  br_hmac_drbg_update(&rng, extra, sizeof(extra));
  br_hmac_drbg_generate(&rng, out, n);
}

/* ------------------------------ Cifrado hacia el servidor ------------------------------ */
/* Cifra `plano` ("TOKEN\n{json}") para el servidor y deja "rsa1:..." en msg_pend. La clave de un solo uso queda en ultima_K. Devuelve el largo (0 = fallo). */
static size_t cifrarParaServidor(const char* plano, size_t n) {
  if (n == 0 || n > PLANO_MAX) return 0;
  static uint8_t bin[256 + 12 + PLANO_MAX + 16];                // clave envuelta | nonce | cifrado | etiqueta
  rngBytes(ultima_K, sizeof(ultima_K));                         // AES-256 de UN SOLO USO
  const br_rsa_public_key pk = { (unsigned char*)RSA_SOCIO_N, sizeof(RSA_SOCIO_N), (unsigned char*)RSA_SOCIO_E, sizeof(RSA_SOCIO_E) };
  ESP.wdtFeed();
  if (br_rsa_i15_oaep_encrypt(&rng.vtable, &br_sha256_vtable, nullptr, 0, &pk, bin, 256, ultima_K, sizeof(ultima_K)) != 256) return 0;
  hay_K = true;
  rngBytes(bin + 256, 12);                                      // nonce
  memcpy(bin + 268, plano, n);
  aesGcm(ultima_K, sizeof(ultima_K), true, bin + 256, tema_tx_propio, bin + 268, n, bin + 268 + n);
  const size_t total = 268 + n + 16;
  if (5 + 4 * ((total + 2) / 3) > MSG_MAX) return 0;
  memcpy(msg_pend, "rsa1:", 5);
  return 5 + b64Enc(bin, total, (char*)msg_pend + 5);
}

/* Abre la respuesta "rsa1:..." con ultima_K. Deja el texto ("200 0\n{json}") dentro de `m` y devuelve su puntero (nullptr = no valida). */
static char* abrirRespuesta(uint8_t* m, size_t n) {
  if (!hay_K || n < 9 || memcmp(m, "rsa1:", 5) != 0) return nullptr;
  const int nb = b64DecEnSitio(m + 5, n - 5);
  if (nb < 12 + 16 + 1) return nullptr;
  uint8_t* bin = m + 5;
  const size_t nc = (size_t)nb - 28;
  if (!aesGcm(ultima_K, sizeof(ultima_K), false, bin, tema_rx_propio, bin + 12, nc, bin + 12 + nc)) return nullptr;
  bin[12 + nc] = 0;
  return (char*)(bin + 12);
}

/* ------------------------------ Radio ------------------------------ */
static void alRecibir(uint8_t* mac, uint8_t* d, uint8_t len) {  // callback del SDK: solo copia / encola
  (void)mac;
  if (len <= CAB || d[0] != MAGIA) return;
  const uint8_t  tipo = d[1];
  if (tipo != TIPO_DATOS && tipo != TIPO_RESP) return;
  const uint32_t id = leer32(d + 2), seq = leer32(d + 6);
  const uint8_t  idx = d[10] & 15, ttl = d[10] >> 4, total = d[11] & 15, intento = d[11] >> 4;
  const size_t   carga = len - CAB;
  if (total == 0 || total > MAX_FRAGS || idx >= total || carga > FRAG) return;
  if (idx + 1 < total && carga != FRAG) return;                 // solo el ultimo fragmento puede ser corto
  const bool mio = (id == mi_id);
  if (tipo == TIPO_DATOS && mio) return;                        // eco de mi propio envio retransmitido por un vecino
  if (yaVisto(tipo, id, seq, idx, intento)) return;             // ya lo vi (o ya lo reenvie)

  Slot* s = nullptr;
  if (tipo == TIPO_RESP && mio) s = &resp;                      // respuesta a mis datos
  else if (tipo == TIPO_DATOS && puede_subir) s = &dat;         // tengo red: lo subo yo
  if (s) {
    if (s->completo) return;                                    // el anterior aun no se atendio
    const uint32_t ahora = millis();
    if (s->activo && (s->id != id || s->seq != seq || s->total != total)) {
      if ((uint32_t)(ahora - s->t_ms) < 3000) return;           // hay otro en curso
      s->activo = false;
    }
    if (!s->activo) { s->activo = true; s->id = id; s->seq = seq; s->total = total; s->mask = 0; s->ttl = ttl; s->intento = intento; }
    if (s->mask & (1u << idx)) return;                          // fragmento repetido
    memcpy(s->buf + (size_t)idx * FRAG, d + CAB, carga);
    if (idx + 1 == total) s->ultimo = (uint16_t)carga;
    s->mask |= (uint8_t)(1u << idx);
    s->t_ms = ahora;
    if (s->mask == (uint8_t)((1u << total) - 1)) {
      s->n = (uint16_t)((size_t)(total - 1) * FRAG + s->ultimo);
      s->activo = false;
      s->completo = true;
    }
    return;
  }
  /* No es para mi / no puedo subirlo: lo retransmito (inundacion con TTL), tambien las respuestas ajenas de vuelta al origen. */
  if (ttl == 0 || (tipo == TIPO_RESP && mio)) return;
  for (uint8_t i = 0; i < 10; i++) {
    if (fwd[i].n != 0) continue;
    memcpy(fwd[i].d, d, len);
    fwd[i].d[10] = (uint8_t)(idx | ((ttl - 1) << 4));
    fwd[i].due = millis() + 5 + (RANDOM_REG32 % 36);
    fwd[i].n = len;
    return;
  }
}
static void alEnviar(uint8_t* mac, uint8_t estado) { (void)mac; (void)estado; tx_hecho = true; }

/* Difunde un mensaje "rsa1:..." partido en fragmentos. */
static bool enviarMensaje(uint8_t tipo, uint32_t id, uint32_t seq, const uint8_t* msg, size_t n, uint8_t ttl, uint8_t intento) {
  const uint8_t nfr = (uint8_t)((n + FRAG - 1) / FRAG);
  if (n == 0 || nfr > MAX_FRAGS) return false;
  uint8_t paq[CAB + FRAG];
  for (uint8_t i = 0; i < nfr; i++) {
    const size_t k = (n - (size_t)i * FRAG < FRAG) ? n - (size_t)i * FRAG : FRAG;
    paq[0] = MAGIA; paq[1] = tipo; poner32(paq + 2, id); poner32(paq + 6, seq);
    paq[10] = (uint8_t)(i | (ttl << 4)); paq[11] = (uint8_t)(nfr | (intento << 4));
    memcpy(paq + CAB, msg + (size_t)i * FRAG, k);
    tx_hecho = false;
    if (esp_now_send(BCAST, paq, (int)(CAB + k)) != 0) return false;
    const uint32_t t0 = millis();
    while (!tx_hecho && (uint32_t)(millis() - t0) < 40) delay(1);
    delay(2);                                                   // respiro para que el receptor termine de copiar el anterior
  }
  return true;
}

static void atenderReenvios() {
  for (uint8_t i = 0; i < 10; i++) {
    if (fwd[i].n == 0 || (int32_t)(millis() - fwd[i].due) < 0) continue;
    const uint8_t ttl = fwd[i].d[10] >> 4;
    esp_now_send(BCAST, fwd[i].d, fwd[i].n);
    Serial.printf("   reenvio fragmento %u/%u de nodo-%06x seq %lu (ttl restante %u)\n", (unsigned)((fwd[i].d[10] & 15) + 1), (unsigned)(fwd[i].d[11] & 15),
                  (unsigned)leer32(fwd[i].d + 2), (unsigned long)leer32(fwd[i].d + 6), (unsigned)ttl);
    fwd[i].n = 0;
    delay(3);
  }
}

/* ------------------------------ WiFi y servidor ------------------------------ */
#if USAR_WIFI
static void fijarCanalRadio(uint8_t c) {
  canal = c;
  esp_now_set_peer_channel(BCAST, canal);
}
static uint8_t canal_router = 0;                                // canal del router si ya se vio en un escaneo (0 = aun no se sabe)
static void conectarWifi(uint32_t ms) {
  t_wifi = millis();
  // Con el canal conocido se conecta sin escanear (mas rapido). Si el intento se queda "inactivo" (estado 0) se relanza cada 6 s.
  WiFi.begin(WIFI_SSID, WIFI_PASS, canal_router);
  Serial.printf("WiFi: conectando a %s ", WIFI_SSID);
  uint32_t t_begin = millis();
  for (uint32_t t0 = millis(); WiFi.status() != WL_CONNECTED && (uint32_t)(millis() - t0) < ms; ) {
    delay(250); Serial.print('.'); ESP.wdtFeed();
    if ((uint32_t)(millis() - t_begin) >= 6000 && WiFi.status() != WL_CONNECTED) { WiFi.disconnect(); WiFi.begin(WIFI_SSID, WIFI_PASS, canal_router); t_begin = millis(); }
  }
  if (WiFi.status() == WL_CONNECTED) {
    Serial.printf("\nWiFi OK, IP %s, canal %d (ESP-NOW usa este canal)\n", WiFi.localIP().toString().c_str(), (int)WiFi.channel());
    fijarCanalRadio((uint8_t)WiFi.channel());
  } else {
    WiFi.disconnect();
    // Sin conexion igual hay que oir a los vecinos: se busca el router por su nombre y se usa SU canal (ellos estan ahi).
    uint8_t c = CANAL;
    const int n = WiFi.scanNetworks();
    for (int i = 0; i < n; i++) {
      if (WiFi.SSID(i) == WIFI_SSID) { c = (uint8_t)WiFi.channel(i); canal_router = c; Serial.printf("\nWiFi: %s visible en el canal %d (rssi %d) pero no conecta", WIFI_SSID, (int)c, (int)WiFi.RSSI(i)); break; }
    }
    WiFi.scanDelete();
    Serial.printf("\nWiFi: no conecta (estado %d: 1=no ve la red, 4=clave mal, 6=rechazada o desconectada); solo radio en el canal %d%s; reintento en %d s\n", (int)WiFi.status(), (int)c, c == CANAL ? " (CANAL del sketch)" : " (el del router)", (int)WIFI_REINTENTO_S);
    wifi_set_channel(c);
    fijarCanalRadio(c);
  }
}
#endif

/* POST de una carga "rsa1:..." a la pasarela (/relay/nodo-<id>). `via`/`saltos` solo si la sube un relevo en nombre de otro.
   La respuesta queda en `out` (NUL-terminada). Devuelve el codigo HTTP (<= 0: sin conexion). */
static int postServidor(uint32_t id, const uint8_t* msg, size_t n, const char* via, int saltos, char* out, size_t cap, size_t* nout) {
  *nout = 0;
  WiFiClient cli;
  HTTPClient http;
  char uri[32];
  snprintf(uri, sizeof(uri), "/relay/nodo-%06x", (unsigned)id);
  if (!http.begin(cli, GATEWAY_HOST, GATEWAY_PORT, uri)) return -1;
  http.setTimeout(6000);
  http.addHeader("Content-Type", "text/plain");
  if (via) { http.addHeader("X-Via", via); http.addHeader("X-Saltos", String(saltos)); }
  int code = http.POST(msg, n);
  if (code > 0) {
    String r = http.getString();
    if (r.length() < cap) { memcpy(out, r.c_str(), r.length() + 1); *nout = r.length(); }
    else code = -3;
  }
  http.end();
  return code;
}

static void anotarFalloRed() {
  if (++fallos_red >= 2) {
    radio_hasta = millis() + RADIO_MS;
    fallos_red = 0;
    Serial.printf("   RED: 2 fallos seguidos -> uso la radio %lu s\n", (unsigned long)(RADIO_MS / 1000));
  }
}

/* ------------------------------ Datos que se envian ------------------------------ */
/* >>> AQUI se arma el JSON de sus datos. Los valores son FALSOS; cambielos por lecturas reales. Formato del contrato (docs/contrato-api.md):
   si falta algun campo el dashboard lo acepta; solo `seq` es obligatorio. <<< */
static float aleatorio(float a, float b) { return a + (b - a) * (float)random(0, 10000) / 10000.0f; }
static size_t armarJson(char* out, size_t cap) {
  return snprintf(out, cap,
      "{\"v\":1,\"fw\":\"malla-1\",\"boot\":%lu,\"seq\":%lu,\"up\":%lu,\"temp\":%.1f,\"hum_aire\":%.1f,\"suelo_raw\":%d,"
      "\"luz\":null,\"bomba\":0,\"riego_s\":0,\"est\":\"idle\",\"esp\":0,\"rssi\":%d,\"fallas\":[]}",
      (unsigned long)boot_id, (unsigned long)envios, (unsigned long)(millis() / 1000), aleatorio(22.5f, 25.5f), aleatorio(56.0f, 64.0f),
      (int)random(560, 640), (WiFi.status() == WL_CONNECTED ? (int)WiFi.RSSI() : -90));
}

static void mostrarRespuesta(char* texto, const char* origen) {
  if (!texto) { Serial.printf("<< respuesta de %s RECHAZADA (etiqueta invalida)\n", origen); return; }
  char* nl = strchr(texto, '\n');
  if (nl) *nl = 0;
  Serial.printf("<< respuesta recibida (%s): HTTP %s  %.90s\n", origen, texto, nl ? nl + 1 : "");
}

static void enviarRadio() {
  const bool ok = enviarMensaje(TIPO_DATOS, mi_id, pend_seq, msg_pend, pend_n, MAX_SALTOS, pend_intento);
  Serial.printf(">> RADIO envio %lu, intento %u/%u, ttl %u: %s\n", (unsigned long)pend_seq, (unsigned)(pend_intento + 1), (unsigned)MAX_INTENTOS, (unsigned)MAX_SALTOS,
                ok ? "difundido" : "FALLO al enviar");
  esperando = ok;
  pend_t = millis();
}

static void enviarDato() {
  envios++;
  static char plano[PLANO_MAX + 1];
  const size_t lt = snprintf(plano, sizeof(plano), "%s\n", mi_nombre);
  const size_t lj = armarJson(plano + lt, sizeof(plano) - lt);
  const uint32_t t0 = millis();
  const size_t n = cifrarParaServidor(plano, lt + lj);
  if (n == 0) { Serial.println("ERROR: no se pudo cifrar con la clave publica del servidor (RSA_SOCIO_*)"); return; }
  pend_n = n; pend_seq = envios; pend_intento = 0; esperando = false;
  Serial.printf("\n>> envio %lu: %u bytes cifrados (cifrar %lu ms)\n   json: %s\n", (unsigned long)pend_seq, (unsigned)n, (unsigned long)(millis() - t0), plano + lt);

  if (!FORZAR_RADIO && puede_subir) {
    size_t nr = 0;
    const int code = postServidor(mi_id, msg_pend, n, nullptr, 0, repl, sizeof(repl), &nr);
    if (code == 200) {
      fallos_red = 0;
      mostrarRespuesta(abrirRespuesta((uint8_t*)repl, nr), "servidor, directo");
      return;
    }
    if (code > 0 && code < 500) { Serial.printf("   servidor respondio HTTP %d (la radio no ayuda)\n", code); fallos_red = 0; return; }
    Serial.printf("   servidor sin respuesta (HTTP %d) -> lo mando por radio\n", code);
    anotarFalloRed();
  } else if (FORZAR_RADIO) {
    Serial.println("   FORZAR_RADIO 1 -> por radio");
  } else {
    Serial.println("   sin ruta a la red -> por radio");
  }
  enviarRadio();
}

/* Un vecino sin red me manda datos y YO tengo red: los subo en su nombre y le devuelvo la respuesta (cifrada para el, yo no la abro). */
static void subirComoRelevo() {
  const uint32_t id = dat.id, seq = dat.seq;
  const uint8_t intento = dat.intento;                            // la respuesta lleva el mismo intento: asi los vecinos no la descartan como repetida
  int saltos = (int)MAX_SALTOS - (int)dat.ttl + 1;               // recibido con ttl = MAX_SALTOS => llego directo => 1 salto
  if (saltos < 1) saltos = 1;
  if (saltos > 15) saltos = 15;
  char via[16];
  snprintf(via, sizeof(via), "nodo-%06x", (unsigned)mi_id);
  Serial.printf("\n<< datos de nodo-%06x (seq %lu, %u bytes, %d salto(s) por radio): los subo yo\n", (unsigned)id, (unsigned long)seq, (unsigned)dat.n, saltos);
  size_t nr = 0;
  const int code = postServidor(id, dat.buf, dat.n, via, saltos, repl, sizeof(repl), &nr);
  dat.completo = false;
  if (code == 200 && nr > 0) {
    fallos_red = 0;
    const bool ok = enviarMensaje(TIPO_RESP, id, seq, (const uint8_t*)repl, nr, MAX_SALTOS, intento);
    Serial.printf(">> subido via mi (nodo-%06x): la pasarela contesto, respuesta %s hacia nodo-%06x\n", (unsigned)mi_id, ok ? "difundida" : "NO se pudo difundir", (unsigned)id);
  } else {
    Serial.printf("   no pude subirlo (HTTP %d)\n", code);
    if (code <= 0 || code >= 500) anotarFalloRed();
  }
}

static void atenderAcuse() {
  char* texto = nullptr;
  const bool mio = esperando && resp.seq == pend_seq;
  if (mio) texto = abrirRespuesta(resp.buf, resp.n);
  if (mio) {
    mostrarRespuesta(texto, "por la malla");
    if (texto) esperando = false;
  }
  resp.completo = false;
}

/* ------------------------------ setup / loop ------------------------------ */
void setup() {
  Serial.begin(115200);
  delay(300);
  system_update_cpu_freq(SYS_CPU_160MHZ);
  mi_id = ESP.getChipId();
  boot_id = RANDOM_REG32;
  randomSeed(RANDOM_REG32);
  rngIniciar();
  snprintf(tema_tx_propio, sizeof(tema_tx_propio), "invernadero/nodo-%06x/tx", (unsigned)mi_id);
  snprintf(tema_rx_propio, sizeof(tema_rx_propio), "invernadero/nodo-%06x/rx", (unsigned)mi_id);
  Serial.println("\n\n=== Malla ESP-NOW ===");

  WiFi.persistent(false);
  WiFi.setAutoReconnect(false);                                 // el reintento lo controlo yo (un escaneo constante estorba a la radio)
  WiFi.mode(WIFI_STA);
  WiFi.disconnect();
#if !USAR_WIFI
  wifi_set_channel(CANAL);                                      // sin WiFi la radio se queda en CANAL; con WiFi el canal lo decide el router
#endif
  if (esp_now_init() != 0) { Serial.println("ERROR: esp_now_init"); return; }
  esp_now_set_self_role(ESP_NOW_ROLE_COMBO);
  esp_now_add_peer(BCAST, ESP_NOW_ROLE_COMBO, canal, nullptr, 0);
  esp_now_register_recv_cb(alRecibir);
  esp_now_register_send_cb(alEnviar);
#if USAR_WIFI
  conectarWifi(20000);
#endif

  for (size_t i = 0; i < sizeof(RSA_SOCIO_N); i++) if (RSA_SOCIO_N[i]) { srv_ok = true; break; }
  { const char* w = MI_ID; bool bien = w[0] && strlen(w) <= 40; for (const char* p = w; *p && bien; p++) bien = isalnum((unsigned char)*p) || *p == 0x2D || *p == 0x5F; if (bien) snprintf(mi_nombre, sizeof(mi_nombre), "%s", w); else snprintf(mi_nombre, sizeof(mi_nombre), "nodo-%06x", (unsigned)mi_id); }
  Serial.printf("MAC de esta placa: %s\n", WiFi.macAddress().c_str());
  Serial.printf("id nodo-%06x · canal ESP-NOW %d · saltos max %d\n", (unsigned)mi_id, (int)canal, (int)MAX_SALTOS);
  Serial.printf("clave publica del servidor: %s · identificador: %s\n", srv_ok ? "cargada" : "FALTA (pegar-claves.mjs)", mi_nombre);
  Serial.printf("servidor: http://%s:%d  · %s\n", GATEWAY_HOST, (int)GATEWAY_PORT, FORZAR_RADIO ? "FORZAR_RADIO (mis datos van siempre por radio)" : "mis datos van por la red y, si falla, por radio");
  t_envio = millis() - (uint32_t)PERIODO_S * 1000UL + 4000UL;   // primer envio a los ~4 s
}

void loop() {
  ESP.wdtFeed();
#if USAR_WIFI
  const bool wifi = WiFi.status() == WL_CONNECTED;
  if (wifi && (uint8_t)WiFi.channel() != canal) fijarCanalRadio((uint8_t)WiFi.channel());
  if (!wifi && (uint32_t)(millis() - t_wifi) >= (uint32_t)WIFI_REINTENTO_S * 1000UL && !esperando) conectarWifi(10000);
  puede_subir = wifi && (int32_t)(millis() - radio_hasta) >= 0;
#else
  puede_subir = false;
#endif

  if (resp.completo) atenderAcuse();
  if (dat.completo) subirComoRelevo();
  atenderReenvios();

  if (esperando && (uint32_t)(millis() - pend_t) >= ESPERA_ACUSE_MS) {
    if ((uint8_t)(pend_intento + 1) < MAX_INTENTOS) { pend_intento++; Serial.printf("   sin respuesta para el envio %lu; reintento por radio\n", (unsigned long)pend_seq); enviarRadio(); }
    else { Serial.printf("   sin respuesta para el envio %lu tras %u intentos: lo doy por perdido\n", (unsigned long)pend_seq, (unsigned)MAX_INTENTOS); esperando = false; }
  }
  if (PERIODO_S > 0 && srv_ok && !esperando && (uint32_t)(millis() - t_envio) >= (uint32_t)PERIODO_S * 1000UL) {
    t_envio = millis();
    enviarDato();
  }
  delay(2);
}
