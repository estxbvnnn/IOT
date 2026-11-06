<#
  PLAN B de la demo: todo el sistema en ESTE PC con Docker (docs/entrega.md §4), con nodos simulados.

    .\scripts\demo-pc.ps1              # levanta Postgres + Mosquitto + pasarela + dashboard, siembra datos, simula nodos y abre el navegador
    .\scripts\demo-pc.ps1 -Detener     # detiene y borra todo lo de la demo (datos incluidos)

  No toca tus archivos .demo-* ni tu Supabase: usa una base local nueva y claves aleatorias que viven solo en %TEMP%\iot-demo.
  Usuario administrador de la demo:  demo-admin@invernadero.local  (la clave se muestra al terminar).
#>
param([switch]$Detener, [switch]$SinSimulador, [switch]$NoAbrir)
# Los programas externos (arduino-cli, docker) escriben avisos por stderr: con 'Stop' PowerShell 5.1 los trata como error. Se revisa $LASTEXITCODE donde importa.
$ErrorActionPreference = 'Continue'
$proyecto = Split-Path -Parent $PSScriptRoot
$dash = Join-Path $proyecto 'dashboard'
$tmp = Join-Path $env:TEMP 'iot-demo'
$proj = 'iotdemo'
$dc = @('compose', '-p', $proj, '--env-file', (Join-Path $tmp 'env'), '-f', (Join-Path $proyecto 'docker-compose.yml'), '-f', (Join-Path $tmp 'override.yml'))

function Esperar-Docker {
  docker version --format '{{.Server.Version}}' 2>$null | Out-Null
  if ($LASTEXITCODE -ne 0) {
    $exe = Join-Path $env:LOCALAPPDATA 'Programs\DockerDesktop\Docker Desktop.exe'
    if (-not (Test-Path $exe)) { $exe = 'C:\Program Files\Docker\Docker\Docker Desktop.exe' }
    Write-Host 'Arrancando Docker Desktop...' -ForegroundColor Cyan
    Start-Process $exe
    for ($i = 0; $i -lt 60; $i++) { Start-Sleep 5; docker version --format '{{.Server.Version}}' 2>$null | Out-Null; if ($LASTEXITCODE -eq 0) { return } }
    throw 'Docker Desktop no arrancó.'
  }
}
function Clave { -join ((48..57) + (65..90) + (97..122) | Get-Random -Count 28 | ForEach-Object { [char]$_ }) }

if ($Detener) {
  Esperar-Docker
  if (Test-Path (Join-Path $tmp 'env')) { & docker @dc down -v 2>&1 | Out-Null }
  Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match 'simulate\.ts' -and $_.ProcessId -ne $PID } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }   # el simulador y su ventana
  Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
  Write-Host 'Demo detenida y borrada.' -ForegroundColor Green
  return
}

Esperar-Docker
# Puertos: la demo usa 1883, 3000 y 3100. Si otra cosa los ocupa, se avisa antes de empezar.
foreach ($p in 1883, 3000, 3100, 55432) {
  if (Get-NetTCPConnection -State Listen -LocalPort $p -ErrorAction SilentlyContinue) {
    $dueno = docker ps --filter "publish=$p" --format '{{.Names}}'
    if ($dueno -and $dueno -notmatch "^$proj-") { throw "El puerto $p lo usa el contenedor '$dueno'. Deténgalo (docker stop $dueno) y repita." }
    if (-not $dueno) { throw "El puerto $p está ocupado por otro programa (¿npm run dev?). Ciérrelo y repita." }
  }
}

New-Item -ItemType Directory -Force $tmp | Out-Null
if (-not (Test-Path (Join-Path $tmp 'env'))) {
  @"
MQTT_USER=nodo
MQTT_PASS=$(Clave)
POSTGRES_PASSWORD=$(Clave)
IOT_APP_PASSWORD=$(Clave)
APP_SECRET=$(Clave)$(Clave)
TZ=America/Santiago
"@ | Set-Content (Join-Path $tmp 'env') -Encoding ascii
  @"
services:
  postgres:
    ports: ["127.0.0.1:55432:5432"]
"@ | Set-Content (Join-Path $tmp 'override.yml') -Encoding ascii
}
$cfg = @{}; Get-Content (Join-Path $tmp 'env') | ForEach-Object { if ($_ -match '^([^=]+)=(.*)$') { $cfg[$Matches[1]] = $Matches[2] } }

Write-Host '== Levantando el sistema (la primera vez construye las imágenes: unos minutos)...' -ForegroundColor Cyan
& docker @dc up -d --build postgres mosquitto gateway dashboard
if ($LASTEXITCODE -ne 0) { throw 'docker compose falló' }

