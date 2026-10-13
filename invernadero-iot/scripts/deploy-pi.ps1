<#
  Despliega el sistema en la Raspberry Pi desde ESTE PC (docs/entrega.md §1):
  respaldo → copia → completa .env → construye → corte → bootstrap desde Supabase → arranca → verifica.

    .\scripts\deploy-pi.ps1                          # Pi por defecto: iot@10.231.225.220
    .\scripts\deploy-pi.ps1 -Destino iot@iot.local
    .\scripts\deploy-pi.ps1 -SoloVerificar           # no cambia nada: solo muestra el estado de la Pi

  Pide la clave SSH de la Pi dos veces (una para copiar y otra para ejecutar). No guarda claves ni llaves.
  El sistema viejo sigue funcionando hasta el paso 5 (corte, ≈ 1 min).
#>
param(
  [string]$Destino = 'iot@10.231.225.220',
  [switch]$SoloVerificar
)
$ErrorActionPreference = 'Stop'

foreach ($c in 'ssh', 'scp', 'tar') { if (-not (Get-Command $c -ErrorAction SilentlyContinue)) { throw "Falta el comando '$c' (OpenSSH / tar de Windows)." } }
$proyecto = Split-Path -Parent $PSScriptRoot                # ...\invernadero-iot
$padre = Split-Path -Parent $proyecto                       # ...\IOT-main
$ssh = @('-o', 'ConnectTimeout=15', '-o', 'StrictHostKeyChecking=accept-new')
$hostPi = ($Destino -split '@')[-1]

Write-Host "== Comprobando que la Pi responde ($hostPi:22)..." -ForegroundColor Cyan
if (-not (Test-NetConnection $hostPi -Port 22 -WarningAction SilentlyContinue).TcpTestSucceeded) {
  throw "La Pi no responde en $hostPi:22. Conecte este PC al WiFi de la Pi (Wifuu) y pruebe de nuevo (o use -Destino usuario@IP)."
}

if ($SoloVerificar) {
  ssh @ssh $Destino 'cd ~/invernadero-iot && sudo docker compose ps && curl -s -m 5 localhost:3100/api/health; echo; sudo docker compose logs --tail 5 sync 2>&1 | cut -c1-200'
  return
}

