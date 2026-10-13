# Entrega: despliegue en la Raspberry Pi, guion de la demo y plan B

Documento operativo para el día de la entrega. Todo lo de aquí se ensayó en un PC con Docker haciendo de Pi (mismas imágenes, mismo `docker-compose.yml`,
imágenes construidas también para **arm64**); lo único que no se pudo ensayar sin la Pi es el despliegue en sí. Resultados de las pruebas: [`pruebas.md`](pruebas.md).

## 0. Antes de salir (con internet, en este PC)
- [ ] El PC está en el WiFi **Wifuu** (la misma red de la Pi y de la NodeMCU): `ssh iot@iot.local` responde. Si `iot.local` no resuelve, use `ssh iot@10.231.225.220`.
- [ ] La rama del repositorio es `pi-postgres-local` y `git status` está limpio (sin `.env`).
- [ ] `npm run typecheck` y `npm test` en `dashboard/` pasan.
- [ ] Docker Desktop abierto (para el plan B).

## 1. Despliegue en la Pi (≈ 20 min; el sistema viejo sigue funcionando hasta el paso 4)
Todo se lanza desde **este PC** con el script, que pide la clave de la Pi una vez:

```powershell
cd C:\Users\matia\Desktop\IOT-main\invernadero-iot
.\scripts\deploy-pi.ps1                       # usa iot@10.231.225.220; otra Pi:  -Destino usuario@host
```

Qué hace, en orden (cada paso se detiene si falla):
1. **Respaldo** de `~/invernadero-iot` en `~/invernadero-iot.bak-pre-postgres` (con sus `.env`).
2. **Copia** del proyecto (tar sin `node_modules`, `.next`, `.env*`, `.demo-*`, `firmware`, `docs/screenshots`).
3. **Completa `.env`** en la Pi sin borrar lo que ya tiene (`MQTT_*`): genera `POSTGRES_PASSWORD`, `IOT_APP_PASSWORD` y `APP_SECRET` aleatorios y toma `SUPABASE_DB_*` del
   `dashboard/.env.local` que la Pi ya tenía (rol limitado `iot_app` de Supabase). Después **borra ese `.env.local`** y deja `.env` en modo `600`.
4. **Construye** las imágenes (`docker compose build`; 5–10 min la primera vez, con el sistema viejo todavía en marcha).
5. **Corte** (≈ 1 min): detiene el sistema viejo, `up postgres migrate`, **`bootstrap`** (trae de Supabase usuarios, invernaderos, el token del nodo y el historial) y `up -d`.
6. **Verifica**: contenedores `healthy`, `/api/health`, nodo conectado al broker, un **simulacro** de sincronización (`SYNC_DRY_RUN=1`, no escribe nada) y la primera sincronización real.

Verificación manual después (2 min):
```bash
ssh iot@iot.local
cd ~/invernadero-iot
docker compose ps                      # postgres, mosquitto, gateway, dashboard, sync: healthy · migrate: Exited (0)
docker compose logs --tail 20 gateway  # "MQTT: conectado…"; cada ~5 s llega una trama del nodo
docker compose logs --tail 20 sync     # "Sincronizado con Supabase en N ms: …"
curl -s localhost:3100/api/health      # {"ok":true,"baseLocal":true,"tramas":N,…}
```
Desde otro equipo de la red: abrir **http://iot.local:3000** (o `http://10.231.225.220:3000`) e iniciar sesión con un usuario de siempre.

### Si algo falla: volver al sistema anterior (≈ 2 min)
```bash
cd ~/invernadero-iot && docker compose down
cd ~ && rm -rf invernadero-iot && mv invernadero-iot.bak-pre-postgres invernadero-iot
cd invernadero-iot && sudo docker compose up -d --build   # el compose anterior (pasarela directa a Supabase), tal como estaba
```
El nodo no se toca en ningún caso: sigue regando solo, con o sin Pi, y conserva hasta 8 eventos.

## 2. La NodeMCU
No hace falta volver a subir el firmware: `MQTT_HOST` (`10.231.225.220`), usuario/clave MQTT y token son los mismos. Si la Pi cambió de IP, reserve la actual en el router o
corrija `MQTT_HOST` y suba el sketch. Monitor Serie (115200): debe decir `MQTT: conectado a 10.231.225.220:1883 como nodo-xxxxxx`.

