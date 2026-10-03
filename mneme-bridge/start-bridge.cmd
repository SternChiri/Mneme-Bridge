@echo off
title mneme-bridge (memory service :8760)
cd /d "%~dp0"
echo [mneme-bridge] starting on http://0.0.0.0:8760 ...
echo [mneme-bridge] token 在 config.json 的 bridgeToken 字段
node server.js
pause
