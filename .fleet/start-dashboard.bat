@echo off
title Fleet Command Dashboard
cd /d "%~dp0"

set PROJECT_ROOT=%~dp0..
if not exist "%PROJECT_ROOT%\.claude" mkdir "%PROJECT_ROOT%\.claude"

echo.
echo   ========================================
echo        FLEET COMMAND — STARTING...
echo   ========================================
echo.

where node >nul 2>nul
if %errorlevel% neq 0 (
    echo   [WARN] Node.js not found. Install from https://nodejs.org
    pause
    exit /b 1
)

if not exist node_modules (
    echo   [INFO] Installing dependencies...
    call npm install
)

echo   [OK] Starting bridge on http://localhost:27182/
echo   [OK] Opening dashboard in browser...
echo   [INFO] Press Ctrl+C to stop
echo.

start "" "http://localhost:27182/"
node agent-bridge.js
