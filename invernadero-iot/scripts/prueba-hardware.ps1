<#
  Prueba de la NodeMCU REAL contra el sistema que corre en ESTE PC (plan B / ensayo), sin tocar el archivo del firmware del repositorio.

    1) .\scripts\demo-pc.ps1 -NodoReal -SinSimulador       # levanta el sistema y registra el token del nodo en la base de la demo
    2) Conectar la NodeMCU por USB a este PC (y este PC al WiFi de la placa: Wifuu)
    3) .\scripts\prueba-hardware.ps1                        # compila una COPIA del sketch apuntando a la IP de este PC, la sube y abre el Monitor Serie
    4) Al terminar:  .\scripts\prueba-hardware.ps1 -Restaurar   # vuelve a subir el sketch ORIGINAL del repositorio (MQTT_HOST = la Pi)

  Opciones: -Puerto COM5   -IpPc 10.231.225.12   -SinMonitor   -SoloCompilar (ensayo sin placa: solo compila la copia)
  El .ino del repositorio no se modifica nunca: la copia temporal vive en %TEMP%\iot-hw.
#>
param([string]$Puerto, [string]$IpPc, [switch]$Restaurar, [switch]$SinMonitor, [switch]$SoloCompilar)
# Los programas externos (arduino-cli, docker) escriben avisos por stderr: con 'Stop' PowerShell 5.1 los trata como error. Se revisa $LASTEXITCODE donde importa.
$ErrorActionPreference = 'Continue'
$proyecto = Split-Path -Parent $PSScriptRoot
$origen = Join-Path $proyecto 'firmware\nododefinitivo'
$fqbn = 'esp8266:esp8266:nodemcuv2'

$cli = (Get-Command arduino-cli -ErrorAction SilentlyContinue).Source
if (-not $cli) { $cli = Join-Path $env:LOCALAPPDATA 'Programs\Arduino IDE\resources\app\lib\backend\resources\arduino-cli.exe' }
if (-not (Test-Path $cli)) { throw 'No encuentro arduino-cli (viene con el Arduino IDE 2).' }
$cfg = Join-Path $env:USERPROFILE '.arduinoIDE\arduino-cli.yaml'
$base = @(); if (Test-Path $cfg) { $base = @('--config-file', $cfg) }

# ---------------------------------------------------------------- puerto
if (-not $Puerto -and -not $SoloCompilar) {
  $json = & $cli @base board list --format json 2>$null | ConvertFrom-Json
  $lista = @(); if ($json.detected_ports) { $lista = @($json.detected_ports) } elseif ($json) { $lista = @($json) }
  $serie = @($lista | Where-Object { $_.port.protocol -eq 'serial' })
  if ($serie.Count -eq 1) { $Puerto = $serie[0].port.address }
  elseif ($serie.Count -gt 1) { throw "Hay varios puertos: $($serie.port.address -join ', '). Indique uno con -Puerto." }
  else { throw 'No se detecta ninguna placa por USB. Conecte la NodeMCU (cable de datos) o indique -Puerto COMx.' }
}
if ($Puerto) { Write-Host "Placa en $Puerto" -ForegroundColor Cyan }

# ---------------------------------------------------------------- sketch a subir
if ($Restaurar) {
  $sketch = $origen
  Write-Host 'Restaurando el sketch ORIGINAL del repositorio (MQTT_HOST de la Pi)...' -ForegroundColor Cyan
} else {
  if (-not $IpPc) {
    $IpPc = (Get-NetIPAddress -AddressFamily IPv4 -InterfaceAlias 'Wi-Fi*' -ErrorAction SilentlyContinue | Where-Object { $_.IPAddress -notmatch '^169\.254' } | Select-Object -First 1).IPAddress
    if (-not $IpPc) { throw 'Este PC no tiene IP en el WiFi. Conéctelo a la misma red que la NodeMCU (Wifuu) o indique -IpPc.' }
  }
  $tmp = Join-Path $env:TEMP 'iot-hw\nododefinitivo'
  Remove-Item (Split-Path $tmp) -Recurse -Force -ErrorAction SilentlyContinue
  New-Item -ItemType Directory -Force $tmp | Out-Null
  $txt = [IO.File]::ReadAllText((Join-Path $origen 'nododefinitivo.ino'))
  $nuevo = [regex]::Replace($txt, '(#define\s+MQTT_HOST\s+)"[^"]*"', "`$1`"$IpPc`"")
  if ($nuevo -eq $txt) { throw 'No encontré la línea #define MQTT_HOST en el sketch.' }
  [IO.File]::WriteAllText((Join-Path $tmp 'nododefinitivo.ino'), $nuevo)
  $sketch = $tmp
  Write-Host "Copia temporal del sketch con MQTT_HOST = $IpPc (el original no se toca)." -ForegroundColor Cyan
  Write-Host "  Recuerde: el firewall de Windows debe permitir la entrada al puerto 1883 en la red privada." -ForegroundColor Yellow
}

# ---------------------------------------------------------------- compilar y subir
Write-Host 'Compilando...' -ForegroundColor Cyan
& $cli @base compile --fqbn $fqbn $sketch 2>&1 | ForEach-Object { "$_" } | Select-String -Pattern 'error|Sketch uses|Code in flash|Variables and constants'
if ($LASTEXITCODE -ne 0) { throw 'La compilación falló.' }
if ($SoloCompilar) { Write-Host "`nCompilación correcta (modo -SoloCompilar: no se subió nada)." -ForegroundColor Green; return }
Write-Host 'Subiendo a la placa (no cierre el Monitor Serie del IDE: ocupa el puerto)...' -ForegroundColor Cyan
& $cli @base upload -p $Puerto --fqbn $fqbn $sketch 2>&1 | ForEach-Object { "$_" } | Select-Object -Last 4
if ($LASTEXITCODE -ne 0) { throw 'No se pudo subir. Cierre el Monitor Serie del Arduino IDE y repita.' }

if ($Restaurar) { Write-Host "`nListo: la placa quedó con el sketch original (MQTT_HOST = la Pi)." -ForegroundColor Green; return }

Write-Host @"

Subido. Qué mirar en el Monitor Serie (115200):
  - "WiFi: conectado, IP …"  y  "MQTT: conectado a $IpPc:1883 como nodo-xxxxxx"
  - la tabla de estado cada pocos segundos (temperatura, humedad, suelo)
En el dashboard (http://127.0.0.1:3000, usuario demo-admin…): el invernadero I1 debe figurar EN LÍNEA con esas lecturas.
Pruebas físicas sugeridas: sensor en el aire (seco) → en agua (saturado); riego manual de 10 s (2 pasos); parar; desconectar y reconectar el WiFi.
Para volver a la Pi:  .\scripts\prueba-hardware.ps1 -Restaurar
"@ -ForegroundColor Green
if (-not $SinMonitor) { & $cli @base monitor -p $Puerto -c baudrate=115200 }
