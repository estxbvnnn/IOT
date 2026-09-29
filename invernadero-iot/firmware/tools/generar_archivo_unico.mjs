#!/usr/bin/env node
/* =====================================================================
   generar_archivo_unico.mjs  -  Arma el sketch de UN SOLO ARCHIVO para Arduino IDE

   Lee los archivos modulares de firmware/nodo_invernadero (la FUENTE) y escribe
       firmware/nodo_invernadero_unico/nodo_invernadero_unico.ino
   con todo el firmware adentro: sin #include locales, sin secrets.h y sin depender
   de ningun otro archivo.

   Uso (desde la carpeta raiz del proyecto):
     npm run firmware:unico          genera o actualiza el archivo
     npm run firmware:unico:check    falla (codigo 1) si el archivo no coincide con las fuentes

   Que hace con cada archivo modular, en este orden (el mismo en que hoy los incluye
   nodo_invernadero.ino, asi que el resultado es equivalente):
     config.h -> riego.h -> envio.h -> protocolo.h -> sensores.h -> red.h -> cuerpo del .ino
     - quita la guarda de inclusion (#ifndef X_H / #define X_H / #endif // X_H);
     - quita los #include locales (su contenido ya esta antes) y junta los #include <...>
       de sistema, sin repetir, en un solo bloque al inicio;
     - red.h: reemplaza la carga de secrets.h por una referencia al bloque
       "CONFIGURACION DEL USUARIO" (derivado de secrets.example.h);
     - cambia el texto de 2 mensajes de consola y 3 comentarios que nombraban secrets.h.
   Adiciones propias del archivo unico: el banner con los pasos para Arduino IDE, el bloque
   de configuracion del usuario y un #error claro si la placa elegida no es ESP32.

   Es determinista (no escribe fechas) y ESTRICTO: si una fuente cambia de forma que este
   script ya no la entiende, se detiene con un error en vez de generar algo distinto.
   ===================================================================== */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const FIRMWARE = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const RAIZ = resolve(FIRMWARE, '..')
const ORIGEN = join(FIRMWARE, 'nodo_invernadero')
const DESTINO = join(FIRMWARE, 'nodo_invernadero_unico', 'nodo_invernadero_unico.ino')
const MODO_CHECK = process.argv.includes('--check')
const rel = (ruta) => relative(RAIZ, ruta).split('\\').join('/')

class ErrorGenerador extends Error {}
const fallar = (mensaje) => {
  throw new ErrorGenerador(mensaje)
}

/* ---------------------------------------------------------------------
   Fuentes
   --------------------------------------------------------------------- */
const INO = 'nodo_invernadero.ino'
const EJEMPLO_SECRETOS = 'secrets.example.h'

/** Orden de union. Cada cabecera solo puede incluir localmente las que van antes. */
const HEADERS = [
  { archivo: 'config.h', guarda: 'CONFIG_H', titulo: 'config.h  -  pines, tiempos y opciones del nodo' },
  { archivo: 'riego.h', guarda: 'RIEGO_H', titulo: 'riego.h  -  reglas del riego (logica pura)' },
  { archivo: 'envio.h', guarda: 'ENVIO_H', titulo: 'envio.h  -  cuando enviar y reintentar tramas (logica pura)' },
  { archivo: 'protocolo.h', guarda: 'PROTOCOLO_H', titulo: 'protocolo.h  -  JSON de la trama y de la respuesta' },
  { archivo: 'sensores.h', guarda: 'SENSORES_H', titulo: 'sensores.h  -  DHT22, YL-38, BH1750, anemometro y rele' },
  { archivo: 'red.h', guarda: 'RED_H', titulo: 'red.h  -  WiFi y HTTP(S) en una tarea aparte' },
]
const TOTAL_SECCIONES = HEADERS.length + 2 // configuracion del usuario + cabeceras + cuerpo del .ino

