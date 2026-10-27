@echo off
cd /d "%~dp0"
rem Hyperion API demo against a mock API (http://localhost:4322), no console window.
if not exist node_modules call npm install --no-audit --no-fund
powershell -NoProfile -WindowStyle Hidden -Command "Start-Process -FilePath node -ArgumentList 'bin\hyperion.mjs','demo','--open' -WorkingDirectory '%~dp0.' -WindowStyle Hidden -RedirectStandardOutput '%~dp0demo.log' -RedirectStandardError '%~dp0demo.err.log'"
