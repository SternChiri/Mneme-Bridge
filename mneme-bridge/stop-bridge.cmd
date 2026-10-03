@echo off
for /f "tokens=5" %%a in ('netstat -ano ^| findstr :8760 ^| findstr LISTENING') do taskkill /PID %%a /F
echo [mneme-bridge] stopped
