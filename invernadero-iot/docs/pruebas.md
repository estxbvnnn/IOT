# Resultados de las pruebas (13 oct 2026)

Ronda de pruebas previa a la entrega del sistema **NodeMCU → MQTT → Raspberry Pi (PostgreSQL local + dashboard + API) → Supabase**.
La Raspberry Pi física no estaba disponible esa noche, así que todo se probó en un PC con **Docker haciendo de Pi** (mismas imágenes y mismo `docker-compose.yml`),
más las imágenes construidas y arrancadas para **arm64** (la arquitectura de la Pi). Lo que no se pudo probar sin la Pi está en «Riesgos residuales».

## Resumen

| Área | Qué se probó | Resultado |
|---|---|---|
| **A. Base automática** | TypeScript estricto · 190 pruebas unitarias · 105 de BD en PostgreSQL común · 70 de la lógica del nodo (riego, envío, protocolo) · compilación del sketch | ✅ todo en verde (sketch: 26 % de flash, 53 % de RAM) |
| **B. Interfaz web (E2E, Edge)** | 63 comprobaciones: login incorrecto, rutas protegidas, menú y accesos por **cada rol**, detalle con gráficos, vista móvil, cierre de sesión, riego manual en 2 pasos (clave incorrecta y correcta), exportar CSV, verificación de la bitácora, **sin errores de consola ni 5xx** | ✅ 63/63, también con 10 nodos transmitiendo |
| **B. API v1** | 25 comprobaciones por rol y entradas hostiles: 401/403/404/413/415, alcance del operador, claves revocadas, inyección SQL, `../`, JSON roto/enorme | ✅ 25/25 |
| **B. Varios nodos a la vez** | 2 y 10 nodos publicando por MQTT al mismo instante (200 tramas): cada uno recibe **su** configuración, la orden de riego llega solo al nodo correcto, cada lectura se guarda en su invernadero sin mezclas | ✅ 200/200 respuestas; latencia mediana 9 ms, p95 48 ms |
| **B. Datos reales** | `bootstrap` desde la Supabase real (solo lectura) a una base local limpia: 2.048 filas, bitácora íntegra, token del nodo conservado, esquema idéntico en las 13 tablas; simulacro de sincronización (no escribe) | ✅ |
| **C. Resiliencia** | `kill -9` (caída real, no `docker kill`) de gateway, mosquitto, postgres, dashboard, gateway+postgres; `docker restart` de todo; `down`+`up` (reinicio de la Pi), con 3 nodos transmitiendo | ✅ las lecturas vuelven en **4–5 s** cada vez · 0 duplicados · 0 errores en los registros |
| **D. Seguridad** | puertos publicados, MQTT sin clave / clave mala, cabeceras, cookie, secretos en las imágenes, usuario de los contenedores, rotación de registros | ✅ con 1 límite documentado (ver abajo) |
| **E. Estabilidad (20 min)** | 10 nodos transmitiendo cada 5 s (2.400 tramas) midiendo memoria/CPU de cada contenedor, tamaño de la base y latencia | ✅ 2.399/2.400 respuestas (la restante fue un `429 rate_limited` por una trama que mi propia prueba HTTP metió en el mismo segundo: el límite de 1 trama/s por nodo funcionando) · latencia mediana 12 ms, p95 48 ms, máx 203 ms · **memoria plana**: pasarela 67 MiB, dashboard 79 MiB, postgres ~80–98 MiB, mosquitto ~5 MiB · CPU < 1 % en reposo |
| **F. arm64 (Pi)** | `buildx --platform linux/arm64` de las dos imágenes; arranque emulado: migraciones, dashboard (`aarch64`), `/api/health`, API v1 | ✅ construye (122 s y 336 s emulado) y funciona |
| **I. Entrega** | `scripts/deploy-pi.ps1` (sintaxis, armado del `.env` con contraseñas con `$ # @ / + =`, ensayo del camino completo contra datos reales), `scripts/demo-pc.ps1`, `scripts/prueba-hardware.ps1`, runbook y plan B | ✅ ensayado (el despliegue sobre la Pi misma queda para la entrega) |
| **G. Hardware real** | NodeMCU con sensores y bomba | ⏳ pendiente: requiere la placa conectada (guía en `entrega.md` y `scripts/prueba-hardware.ps1`) |

## Hallazgos corregidos durante las pruebas

1. **La cadena de hashes de la bitácora se bifurcaba con escrituras concurrentes** (defecto de la migración 0001, que ya existía). El trigger tomaba el `id` *antes* de bloquear y buscaba el «último
   registro» por `id`: con dos inserciones simultáneas (p. ej. 10 nodos presentándose a la vez, mismo milisegundo) la cadena se bifurcaba y *Verificar integridad* acusaba una alteración inexistente.
   Lo detectó la prueba E2E. **Corrección: migración `0008_audit_chain_concurrency.sql`** (el id se asigna dentro del bloqueo). Prueba nueva `tests/db/audit-chain.test.ts`
   (600 inserciones con 24 conexiones): **falla 3/3 sin la corrección y pasa con ella**; 1.800 inserciones concurrentes dejaron `verificados=1800, roto=ninguno`.
   *Nota:* Supabase **no** tiene la 0008; no la necesita para la copia (recibe las filas de a una, en orden), pero conviene aplicarla si alguien vuelve a escribir en Supabase directamente.