## 3. Guion de la demo (≈ 10 min)
1. **Arquitectura** (1 min): mostrar el diagrama del README: nodo → MQTT → Pi (base local + dashboard + API) → copia a Supabase cada 5 min. Funciona sin internet.
2. **Dashboard en vivo** (2 min): `http://iot.local:3000`, mapa del predio, tarjeta del invernadero con la lectura real del nodo (temperatura, humedad, suelo) y su gráfico.
3. **Riego manual** (3 min): invernadero del nodo → *Regar ahora* → duración 10–15 s → *Solicitar* → contraseña → *Confirmar y enviar*. Mostrar el seguimiento
   (confirmada → en cola → entregada → ejecutada) y la bomba. *Detener bomba* si se quiere cortar antes.
   - El nodo recibe la orden en su **siguiente reporte**: con el intervalo en 5 s tarda unos segundos; con 300 s hasta 5 min. Antes de la demo, en *Umbrales* del
     invernadero ajustar «Reporte del nodo cada» a **5–10 s** (y devolverlo a 300 s después).
4. **Riego automático** (1 min): mojar/secar el sensor para cruzar el umbral y ver que riega solo; mostrar el corte de seguridad.
5. **API** (2 min): crear una clave y consultar desde otro equipo:
   ```bash
   docker compose run --rm tools crear correo@usuario.cl "demo"
   curl -H "Authorization: Bearer iotk_…" http://iot.local:3000/api/v1/greenhouses
   ```
6. **Sin internet** (1 min): desconectar la Pi del router/WAN (o bloquear la salida) y mostrar que el dashboard y el nodo siguen; reconectar y ver en `docker compose logs sync`
   que lo acumulado sube a Supabase.

## 4. Plan B: la demo en este PC (si la Pi no responde)
```powershell
cd C:\Users\matia\Desktop\IOT-main\invernadero-iot
.\scripts\demo-pc.ps1          # levanta Postgres + Mosquitto + pasarela + dashboard en Docker, siembra datos, abre el navegador y arranca el simulador
```
Muestra el mismo sistema con nodos simulados (`npm run simulate`). Con la NodeMCU real: en el sketch, `MQTT_HOST` = IP de este PC (`ipconfig`) y volver a subirlo
(**acuérdese de restaurar la IP de la Pi después**). Detener todo: `.\scripts\demo-pc.ps1 -Detener`.

## 5. Lista de verificación final (go / no-go)
- [ ] `docker compose ps` todo `healthy`; `/api/health` con `"baseLocal":true`.
- [ ] El nodo aparece **en línea** en el dashboard y la lectura cambia al mojar el sensor.
- [ ] Un riego manual completo (2 pasos) hace girar la bomba y se corta a tiempo.
- [ ] `docker compose logs sync` muestra `Sincronizado con Supabase` sin errores.
- [ ] La API responde 401 sin clave y 200 con clave.
- [ ] Claves cambiadas: contraseña del usuario `iot` de la Pi (`passwd`) y `MQTT_PASS` si se mostró en pantalla.
- [ ] La hora de la Pi es correcta (`date`); sin internet depende de la pila del RTC (ver `gateway-raspberry.md` §6).

## 6. Ensayo con la NodeMCU real contra este PC (antes de la entrega, sin la Pi)
Sirve para ver la placa, los sensores y la bomba funcionando con el sistema nuevo. **No modifica el firmware del repositorio.**
1. Conectar este PC al WiFi **Wifuu** (el de la placa) y la NodeMCU por USB (cable de datos). Cerrar el Monitor Serie del Arduino IDE.
2. `.\scripts\demo-pc.ps1 -NodoReal -SinSimulador` → levanta el sistema en Docker, siembra datos y registra el **token de la placa** como nodo de I1 (reporte cada 5 s). Mostrará el usuario y la clave de la demo.
3. `.\scripts\prueba-hardware.ps1` → compila una **copia** del sketch con `MQTT_HOST` = la IP de este PC, la sube y abre el Monitor Serie. Debe decir `MQTT: conectado a <IP del PC>:1883`.
4. En `http://127.0.0.1:3000` (usuario `demo-admin@invernadero.local`) I1 debe verse **en línea**. Pruebas físicas: sensor en el aire (seco) y en agua (saturado); riego manual de 10 s (2 pasos) y comprobar que el relé suena, la bomba gira y **se corta sola**; *Detener bomba*; apagar el WiFi unos segundos con la bomba apagada y volver a encenderlo; reiniciar la placa.
5. Si el firewall de Windows pregunta, permitir **Docker Desktop** en redes privadas (puerto 1883 de entrada).
6. **Al terminar, volver a la Pi**: `.\scripts\prueba-hardware.ps1 -Restaurar` (sube el sketch original, con `MQTT_HOST` = `10.231.225.220`) y `.\scripts\demo-pc.ps1 -Detener`.
