@echo off
rem ---------------------------------------------------------------
rem  QRFolder - stop (Windows)
rem
rem  Double-click this file to stop the service. It also finds an
rem  instance started by hand with "node src/main.ts".
rem
rem  All the logic lives in scripts\service.ps1
rem ---------------------------------------------------------------

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\service.ps1" stop

if errorlevel 1 pause
