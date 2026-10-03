@echo off
rem mneme-bridge tray: double-click to run (hidden window, tray icon "M")
powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "%~dp0bridge-tray.ps1"