# ---------------------------------------------------------------- 1) paquete
$tar = Join-Path $env:TEMP 'iot-proyecto.tar'
Write-Host "== Empaquetando el proyecto..." -ForegroundColor Cyan
Push-Location $padre
try {
  tar --exclude='node_modules' --exclude='.next' --exclude='.gateway' --exclude='*.tsbuildinfo' --exclude='coverage' `
      --exclude='invernadero-iot/.env' --exclude='invernadero-iot/dashboard/.env.local' --exclude='invernadero-iot/dashboard/.env.admin.local' `
      --exclude='invernadero-iot/dashboard/.demo-*' --exclude='invernadero-iot/firmware' --exclude='invernadero-iot/docs/screenshots' `
      -cf $tar invernadero-iot
  if ($LASTEXITCODE -ne 0) { throw 'tar falló' }
} finally { Pop-Location }
"{0:N1} MB" -f ((Get-Item $tar).Length / 1MB)

# ---------------------------------------------------------------- 2) script remoto (bash, LF)
$remoto = @'
set -euo pipefail
D="sudo docker"
step() { echo; echo "== [$1] $2"; }
cd ~

step 1/6 "respaldo del sistema actual (se conserva con sus .env, para volver atrás)"
if [ -d invernadero-iot ] && [ ! -d invernadero-iot.bak-pre-postgres ]; then cp -a invernadero-iot invernadero-iot.bak-pre-postgres; echo "respaldo creado"; else echo "(ya hay respaldo o es una instalación nueva)"; fi

step 2/6 "copia del proyecto"
tar -xf /tmp/iot-proyecto.tar && rm -f /tmp/iot-proyecto.tar
cd ~/invernadero-iot

step 3/6 "completando .env (claves aleatorias; credenciales de Supabase del .env.local anterior)"
python3 - <<'PY'
import os, re, secrets
def leer(path):
    d = {}
    if os.path.exists(path):
        for l in open(path, encoding='utf8'):
            m = re.match(r"\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$", l)
            if m and not l.lstrip().startswith('#'):
                v = m.group(2)
                if len(v) >= 2 and v[0] == v[-1] and v[0] in "'\"": v = v[1:-1]
                d[m.group(1)] = v
    return d
env = leer('.env'); loc = leer('dashboard/.env.local')
def gen(): return secrets.token_urlsafe(24)
for k in ('POSTGRES_PASSWORD', 'IOT_APP_PASSWORD'): env.setdefault(k, gen())
if len(env.get('APP_SECRET', '')) < 32: env['APP_SECRET'] = secrets.token_urlsafe(48)
env.setdefault('TZ', 'America/Santiago'); env.setdefault('SYNC_INTERVAL_S', '300'); env.setdefault('MFA_REQUIRED_ROLES', '')
if not env.get('SUPABASE_DB_HOST') and loc.get('DATABASE_HOST'):
    env.update({'SUPABASE_DB_HOST': loc['DATABASE_HOST'], 'SUPABASE_DB_PORT': loc.get('DATABASE_PORT', '5432'), 'SUPABASE_DB_NAME': loc.get('DATABASE_NAME', 'postgres'),
                'SUPABASE_DB_USER': loc['DATABASE_USER'], 'SUPABASE_DB_PASSWORD': loc['DATABASE_PASSWORD'], 'SUPABASE_DB_SSL_MODE': loc.get('DATABASE_SSL_MODE', 'verify')})
for k in ('MQTT_USER', 'MQTT_PASS'):
    if not env.get(k): raise SystemExit(f'Falta {k} en .env de la Pi (es la clave de Mosquitto que ya usa el nodo).')
orden = ['MQTT_USER','MQTT_PASS','POSTGRES_PASSWORD','IOT_APP_PASSWORD','APP_SECRET','MFA_REQUIRED_ROLES','TZ','SYNC_INTERVAL_S','SUPABASE_DB_HOST','SUPABASE_DB_PORT','SUPABASE_DB_NAME','SUPABASE_DB_USER','SUPABASE_DB_PASSWORD','SUPABASE_DB_SSL_MODE']
with open('.env', 'w', encoding='utf8') as f:
    f.write('# Generado por scripts/deploy-pi.ps1. Contiene claves: no lo comparta ni lo suba a Git.\n')
    for k in orden + [x for x in env if x not in orden]:
        v = env.get(k, '')
        if "'" in v: raise SystemExit(f'El valor de {k} contiene una comilla simple; edite .env a mano.')
        f.write(f"{k}='{v}'\n")
print('SUPABASE_DB_HOST:', env.get('SUPABASE_DB_HOST') or '(vacío: la copia a Supabase quedará desactivada)')
PY
chmod 600 .env
if [ -f dashboard/.env.local ]; then rm -f dashboard/.env.local; echo "dashboard/.env.local anterior eliminado (sus credenciales de Supabase ahora están en .env; sigue en el respaldo)"; fi

step 4/6 "construyendo las imágenes (el sistema viejo sigue en marcha; 5-10 min la primera vez)"
$D compose build

step 5/6 "corte: detener lo viejo, base local, migraciones, traer datos de Supabase y arrancar"
$D compose down --remove-orphans
$D compose up -d postgres
for i in $(seq 1 30); do [ "$($D compose ps postgres --format '{{.Health}}')" = healthy ] && break; sleep 2; done
$D compose run --rm migrate
if out=$($D compose run --rm bootstrap 2>&1); then echo "$out" | tail -4; else
  if echo "$out" | grep -q "ya tiene"; then echo "(la base local ya estaba inicializada: se conserva)"; else echo "$out" | tail -15; echo "ERROR en bootstrap"; exit 1; fi
fi
$D compose up -d

step 6/6 "verificación"
for i in $(seq 1 45); do curl -sf -m 3 localhost:3100/api/health >/dev/null && break; sleep 2; done
$D compose ps --format 'table {{.Service}}\t{{.Status}}'
echo; echo "salud de la pasarela:"; curl -s -m 5 localhost:3100/api/health; echo
echo; echo "dashboard:"; curl -s -m 10 -o /dev/null -w 'HTTP %{http_code}\n' localhost:3000/login
echo; echo "SIMULACRO de la copia a Supabase (no escribe nada):"
$D compose run --rm -e SYNC_DRY_RUN=1 sync 2>&1 | tail -3
echo; echo "Listo. Pruebe http://$(hostname -I | awk '{print $1}'):3000 desde otro equipo y revise: sudo docker compose logs -f gateway"
'@
$remotoPath = Join-Path $env:TEMP 'iot-deploy-remoto.sh'
[IO.File]::WriteAllText($remotoPath, ($remoto -replace "`r`n", "`n"), (New-Object Text.UTF8Encoding($false)))

# ---------------------------------------------------------------- 3) copiar y ejecutar
Write-Host "== Copiando a la Pi (le pedirá la clave)..." -ForegroundColor Cyan
scp @ssh $tar $remotoPath "${Destino}:/tmp/"
if ($LASTEXITCODE -ne 0) { throw 'scp falló' }
Write-Host "== Ejecutando el despliegue en la Pi (le pedirá la clave otra vez)..." -ForegroundColor Cyan
ssh -t @ssh $Destino 'bash /tmp/iot-deploy-remoto.sh; r=$?; rm -f /tmp/iot-deploy-remoto.sh; exit $r'
if ($LASTEXITCODE -ne 0) { throw "El despliegue falló (código $LASTEXITCODE). Vea el mensaje de arriba; para volver atrás: docs/entrega.md §1." }
Remove-Item $tar, $remotoPath -Force -ErrorAction SilentlyContinue
Write-Host "`nDespliegue terminado." -ForegroundColor Green
