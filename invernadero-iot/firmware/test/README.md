# Pruebas de host del firmware

La lógica de seguridad del nodo está escrita **sin depender de Arduino** para poder probarla en el PC,
sin placa y en milisegundos. El "reloj" de las pruebas es una variable: se simulan horas de operación
y se cruza el desborde de `millis()` (cada ~49,7 días) sin esperar.

| Archivo | Prueba | Qué comprueba |
|---|---|---|
| `test_riego.cpp` | `riego.h` | Arranque seguro; histéresis; corte por tiempo exacto y tras un retraso grande del bucle; espera entre riegos; bloqueo por temperatura (y por temperatura inválida); banda SATURADO; sensor inválido; órdenes aceptadas / rechazadas / vencidas / duplicadas / acortadas; `parar`; configuración inválida ignorada completa; desborde de `millis()`; marcas de tiempo hacia atrás; colas de 8; y una prueba de propiedades (6 h simuladas con datos aleatorios) que verifica que **ningún riego supera el máximo y que siempre se respeta la espera** |
| `test_envio.cpp` | `envio.h` | Cuándo se envía; reintento de la misma trama (3 intentos); espera creciente; 401 / 429 / 400 / 413; tiempo máximo en vuelo; desborde de `millis()` |
| `test_protocolo.cpp` | `protocolo.h` | Trama JSON exacta y válida (nulos, escapes, extremos numéricos, peor caso de tamaño); análisis de la respuesta del contrato, `cfg` parcial e inválida, y órdenes hostiles |

No usan frameworks: solo `mini_test.h`.

## Ejecutar

**Linux / macOS / Windows con MinGW-w64 (g++ o clang++):**

```bash
cd firmware/test
ARDUINOJSON_DIR=/ruta/a/libraries/ArduinoJson/src ./ejecutar_pruebas.sh
```

**Windows con Visual Studio Build Tools (MSVC):** abrir el *Símbolo del sistema para desarrolladores* y

```bat
cd firmware\test
set ARDUINOJSON_DIR=C:\ruta\a\libraries\ArduinoJson\src
ejecutar_pruebas.bat
```

`ARDUINOJSON_DIR` es la carpeta `src` de la librería ArduinoJson v7 (la que instala el Gestor de librerías
del IDE, normalmente `Documentos\Arduino\libraries\ArduinoJson\src`). Sin esa variable se omite solo
`test_protocolo`.

La salida termina con `N pruebas, M comprobaciones, 0 fallas`, y el código de salida es distinto de cero si algo falla.

## Resultado verificado

| Compilador | Opciones | test_riego | test_envio | test_protocolo |
|---|---|---|---|---|
| MSVC 19.44 (VS 2022 Build Tools) | `/std:c++17 /W4 /fsanitize=address` | 36 pruebas / 7 457 comprobaciones ✔ | 14 / 151 ✔ | 20 / 194 ✔ |
| GCC 16.2 (w64devkit) | `-std=c++17 -Wall -Wextra -Wpedantic -Wshadow` | 36 / 7 457 ✔ | 14 / 151 ✔ | 20 / 194 ✔ |

Sin advertencias en ninguno de los dos.
