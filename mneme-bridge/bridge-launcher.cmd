@echo off
setlocal enabledelayedexpansion
rem ============================================================
rem  mneme-bridge launcher
rem  First run: ask about autostart, then start tray resident
rem  Later runs: start tray resident directly
rem  Also:  bridge-launcher.cmd install   = register autostart
rem         bridge-launcher.cmd uninstall = remove autostart
rem ============================================================
set "PROJDIR=%~dp0"
set "DEPLOYDIR=%PROJDIR%deploy"
set "MARKER=%APPDATA%\mneme-bridge\initialized.flag"

if /I "%~1"=="install" (
  powershell -NoProfile -ExecutionPolicy Bypass -File "%DEPLOYDIR%\install-startup.ps1"
  goto :start_tray
)
if /I "%~1"=="uninstall" (
  powershell -NoProfile -ExecutionPolicy Bypass -File "%DEPLOYDIR%\uninstall-startup.ps1"
  goto :start_tray
)

if exist "%MARKER%" goto :start_tray

echo ============================================
echo   mneme-bridge first-time setup
echo ============================================
echo.
set "AUTOSTART=N"
set /p "AUTOSTART=Register autostart at login? (Y/N, default N): "
if /I "!AUTOSTART!"=="Y" (
  powershell -NoProfile -ExecutionPolicy Bypass -File "%DEPLOYDIR%\install-startup.ps1"
) else (
  echo Skipped. You can register later:  bridge-launcher.cmd install
)
if not exist "%APPDATA%\mneme-bridge" mkdir "%APPDATA%\mneme-bridge"
echo ok> "%MARKER%"
echo.

:start_tray
echo Starting mneme-bridge tray...
start "" powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "%DEPLOYDIR%\bridge-tray.ps1"
echo Tray started (system tray icon, right-click to manage)
ping -n 3 127.0.0.1 >nul