2. **Datos que viajaban doblemente codificados** entre las dos bases (postgres.js serializa como JSON lo que se castea a `jsonb`): toda fila era rechazada. Lo detectó `tests/db/sync.test.ts` en su primera corrida; corregido (`$1::text::jsonb`).
3. **Una prueba de BD frágil** (`queries.test.ts`, exportar CSV) dependía de datos sembrados: ahora crea su propio historial.
4. **Contraseñas con símbolos** en el `.env` (`$`, `#`…) se habrían interpretado mal por `docker compose`: el script de despliegue las escribe entre comillas simples (verificado con valores difíciles).
5. **Endurecimiento**: las herramientas corren como usuario `node` (no root) y los registros de Docker rotan (3 × 10 MB por servicio) para que una Pi sin atención no llene la SD.
6. **Sincronización**: no sube nada hasta el arranque inicial (evita pisar Supabase con una base distinta); queda inactiva (sin bucle de reinicios) si faltan sus credenciales; modo **simulacro** (`SYNC_DRY_RUN=1`) para ensayar contra la Supabase real sin escribir.

## Detalle de la resiliencia (3 nodos transmitiendo, caídas reales por `kill -9` desde fuera del contenedor)

| Falla | Lecturas nuevas de nuevo en |
|---|---|
| gateway | 4 s |
| mosquitto (broker) | 4 s |
| postgres (recupera con su registro WAL) | 4 s |
| dashboard | 5 s |
| gateway + postgres a la vez | 4 s |
| `docker restart` de todo | 4 s |
| `down` + `up` (equivale a reiniciar la Pi) | 5 s |

Nota metodológica: `docker kill` **no** vale como prueba de caída, porque Docker lo trata como «detenido a mano» y la política `unless-stopped` no reinicia el contenedor; hay que matar el proceso por fuera
(`docker run --privileged --pid=host alpine kill -9 <pid>`), que es lo que ocurre ante un fallo real. Tras la matriz: 0 duplicados `(nodo, seq)`, la bitácora íntegra y 0 errores en el registro de la pasarela.

## Seguridad: lo comprobado

- Puertos publicados: **solo 1883, 3000 y 3100**; PostgreSQL no se publica a la red.
- MQTT: conexión anónima y con clave incorrecta → `not authorised`.
- Cabeceras: `Content-Security-Policy` con nonce por petición, `X-Frame-Options: DENY`, `nosniff`, `Referrer-Policy`, `Permissions-Policy`, `Cross-Origin-Opener-Policy`.
- Cookie de sesión: `HttpOnly`, `SameSite=Lax` (sin `Secure` porque la red local va por HTTP, ver límite).
- Imágenes sin `.env` ni credenciales; los servicios propios corren como `node`.
- API: 401/403/404/413/415/429; el riego manual exige reingresar la contraseña; las claves se guardan solo como SHA-256 y el súper administrador no puede tener claves.
- **Límites conocidos**: HTTP/MQTT sin cifrar en la red local (aceptable en red de confianza; ver `seguridad.md`). `npm audit` marca 2 avisos altos en dependencias: `next` (envenenamiento de caché de páginas SSG/ISR y de «Draft Mode» con `use cache`: este
  proyecto no usa esas funciones, todas sus páginas son dinámicas; hay parche menor 16.4.0) y `source-map-js` (herramienta de desarrollo). Se dejaron sin actualizar para no introducir cambios la víspera de la entrega.
- **El repositorio versiona credenciales a propósito** (decisión del equipo): debe ser privado y conviene rotar claves de Supabase, WiFi y MQTT después de la entrega si el código se comparte.

## Crecimiento de la base (estimación)
Con el reporte por defecto de 300 s los 11 nodos escriben ~3.800 lecturas/día (insignificante). En el peor caso de la demo (10 nodos cada 5 s) son ~190.000/día (≈ 30 MB/día con índices); la retención
(`npm run db:retention`) compacta a promedios horarios lo que supere 90 días. La SD de la Pi tiene ~21 GB libres: sobra con cualquiera de los dos ritmos.

## Riesgos residuales (para la entrega)

1. **Despliegue real en la Pi**: no probado en la Pi física. Mitigado con `deploy-pi.ps1` (ensayado de punta a punta con datos reales hasta el punto de no escribir en Supabase), imágenes arm64 verificadas, respaldo automático y vuelta atrás en 2 min (`entrega.md`).
2. **Primera compilación de `next build` en la Pi**: 5–10 min en la SD; se hace con el sistema viejo todavía en marcha.
3. **Hora sin internet**: la Pi no sincroniza su reloj sin internet y se atrasa al apagarse; usar la pila del RTC del Pi 5 o `chrony` contra el router (`gateway-raspberry.md` §6).
4. **NodeMCU real**: la comunicación se probó con nodos simulados y la lógica de riego con 70 pruebas de host, pero sensores, relé y bomba reales dependen de la prueba de hardware (G).
5. **Reporte del nodo cada 300 s** (valor por defecto del servidor): una orden de riego tarda hasta 5 min en llegar al nodo. Para la demo, ajustar «Reporte del nodo cada» a 5–10 s en *Umbrales* (y devolverlo después).

## Cómo repetir estas pruebas
```bash
cd dashboard
npm run typecheck && npm test                         # A
docker compose up -d postgres                         # con el puerto publicado (127.0.0.1:55432) y DATABASE_* / DATABASE_ADMIN_* exportadas
npm run test:db                                       # A/B/C: BD, bitácora concurrente, claves de API, sincronización
npm run e2e -- --url http://127.0.0.1:3000 --users cuentas.json     # B: interfaz
```
