@echo off
echo Restarting Indonesia Stock Scalper Server...
echo Stopping server...
taskkill /f /im node.exe
timeout /t 2 /nobreak > nul
echo Starting server...
cd /d "%~dp0"
npm start
echo Server restarted successfully!
pause
