# Seguridad: del informe al código

Trazabilidad de los controles del informe (secciones 12.1 a 12.4) contra lo que **realmente** implementa este repositorio.
Estados: ✅ implementado en código · 🟡 parcial · 🏗️ es infraestructura (no se resuelve con código de aplicación) · ❌ no incluido.

## Tabla 10 — Amenazas y controles por capa

| # | Capa | Amenaza | Control del informe | Estado | Dónde |
|---|---|---|---|---|---|
| 1 | Dispositivo | Acceso físico al nodo | Llave en elemento seguro, caja con llave, puerto de depuración deshabilitado, llave distinta por dispositivo | 🟡 | Token distinto por nodo, guardado como SHA-256 y rotable desde `/devices` (`services/devices.ts`); cada invernadero nuevo genera el suyo (`/greenhouses`, permiso `greenhouses:manage`, solo administrador) y un invernadero dado de baja deja de ser aceptado. El ATECC608A **no** está en el firmware; el token vive en el bloque de configuración del firmware (`secrets.h` en la versión modular; recomendado: *flash encryption* del ESP32). |
| 2 | Red | Movimiento lateral hacia la red administrativa | VLAN separadas con denegación por defecto | 🏗️ | Configuración del router/cortafuegos. En la aplicación: la API de nodos y la web son superficies distintas (token vs. sesión) y la base es un esquema privado. |
| 3 | Dispositivo | Manipulación del sensor de humedad | Validación de rango, tiempo máximo de riego, alerta por activaciones anómalas repetidas | ✅ | Rango en firmware (`sensores.h`) y servidor (`ingest/schema.ts` → `sanitizeFrame`); corte duro en el nodo (`riego.h`); alerta `pump_anomaly` (`alerts/engine.ts`). Pruebas: `tests/unit/controller.test.ts`, `alerts-engine.test.ts`. |
| 4 | Comunicación | Captura de tráfico | Cifrado en radio y TLS en el tramo IP | 🟡 | TLS con la base **verificado** (`db/config.ts`). El nodo→servidor usa HTTPS en producción (`FORCE_HTTPS`); en desarrollo por LAN es HTTP. El AES-128 de LoRaWAN no aplica a este transporte. |
| 5 | Comunicación | Repetición de una trama capturada | Contador de trama | ✅ | `boot` + `seq` por nodo; una repetida responde `dup:true` sin reprocesar (`services/ingest.ts`). Prueba: `tests/db/ingest.test.ts`. |
| 6 | Comunicación | Suplantación de un nodo | Clave única por dispositivo y ACL por tópico | ✅ | La identidad sale del **token**, nunca del cuerpo; un nodo solo escribe en su invernadero y no puede acusar órdenes ajenas. Pruebas en `tests/db/ingest.test.ts` y `commands.test.ts`. |
| 7 | Servicios | Exposición del servidor a Internet | Acceso solo por VPN | 🏗️ | La única superficie pública es `/api/health` y `/api/ingest` (token + límite de tasa); todo lo demás exige sesión. La VPN WireGuard es de despliegue. CSP estricta con nonce en `proxy.ts`. |
| 8 | Servicios | Pérdida de la base | Respaldo diario cifrado fuera del predio | 🟡 | La base está en Supabase (con sus respaldos según el plan). `npm run db:retention` aplica la retención del informe. El respaldo cifrado propio **no** está implementado. |
| 9 | Usuarios | Credenciales débiles o filtradas | Contraseñas fuertes, 2FA, expiración de sesión, bitácora | ✅ | scrypt + política de ≥ 12 caracteres (`auth/password.ts`), bloqueo tras 5 fallos, TOTP (`auth/totp.ts`, exigible con `MFA_REQUIRED_ROLES`), sesiones en base con vencimiento por rol (administrador 30 min), bitácora inmutable. |
| 10 | Usuarios | Abuso de privilegios | Mínimo privilegio y confirmación en dos pasos | ✅ | Matriz de roles y **alcance por sector** (`rbac.ts`); orden de riego = solicitud + reingreso de contraseña con ventana de 60 s (`services/commands.ts`). |

## Tabla 11 — Autenticación y autorización por rol

