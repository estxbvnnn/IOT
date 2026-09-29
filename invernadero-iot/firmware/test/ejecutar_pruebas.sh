#!/usr/bin/env bash
# Compila y ejecuta las pruebas de host con g++ (o clang++). Uso:
#   ./ejecutar_pruebas.sh
#   ARDUINOJSON_DIR=/ruta/a/libraries/ArduinoJson/src ./ejecutar_pruebas.sh   # incluye test_protocolo
# Variables opcionales: CXX (compilador, por defecto g++)
set -e
cd "$(dirname "$0")"
CXX="${CXX:-g++}"
FLAGS="-std=c++17 -O1 -g -Wall -Wextra -Wpedantic -Wshadow -I../nodo_invernadero"
fallo=0

echo "=== test_riego (controlador de riego) ==="
"$CXX" $FLAGS test_riego.cpp -o test_riego && ./test_riego || fallo=1

echo "=== test_envio (politica de envio) ==="
"$CXX" $FLAGS test_envio.cpp -o test_envio && ./test_envio || fallo=1

if [ -n "$ARDUINOJSON_DIR" ]; then
  echo "=== test_protocolo (trama y respuesta) ==="
  "$CXX" $FLAGS -isystem "$ARDUINOJSON_DIR" test_protocolo.cpp -o test_protocolo && ./test_protocolo || fallo=1
else
  echo "=== test_protocolo omitido: defina ARDUINOJSON_DIR (carpeta src de la libreria ArduinoJson v7) ==="
fi

exit $fallo