/** Lee un archivo modular: saltos LF y solo ASCII (como todo el firmware). */
function leer(nombre) {
  const ruta = join(ORIGEN, nombre)
  if (!existsSync(ruta)) fallar(`falta ${nombre} en ${rel(ORIGEN)}`)
  const texto = readFileSync(ruta, 'utf8').replace(/\r\n/g, '\n')
  const noAscii = /[^\x00-\x7f]/.exec(texto)
  if (noAscii) fallar(`${nombre} contiene un caracter no ASCII (${JSON.stringify(noAscii[0])}); el firmware es ASCII`)
  return texto
}

/** Reemplaza `viejo` por `nuevo` exigiendo que `viejo` aparezca exactamente una vez. */
function reemplazarUnaVez(texto, viejo, nuevo, donde) {
  const i = texto.indexOf(viejo)
  if (i < 0 || texto.indexOf(viejo, i + 1) >= 0) {
    fallar(`${donde}: se esperaba encontrar exactamente una vez: ${JSON.stringify(viejo.slice(0, 80))}`)
  }
  return texto.slice(0, i) + nuevo + texto.slice(i + viejo.length)
}

const recortar = (t) => t.replace(/^\n+/, '').replace(/\n+$/, '')
const compactar = (t) => t.replace(/\n{3,}/g, '\n\n')

/* ---------------------------------------------------------------------
   Adaptaciones de texto (solo donde el texto nombraba secrets.h)
   --------------------------------------------------------------------- */
const SECRETOS_VIEJO = [
  '/* Credenciales: secrets.h (no se sube a Git). Si no existe, se usa la plantilla de ejemplo y',
  '   el nodo funciona en modo local. */',
  '#if __has_include("secrets.h")',
  '  #include "secrets.h"',
  '#else',
  '  #include "secrets.example.h"',
  '#endif',
].join('\n')

const SECRETOS_NUEVO = [
  '/* Credenciales (WIFI_SSID, WIFI_PASS, SERVER_URL, DEVICE_TOKEN, CA_ROOT_PEM...): salen del bloque',
  '   CONFIGURACION DEL USUARIO, al inicio de este archivo. Con los valores de ejemplo el nodo funciona',
  '   en modo local. */',
].join('\n')

const ADAPTACIONES = {
  'config.h': [
    ['   servidor, token) va en secrets.h, NO aqui.', '   servidor, token) va en el bloque CONFIGURACION DEL USUARIO (arriba), NO aqui.'],
  ],
  'red.h': [
    [SECRETOS_VIEJO, SECRETOS_NUEVO],
    ['// verifica la cadena contra la CA de secrets.h', '// verifica la cadena contra la CA de CA_ROOT_PEM'],
    [
      '"RED: secrets.h con valores de ejemplo -> sin conexion. El riego local sigue funcionando."',
      '"RED: la CONFIGURACION DEL USUARIO tiene valores de ejemplo -> sin conexion. El riego local sigue funcionando."',
    ],
    [
      '"RED: SERVER_URL es https:// pero secrets.h no define CA_ROOT_PEM (ni TLS_INSEGURO para desarrollo)."',
      '"RED: SERVER_URL es https:// pero la CONFIGURACION DEL USUARIO no define CA_ROOT_PEM (ni TLS_INSEGURO para desarrollo)."',
    ],
  ],
}

/* ---------------------------------------------------------------------
   #include: los locales se descartan (ya estan antes); los de sistema se juntan
   --------------------------------------------------------------------- */
function tomarIncludes(texto, donde, permitidosLocales, sistema) {
  const resto = []
  for (const linea of texto.split('\n')) {
    const m = /^#[ \t]*include[ \t]*([<"])([^>"]+)[>"][ \t]*$/.exec(linea)
    if (!m) {
      resto.push(linea)
      continue
    }
    const [, tipo, nombre] = m
    if (tipo === '<') {
      if (!sistema.includes(nombre)) sistema.push(nombre)
    } else if (!permitidosLocales.has(nombre)) {
      fallar(`${donde}: incluye "${nombre}", que no esta antes en el orden de union (${[...permitidosLocales].join(', ') || 'ninguno'})`)
    }
  }
  return resto.join('\n')
}

