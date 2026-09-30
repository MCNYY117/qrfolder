@echo off
rem ---------------------------------------------------------------
rem  QRFolder - one-click start (Windows)
rem
rem  Double-click this file. The service is launched WITHOUT a console
rem  window, so this window closing does not stop it.
rem
rem  All the logic lives in scripts\service.ps1 - see that file for
rem  details, and use stop.bat to shut the service down.
rem ---------------------------------------------------------------

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\service.ps1" start

rem Keep the window open only when something went wrong, so the message
rem can actually be read. On success it closes immediately.
if errorlevel 1 pause
