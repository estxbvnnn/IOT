@echo off
rem Compila y ejecuta las pruebas de host con MSVC.
rem Abrir el "Simbolo del sistema para desarrolladores de VS" (o llamar antes a vcvars64.bat) y ejecutar:
rem     ejecutar_pruebas.bat
rem Para incluir test_protocolo, definir antes la ruta de la libreria ArduinoJson v7 (carpeta src):
rem     set ARDUINOJSON_DIR=C:\ruta\a\libraries\ArduinoJson\src
setlocal
cd /d "%~dp0"
set FLAGS=/nologo /EHsc /std:c++17 /W4 /I..\nodo_invernadero
set FALLO=0
set "EXTRA="

call :probar test_riego
call :probar test_envio
if not defined ARDUINOJSON_DIR goto sinjson
set EXTRA=/external:I"%ARDUINOJSON_DIR%" /external:W0
call :probar test_protocolo
goto fin
:sinjson
echo === test_protocolo omitido: defina ARDUINOJSON_DIR ===
:fin
exit /b %FALLO%

:probar
echo === %~1 ===
cl %FLAGS% %EXTRA% %~1.cpp /Fe:%~1.exe > "%TEMP%\%~1.log" 2>&1
if errorlevel 1 goto errorcompilacion
"%CD%\%~1.exe"
if errorlevel 1 set FALLO=1
exit /b 0
:errorcompilacion
type "%TEMP%\%~1.log"
echo ERROR de compilacion en %~1
set FALLO=1
exit /b 1
