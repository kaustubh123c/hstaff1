@echo off
setlocal
cd /d "%~dp0"
echo ==========================================
echo H-Staff PC Setup
echo ==========================================
where node >nul 2>nul || (echo Node.js is not installed. Install Node.js 22.12 or newer from https://nodejs.org/ & pause & exit /b 1)
node -e "const v=process.versions.node.split('.').map(Number); if(v[0]<22 || (v[0]===22 && v[1]<12)){console.error('Node.js 22.12 or newer is required.');process.exit(1)}" || (pause & exit /b 1)
echo Installing frontend dependencies...
call npm install
if errorlevel 1 (echo Frontend dependency installation failed.& pause & exit /b 1)
echo Installing backend dependencies...
call npm install --prefix server
if errorlevel 1 (echo Backend dependency installation failed.& pause & exit /b 1)
echo.
echo Setup complete. Run START-HSTAFF.bat to launch the application.
pause
