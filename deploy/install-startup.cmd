@echo off
rem run once: create startup shortcut (no side effects if re-run)
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install-startup.ps1"
pause
