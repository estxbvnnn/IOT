# Fuentes del firmware para ESP8266

**Esta carpeta no es un sketch para abrir en el Arduino IDE.** Contiene lo que es propio del ESP8266
(`config.h`, `sensores.h`, `red.h` y el programa principal `nodo_invernadero_esp8266.ino`); la lógica
compartida con el ESP32 (`riego.h`, `envio.h`, `protocolo.h`) está en `../nodo_invernadero/`.

El generador (`npm run firmware:unico`, desde la carpeta raíz del proyecto) las une en un solo archivo:

    firmware/nodo_invernadero_unico/nodo_invernadero_unico.ino      ← ábralo en el Arduino IDE

Ese es el archivo que se carga en la placa. Si cambia algo, edite los fuentes de aquí (o los compartidos) y regenere;
`npm run firmware:unico:check` comprueba que el archivo único esté al día.

Reglas al editar estos fuentes:

* Las funciones libres de este código **no deben recibir tipos definidos en el mismo archivo** (`.ino`): el IDE de Arduino
  les genera un prototipo automático al principio del archivo único y el compilador no encontraría el tipo. Los tipos que
  vienen de `riego.h`, `protocolo.h` o `red.h` sí se pueden usar.
* No mencionar el nombre del archivo de credenciales de la versión ESP32 (el generador lo rechaza): en este firmware las
  credenciales van en el bloque «CONFIGURACION DEL USUARIO» del archivo único.
* Todo en ASCII (sin tildes ni ñ), como el resto del firmware.