# Variables de la base local para los scripts de Node
$env:DATABASE_HOST = '127.0.0.1'; $env:DATABASE_PORT = '55432'; $env:DATABASE_NAME = 'iot'; $env:DATABASE_SSL_MODE = 'disable'
$env:DATABASE_USER = 'iot_app'; $env:DATABASE_PASSWORD = $cfg['IOT_APP_PASSWORD']
$env:DATABASE_ADMIN_USER = 'postgres'; $env:DATABASE_ADMIN_PASSWORD = $cfg['POSTGRES_PASSWORD']

Push-Location $dash
try {
  if (-not (Test-Path node_modules)) { Write-Host '== npm install...' -ForegroundColor Cyan; npm install --no-audit --no-fund | Out-Null }
  # El seed escribe .demo-credentials.md y .demo-devices.json: se respaldan y se restauran para no pisar los reales.
  $respaldo = Join-Path $tmp 'respaldo'; New-Item -ItemType Directory -Force $respaldo | Out-Null
  foreach ($f in '.demo-credentials.md', '.demo-devices.json') { if (Test-Path $f) { Copy-Item $f $respaldo -Force } }
  try {
    Write-Host '== Sembrando el predio, usuarios y 48 h de historial de demostración...' -ForegroundColor Cyan
    npx tsx scripts/db-seed.ts --history 48 | Select-String 'predio|nodos|usuarios|historial'
  } finally {
    foreach ($f in '.demo-credentials.md', '.demo-devices.json') {
      if (Test-Path (Join-Path $respaldo $f)) { Copy-Item (Join-Path $respaldo $f) . -Force } else { Remove-Item $f -Force -ErrorAction SilentlyContinue }
    }
  }
  # Tokens PROPIOS de la demo: se asignan por SQL a los nodos sembrados (no se usa .demo-devices.json, que puede ser el real).
  function Token43 { -join ((48..57) + (65..90) + (97..122) + 45 + 95 | Get-Random -Count 43 | ForEach-Object { [char]$_ }) }
  $tokens = [ordered]@{}
  $sql = ''
  foreach ($g in 1..10) { $t = Token43; $tokens["I$g"] = $t; $sql += "update iot.nodes set token_hash = sha256(convert_to('$t','UTF8')), token_prefix = left('$t',6) where greenhouse_id = $g; " }
  $t = Token43; $tokens['MAST'] = $t; $sql += "update iot.nodes set token_hash = sha256(convert_to('$t','UTF8')), token_prefix = left('$t',6) where kind = 'mast'; "
  $sql | & docker @dc exec -T postgres psql -U postgres -d iot -q
  if ($LASTEXITCODE -ne 0) { throw 'No se pudieron asignar los tokens de los nodos de la demo.' }
  # Administrador de la demo con clave conocida
  $clave = 'Demo-' + (Clave)
  $script = Join-Path $tmp 'mkadmin.ts'
  @"
import { adminDb } from '$($dash -replace '\\','/')/scripts/lib/scriptenv'
import { hashPassword } from '$($dash -replace '\\','/')/src/lib/auth/password'
async function main() {
  const sql = adminDb(1)
  await sql``delete from iot.app_users where email = 'demo-admin@invernadero.local'``
  await sql``insert into iot.app_users (email, name, role, password_hash) values ('demo-admin@invernadero.local', 'Administrador demo', 'admin', `${await hashPassword(process.argv[2]!)})``
  await sql.end()
}
main().catch((e) => { console.error(e.message); process.exit(1) })
"@ | Set-Content $script -Encoding utf8
  npx tsx $script $clave
  if ($LASTEXITCODE -ne 0) { throw 'No se pudo crear el administrador de la demo' }

  if (-not $SinSimulador) {
    Write-Host '== Arrancando el simulador de nodos (ventana aparte)...' -ForegroundColor Cyan
    # El simulador usa los tokens que se acaban de asignar a la base de la demo.
    $add = ($tokens.GetEnumerator() | ForEach-Object { "$($_.Key)=$($_.Value)" }) -join ','
    $soloOtros = ''; $fast = ' --fast'   # --fast fija el reporte de los nodos en 15 s mientras corre el simulador
    $cmd = "Set-Location '$dash'; `$env:DATABASE_HOST='127.0.0.1'; `$env:DATABASE_PORT='55432'; `$env:DATABASE_NAME='iot'; `$env:DATABASE_SSL_MODE='disable'; `$env:DATABASE_USER='iot_app'; `$env:DATABASE_PASSWORD='$($cfg['IOT_APP_PASSWORD'])'; npx tsx scripts/simulate.ts --url http://127.0.0.1:3000 --scenario demo$fast --add '$add'$soloOtros"
    Start-Process powershell -ArgumentList '-NoExit', '-Command', $cmd
  }
} finally { Pop-Location }

if (-not $NoAbrir) { Start-Process 'http://127.0.0.1:3000' }
Write-Host "`nDemo lista: http://127.0.0.1:3000" -ForegroundColor Green
Write-Host "  Usuario:  demo-admin@invernadero.local"
Write-Host "  Clave:    $clave"
Write-Host "  Detener:  .\scripts\demo-pc.ps1 -Detener`n"
