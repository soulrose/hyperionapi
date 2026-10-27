@echo off
cd /d "%~dp0"
rem Hyperion API: its own window (http://localhost:4321), no console window; the server stops when the window closes.
rem Server output: server.log
if not exist node_modules call npm install --no-audit --no-fund
powershell -NoProfile -WindowStyle Hidden -Command "Start-Process -FilePath node -ArgumentList 'bin\hyperion.mjs','serve','--port','4321','--open' -WorkingDirectory '%~dp0.' -WindowStyle Hidden -RedirectStandardOutput '%~dp0server.log' -RedirectStandardError '%~dp0server.err.log'"
