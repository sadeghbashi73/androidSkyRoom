@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo ============================================
echo   Skyroom PWA - Dev Server
echo ============================================
echo.
where node >nul 2>nul
if %errorlevel% neq 0 (
    echo [ERROR] Node.js not found. Install from https://nodejs.org
    pause
    exit /b 1
)
echo [INFO] Starting server on http://localhost:5173
echo [INFO] For mobile, run: ngrok http 5173
echo.
node tools/serve.js
pause