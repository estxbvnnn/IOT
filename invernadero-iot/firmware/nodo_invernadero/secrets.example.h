/* =====================================================================
   secrets.example.h  -  PLANTILLA de credenciales

   1) Copie este archivo con el nombre  secrets.h  (en esta misma carpeta).
   2) Complete los valores. secrets.h esta en .gitignore: NO se sube a Git.

   Mientras DEVICE_TOKEN o WIFI_SSID tengan los valores de ejemplo, el nodo
   NO intenta conectarse: solo riega de forma autonoma y muestra el estado
   por el Monitor Serie.
   ===================================================================== */
#ifndef SECRETS_H
#define SECRETS_H

/* Red WiFi del predio (2,4 GHz) */
#define WIFI_SSID     "NOMBRE_DE_LA_RED"
#define WIFI_PASS     "CLAVE_DE_LA_RED"

/* Direccion del dashboard, SIN barra final.
   Desarrollo (misma red):  http://192.168.1.50:3000   (npm run dev:lan en el dashboard)
   Produccion:              https://su-dominio.cl                                        */
#define SERVER_URL    "http://192.168.1.50:3000"

/* Token unico de ESTE nodo. Lo entrega el dashboard (Equipos > Alta de nodo o
   Rotar token) y solo se muestra una vez. Nunca lo comparta ni lo suba a Git. */
#define DEVICE_TOKEN  "PEGAR_AQUI_EL_TOKEN_DEL_NODO"

/* HTTPS: pegar el certificado raiz (CA) que firma el certificado del servidor.
   Ejemplo (una sola cadena, con \n al final de cada linea):
   #define CA_ROOT_PEM "-----BEGIN CERTIFICATE-----\nMIID...\n-----END CERTIFICATE-----\n"  */
// #define CA_ROOT_PEM ""

/* SOLO PARA DESARROLLO: acepta cualquier certificado HTTPS (sin verificar al servidor).
   Deja el trafico expuesto a un intermediario. NO usar en produccion. */
// #define TLS_INSEGURO

#endif  // SECRETS_H
