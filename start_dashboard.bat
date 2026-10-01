@echo off
rem Запуск дашборда простоя F-4 / заявок / проблем Service Desk.
rem Открой потом в браузере: http://localhost:8765
cd /d "%~dp0backend"
"%~dp0..\connectors\servicedesk\venv\Scripts\python.exe" app.py
pause