Autorización: **✅** (matriz completa en `src/lib/rbac.ts`, probada en `tests/unit/rbac.test.ts` y en las pruebas de base de datos).
Autenticación: el informe pide mecanismos distintos por rol (TOTP/FIDO2 para administrador, OAuth 2.0 para agrónomo, PIN o biometría
para operador, certificado X.509 para técnico). El código implementa **usuario + contraseña + TOTP opcional/obligatorio por rol** para todos.
Certificado de cliente (mTLS), inicio de sesión único y biometría móvil son de **despliegue** (proxy inverso/IdP) y no están incluidos.

| Regla del informe | Cómo se cumple |
|---|---|
| Sesión del administrador expira a los 30 min | `SESSION_IDLE_S.admin = 1800 s` (`auth/service.ts`); el resto: técnico 60 min, dueño/agrónomo 2 h, operador 8 h; tope absoluto 12 h. |
| Registro inmutable de las acciones del administrador | Toda acción relevante llama a `audit()`; la tabla admite solo `INSERT`/`SELECT` para la app + trigger que rechaza `UPDATE/DELETE/TRUNCATE` + hash SHA-256 encadenado (`0001_init.sql`, `0002_audit_definer.sql`). |
| Operador «no accede a sectores ajenos» | Alcance por invernadero en cada consulta (`scopeOf`) y 404 al pedir un sector ajeno. |
| «Toda orden manual exige confirmación en dos pasos y tiene corte por temporizador» | Solicitud → contraseña; el nodo corta solo (`riego.h`). «Detener» es de un paso a propósito. |
| Dispositivos: «un nodo no puede leer ni publicar en un tópico ajeno» | Ver fila 6 de la tabla 10. |
| Técnico: «prohibida toda escritura y todo envío de órdenes» | El rol solo tiene permisos de lectura; verificado en `rbac.test.ts`. |

## Tabla 12 — Protección del dato en su ciclo

| Etapa | Control | Estado | Dónde |
|---|---|---|---|
| Captura | Validación de rango, un dato por nodo | ✅ | `sensores.h`, `sanitizeFrame`. No se captura ningún dato personal. |
| Transmisión | Integridad y anti-repetición | ✅ / 🟡 | `boot`+`seq`; la integridad del mensaje descansa en TLS (sin firma propia por trama). |
| Procesamiento | Órdenes solo desde la plataforma; el nodo aplica límites duros aunque el servidor falle | ✅ | `cfg` validada y con límites propios en el nodo (`docs/contrato-api.md` §6). |
| Almacenamiento | Base accesible solo desde el servidor; bitácora inmutable; 90 días crudos y luego promedios | ✅ / 🟡 | Esquema privado + RLS + rol mínimo; `iot.compact_readings()` y `npm run db:retention`. El cifrado en reposo lo da Supabase, no la aplicación. |
| Consulta | HTTPS, cuenta individual, 2FA administrativo, cada operador ve solo sus invernaderos | ✅ | `dal.ts`, `proxy.ts`, `rbac.ts`. |

## Defensas adicionales que no pedía el informe

* Cabeceras: CSP con nonce por petición, `X-Frame-Options: DENY`, `nosniff`, `Referrer-Policy`, `Permissions-Policy`, HSTS (con `FORCE_HTTPS`).
* CSRF: acciones del servidor de Next (comparan `Origin`/`Host`) + cookie `SameSite=Lax`.
* Respuesta idéntica ante «usuario inexistente», «clave errónea» y «cuenta bloqueada», con hash señuelo para igualar el tiempo.
* Semilla TOTP cifrada en reposo (AES-256-GCM con clave derivada de `APP_SECRET`) y códigos de un solo uso.
* Autorización repetida en cada capa: página → acción → servicio → base (permisos del rol `iot_app` y RLS).
* `DELETE`, DDL y retención **no** están permitidos al rol de la aplicación.
* La bitácora redacta claves, tokens y secretos antes de guardar.
* Los mensajes que envían los nodos (p. ej. el detalle de un acuse) se tratan como datos no confiables: solo se muestran como texto.

## No cubierto por el código

VLAN/cortafuegos MikroTik · VPN WireGuard · certificados de cliente X.509 · elemento seguro ATECC608A · respaldo diario cifrado propio ·
LoRaWAN/ChirpStack/Mosquitto/ThingsBoard (reemplazados por HTTP + Supabase, ver README) · protección contra denegación de servicio a nivel de red.