function prepararHeader({ archivo, guarda }, emitidos, sistema) {
  let t = leer(archivo)
  for (const [viejo, nuevo] of ADAPTACIONES[archivo] ?? []) t = reemplazarUnaVez(t, viejo, nuevo, archivo)
  t = reemplazarUnaVez(t, `#ifndef ${guarda}\n#define ${guarda}\n`, '', archivo)
  const cierre = `\n#endif  // ${guarda}\n`
  if (!t.endsWith(cierre)) fallar(`${archivo}: debe terminar con "#endif  // ${guarda}"`)
  t = t.slice(0, t.length - cierre.length) + '\n'
  t = tomarIncludes(t, archivo, emitidos, sistema)
  emitidos.add(archivo)
  return recortar(compactar(t))
}

/** Cuerpo del .ino: sin el aviso inicial, sin el comentario de cabecera y sin los #include. */
function prepararIno(headersConocidos, sistema) {
  let t = leer(INO)
  t = t.replace(/^(?:\/\/[^\n]*\n)+/, '') // aviso de 3 lineas que apunta al archivo unico
  if (!t.startsWith('/* =====')) fallar(`${INO}: despues del aviso debe venir el comentario de cabecera "/* ===== ... */"`)
  const finCabecera = t.indexOf('*/\n')
  if (finCabecera < 0) fallar(`${INO}: no se encontro el fin del comentario de cabecera`)
  t = t.slice(finCabecera + 3)
  t = tomarIncludes(t, INO, headersConocidos, sistema)
  t = recortar(compactar(t))
  if (!t.startsWith('/* ------')) fallar(`${INO}: despues de los #include se esperaba el comentario "ESTADO GLOBAL"`)
  return t
}

/* ---------------------------------------------------------------------
   Valores derivados de las fuentes
   --------------------------------------------------------------------- */
function versionDelFirmware(config) {
  const m = /#define FW_VERSION "([^"]+)"/.exec(config)
  if (!m) fallar('config.h: no se encontro #define FW_VERSION "..."')
  return m[1]
}

function valorPorDefecto(config, nombre) {
  const m = new RegExp(`#ifndef ${nombre}\\n#define ${nombre}\\s+(\\d+)`).exec(config)
  if (!m) fallar(`config.h: no se encontro el valor por defecto de ${nombre} (#ifndef ${nombre} / #define ${nombre} n)`)
  return m[1]
}

const OPCIONES = [
  ['NODO_MASTIL', 'nodo del mastil: SIN suelo ni bomba (solo DHT22 y viento)'],
  ['USAR_ANEMOMETRO', 'lee el anemometro (usar junto con NODO_MASTIL 1)'],
  ['USAR_BH1750', 'busca el sensor de luz BH1750 (si no responde, "luz" va null y no es falla)'],
  ['CONSOLA_SERIAL', 'comandos por USB: r = regar 10 s, p = parar, s = estado (0 en produccion)'],
]

/* ---------------------------------------------------------------------
   Piezas de texto del archivo unico
   --------------------------------------------------------------------- */
const BARRA = '='.repeat(69)
const ALMOHADILLAS = '#'.repeat(69)

function seccion(numero, titulo) {
  return [`/* ${ALMOHADILLAS}`, `   SECCION ${numero} de ${TOTAL_SECCIONES}:  ${titulo}`, `   ${ALMOHADILLAS} */`].join('\n')
}

