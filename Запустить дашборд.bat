@echo off
setlocal

set "DASH_DIR=C:\AI_service_system\servicedesk_dashboard"
set "PY=C:\AI_service_system\connectors\servicedesk\venv\Scripts\python.exe"

rem If already running (port 8765 responds) - just open the browser.
powershell -NoProfile -Command "(Test-NetConnection -ComputerName localhost -Port 8765 -WarningAction SilentlyContinue).TcpTestSucceeded" | findstr /I "True" >nul
if %errorlevel%==0 (
    start "" "http://localhost:8765"
    exit /b
)

cd /d "%DASH_DIR%\backend"
start "Service Desk Dashboard" "%PY%" app.py

timeout /t 3 /nobreak >nul

start "" "http://localhost:8765"
exit /b
