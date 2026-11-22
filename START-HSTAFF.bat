@echo off
setlocal
cd /d "%~dp0"
if not exist node_modules (echo Run SETUP-PC.bat first.& pause & exit /b 1)
if not exist server\node_modules (echo Run SETUP-PC.bat first.& pause & exit /b 1)
echo Starting H-Staff API and website...
echo Website: http://localhost:5173
echo API health: http://localhost:4000/api/health
echo Keep this window open while using H-Staff.
call npm run dev:all
pause