function banner(version) {
  return [
    `/* ${BARRA}`,
    '   NODO DEL INVERNADERO  -  monitoreo y riego automatico (ESP32)',
    `   ARCHIVO UNICO PARA ARDUINO IDE  -  firmware ${version}`,
    '   DHT22 + YL-38/YL-69 + bomba de agua por rele  ->  dashboard (Supabase)',
    '',
    '   TODO el firmware esta en ESTE archivo: no necesita secrets.h ni ningun otro',
    '   archivo. Puede copiarlo solo, a cualquier carpeta de sketches.',
    '',
    '   PASOS (Arduino IDE 1.8 o 2.x)',
    '   1) Placa ESP32 (una sola vez):',
    '        Archivo > Preferencias > "URLs adicionales del gestor de tarjetas":',
    '          https://espressif.github.io/arduino-esp32/package_esp32_index.json',
    '        Herramientas > Placa > Gestor de tarjetas > instalar',
    '          "esp32 by Espressif Systems"  (la version modular se compilo con la 3.3.12)',
    '   2) Bibliotecas (una sola vez): Herramientas > Administrar bibliotecas',
    '          "DHT sensor library" y "Adafruit Unified Sensor"  (Adafruit)',
    '          "ArduinoJson"  (Benoit Blanchon), version 7.x',
    '   3) Edite SOLO el bloque "CONFIGURACION DEL USUARIO" (mas abajo):',
    '        WIFI_SSID, WIFI_PASS, SERVER_URL y DEVICE_TOKEN.',
    '   4) Herramientas > Placa: "ESP32 Dev Module" (mapa de pines de la ESP32 DevKit V1,',
    '      tabla 18 del informe) o "Heltec WiFi LoRa 32(V2)" (mapa alternativo: se',
    '      detecta solo). Elija el Puerto, pulse Subir y abra el Monitor Serie a 115200.',
    '',
    '   TENGA EN CUENTA',
    '   - SERVER_URL debe ser la IP del PC en la red local (ej.: http://192.168.1.50:3000),',
    '     con el dashboard iniciado con "npm run dev:lan" y el puerto 3000 permitido en el',
    '     Firewall de Windows. "localhost" NO sirve: para el ESP32 "localhost" es el propio',
    '     ESP32.',
    '   - Solo para placas ESP32. No sirve en Arduino UNO, Nano ni Mega.',
    '   - Sin WiFi ni servidor (o con los valores de ejemplo) el nodo igual riega de forma',
    '     autonoma y muestra el estado por el Monitor Serie.',
    '   - Con sus claves reales (WiFi, token) este archivo es sensible: si lo sube a Git,',
    '     que sea a un repositorio PRIVADO.',
    '',
    '   ESTE ARCHIVO ESTA GENERADO',
    '   Nace de los archivos de firmware/nodo_invernadero (la fuente, con pruebas de host).',
    '   Si va a cambiar la logica, edite esos archivos y vuelva a generar este con',
    '        npm run firmware:unico        (desde la carpeta raiz del proyecto)',
    '   Diferencias con la version modular: la configuracion esta arriba (no hay',
    '   secrets.h), 2 mensajes de consola y 3 comentarios que nombraban secrets.h, y',
    '   el #error de placa no soportada.',
    '',
    '   ORDEN DEL ARCHIVO (cada seccion viene del archivo modular indicado)',
    '     1. Configuracion del usuario (WiFi, servidor, token, opciones)',
    '     2. config.h      pines (2 mapas), tiempos, opciones',
    '     3. riego.h       reglas del riego (logica pura, probada en el PC)',
    '     4. envio.h       cuando enviar y reintentar tramas (logica pura, probada en el PC)',
    '     5. protocolo.h   JSON de la trama y de la respuesta (docs/contrato-api.md)',
    '     6. sensores.h    DHT22, YL-38, BH1750, anemometro y rele',
    '     7. red.h         WiFi + HTTP(S) en una tarea aparte (nucleo 0)',
    '     8. nodo_invernadero.ino   setup() y loop(): une todo',
    '',
    '   REGLA DE ORO: loop() NUNCA espera a la red. El corte de la bomba por tiempo se',
    '   evalua en cada vuelta (cada ~10 ms).',
    `   ${BARRA} */`,
    '',
    '#if !defined(ARDUINO_ARCH_ESP32)',
    '  #error "Este firmware es solo para placas ESP32: en Herramientas > Placa elija ESP32 Dev Module o Heltec WiFi LoRa 32(V2). No sirve en Arduino UNO, Nano ni Mega."',
    '#endif',
  ].join('\n')
}

