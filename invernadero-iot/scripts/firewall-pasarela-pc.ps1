<#
  Abre (y despues CIERRA) los puertos de la pasarela para probar con las placas, usando este PC en lugar de la Raspberry Pi.
  Hay que ejecutarlo como ADMINISTRADOR (PowerShell > clic derecho > Ejecutar como administrador).

    .\firewall-pasarela-pc.ps1 -Abrir              # abre 3100 (pasarela) y 3000 (dashboard) solo en red PRIVADA y solo desde la red local
    .\firewall-pasarela-pc.ps1 -Abrir -Horas 6     # igual, y programa el cierre automatico dentro de 6 horas
    .\firewall-pasarela-pc.ps1 -Estado             # muestra si las reglas existen
    .\firewall-pasarela-pc.ps1 -Cerrar             # REVIERTE: borra las reglas y la tarea programada

  Solo crea/borra reglas con el nombre «IoT pasarela PC (prueba)»; no toca ninguna otra regla del firewall.
#>
[CmdletBinding()]
param(
  [switch]$Abrir,
  [switch]$Cerrar,
  [switch]$Estado,
  [int]$Horas = 0
)

$ErrorActionPreference = 'Stop'
$Regla = 'IoT pasarela PC (prueba)'
$Tarea = 'IoT pasarela PC - cierre automatico'
$Puertos = '3100,3000'

function Test-Admin {
  $p = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
  $p.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

if (-not ($Abrir -or $Cerrar -or $Estado)) { Get-Help $MyInvocation.MyCommand.Path | Out-String | Write-Host; exit 1 }
if (($Abrir -or $Cerrar) -and -not (Test-Admin)) { Write-Error 'Ejecute este script como administrador.'; exit 1 }

if ($Estado) {
  $r = Get-NetFirewallRule -DisplayName $Regla -ErrorAction SilentlyContinue
  if ($r) { $r | Format-Table DisplayName, Enabled, Direction, Action, Profile -AutoSize } else { Write-Host 'No hay reglas abiertas (estado normal).' }
  $t = Get-ScheduledTask -TaskName $Tarea -ErrorAction SilentlyContinue
  if ($t) { Write-Host "Cierre automatico programado: $((Get-ScheduledTaskInfo -TaskName $Tarea).NextRunTime)" }
  exit 0
}

if ($Cerrar) {
  Get-NetFirewallRule -DisplayName $Regla -ErrorAction SilentlyContinue | Remove-NetFirewallRule
  Unregister-ScheduledTask -TaskName $Tarea -Confirm:$false -ErrorAction SilentlyContinue
  Write-Host "Cerrado: reglas «$Regla» eliminadas y tarea de cierre quitada."
  exit 0
}

# Abrir: TCP entrante, solo perfil Privado y solo desde la subred local.
Get-NetFirewallRule -DisplayName $Regla -ErrorAction SilentlyContinue | Remove-NetFirewallRule
New-NetFirewallRule -DisplayName $Regla -Direction Inbound -Action Allow -Protocol TCP -LocalPort $Puertos.Split(',') `
  -Profile Private -RemoteAddress LocalSubnet | Out-Null
Write-Host "Abiertos los puertos $Puertos (TCP, red privada, solo subred local)."
Write-Host 'Si su WiFi esta como «Publica», cambiela a «Privada» (Configuracion > Red e Internet) o la regla no aplica.'

if ($Horas -gt 0) {
  $cuando = (Get-Date).AddHours($Horas)
  $accion = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$($MyInvocation.MyCommand.Path)`" -Cerrar"
  $disparo = New-ScheduledTaskTrigger -Once -At $cuando
  Register-ScheduledTask -TaskName $Tarea -Action $accion -Trigger $disparo -RunLevel Highest -Force | Out-Null
  Write-Host "Se cerrara solo el $cuando."
} else {
  Write-Host 'Cuando termine las pruebas, REVIERTA con:  .\firewall-pasarela-pc.ps1 -Cerrar'
}