function bloqueIncludes(sistema) {
  if (sistema[0] !== 'Arduino.h') fallar(`el primer #include de sistema debe ser <Arduino.h> (es <${sistema[0]}>)`)
  return [
    `/* ${'-'.repeat(69)}`,
    '   BIBLIOTECAS (las de ESP32 vienen con la placa; DHT y ArduinoJson se instalan aparte)',
    `   ${'-'.repeat(69)} */`,
    ...sistema.map((h) => `#include <${h}>`),
  ].join('\n')
}

/** Bloque de configuracion: derivado de secrets.example.h, mas las opciones de config.h. */
function bloqueUsuario(config) {
  const ejemplo = leer(EJEMPLO_SECRETOS)
  const abre = '#ifndef SECRETS_H\n#define SECRETS_H\n'
  const cierre = '\n#endif  // SECRETS_H\n'
  const i = ejemplo.indexOf(abre)
  if (i < 0 || !ejemplo.endsWith(cierre)) fallar(`${EJEMPLO_SECRETOS}: se esperaba la guarda #ifndef SECRETS_H ... #endif  // SECRETS_H`)
  const credenciales = recortar(ejemplo.slice(i + abre.length, ejemplo.length - cierre.length))
  for (const macro of ['WIFI_SSID', 'WIFI_PASS', 'SERVER_URL', 'DEVICE_TOKEN']) {
    if (!new RegExp(`^#define ${macro}\\s`, 'm').test(credenciales)) fallar(`${EJEMPLO_SECRETOS}: falta #define ${macro}`)
  }

  const opciones = OPCIONES.map(([nombre, descripcion]) => {
    const porDefecto = valorPorDefecto(config, nombre)
    const otro = porDefecto === '0' ? '1' : '0'
    return `// #define ${nombre.padEnd(16)} ${otro}   // ${descripcion}  [por defecto ${porDefecto}]`
  })

  return [
    seccion(1, 'CONFIGURACION DEL USUARIO  (WiFi, servidor, token y opciones)'),
    '',
    '/* Es lo UNICO que hay que editar. Mientras WIFI_SSID o DEVICE_TOKEN tengan los valores de',
    '   ejemplo, el nodo NO intenta conectarse: solo riega de forma autonoma y muestra el estado',
    '   por el Monitor Serie. */',
    '',
    credenciales,
    '',
    '/* Opciones del nodo (todas opcionales). Los valores por defecto ya sirven para un nodo de',
    '   riego: solo quite el // de la linea que quiera cambiar. */',
    ...opciones,
    '// #define PLACA_HELTEC_V2                // fuerza el mapa de pines de la Heltec V2 (con la placa Heltec se detecta sola)',
  ].join('\n')
}

/* ---------------------------------------------------------------------
   Verificaciones del resultado
   --------------------------------------------------------------------- */
function verificar(salida, sistema, textoBanner) {
  const noAscii = /[^\x00-\x7f]/.exec(salida)
  if (noAscii) fallar(`el resultado tiene un caracter no ASCII: ${JSON.stringify(noAscii[0])}`)
  if (salida.includes('\r')) fallar('el resultado tiene retornos de carro (\\r)')

  const local = /^[ \t]*#[ \t]*include[ \t]*"/m.exec(salida)
  if (local) fallar('quedo un #include "..." local en el resultado')
  if (/__has_include/.test(salida)) fallar('quedo un __has_include en el resultado')
  if (/secrets/i.test(salida.slice(textoBanner.length))) fallar('el resultado menciona "secrets" fuera del banner')

  const incluidos = salida.split('\n').filter((l) => /^[ \t]*#[ \t]*include\b/.test(l))
  const esperados = sistema.map((h) => `#include <${h}>`)
  if (incluidos.length !== esperados.length || incluidos.some((l, k) => l !== esperados[k])) {
    fallar('los #include del resultado no son exactamente el bloque unico de sistema')
  }

  for (const firma of [/^void setup\(\) \{$/m, /^void loop\(\) \{$/m]) {
    const n = (salida.match(new RegExp(firma.source, 'gm')) ?? []).length
    if (n !== 1) fallar(`se esperaba exactamente una definicion de ${firma.source} y hay ${n}`)
  }

  // Condicionales del preprocesador balanceados (ignorando comentarios).
  const sinComentarios = salida.replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, '')).replace(/\/\/[^\n]*/g, '')
  const pila = []
  sinComentarios.split('\n').forEach((linea, k) => {
    const m = /^[ \t]*#[ \t]*(ifdef|ifndef|if|elif|else|endif)\b/.exec(linea)
    if (!m) return
    if (m[1] === 'if' || m[1] === 'ifdef' || m[1] === 'ifndef') pila.push(k + 1)
    else if (m[1] === 'endif') {
      if (!pila.length) fallar(`#endif sin #if (linea ${k + 1} del resultado)`)
      pila.pop()
    } else if (!pila.length) fallar(`#${m[1]} fuera de un #if (linea ${k + 1} del resultado)`)
  })
  if (pila.length) fallar(`#if sin cerrar (linea ${pila[pila.length - 1]} del resultado)`)
}

/* ---------------------------------------------------------------------
   Armado
   --------------------------------------------------------------------- */
function generar() {
  const sistema = []
  const nombresHeaders = new Set(HEADERS.map((h) => h.archivo))

  // El .ino va primero solo para que SUS #include de sistema abran la lista (igual que hoy).
  const cuerpoIno = prepararIno(nombresHeaders, sistema)
  const emitidos = new Set()
  const cuerpos = HEADERS.map((h) => prepararHeader(h, emitidos, sistema))

  const config = leer('config.h')
  const textoBanner = banner(versionDelFirmware(config))

  const partes = [
    textoBanner,
    bloqueIncludes(sistema),
    bloqueUsuario(config),
    ...HEADERS.map((h, k) => `${seccion(k + 2, h.titulo)}\n\n${cuerpos[k]}`),
    `${seccion(TOTAL_SECCIONES, 'nodo_invernadero.ino  -  setup() y loop(): une todo')}\n\n${cuerpoIno}`,
  ]
  const salida = partes.join('\n\n') + '\n'
  verificar(salida, sistema, textoBanner)
  return salida
}

function main() {
  const salida = generar()
  const lineas = salida.split('\n').length - 1

  if (MODO_CHECK) {
    if (!existsSync(DESTINO)) {
      console.error(`FALLA: no existe ${rel(DESTINO)}. Genere el archivo con: npm run firmware:unico`)
      process.exit(1)
    }
    const actual = readFileSync(DESTINO, 'utf8').replace(/\r\n/g, '\n')
    if (actual !== salida) {
      const a = actual.split('\n')
      const b = salida.split('\n')
      let k = 0
      while (k < a.length && k < b.length && a[k] === b[k]) k++
      console.error(`FALLA: ${rel(DESTINO)} no coincide con lo que generan los archivos modulares (primera diferencia en la linea ${k + 1}).`)
      console.error('Regenerelo con: npm run firmware:unico')
      process.exit(1)
    }
    console.log(`OK: ${rel(DESTINO)} esta al dia (${lineas} lineas).`)
    return
  }

  mkdirSync(dirname(DESTINO), { recursive: true })
  writeFileSync(DESTINO, salida, 'utf8')
  console.log(`Generado ${rel(DESTINO)}: ${lineas} lineas, ${Buffer.byteLength(salida)} bytes, a partir de ${HEADERS.length + 2} archivos de ${rel(ORIGEN)}.`)
}

try {
  main()
} catch (e) {
  if (e instanceof ErrorGenerador) {
    console.error(`ERROR del generador: ${e.message}`)
    process.exit(1)
  }
  throw e
}
