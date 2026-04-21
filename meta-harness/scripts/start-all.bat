@echo off
REM Launches the Meta Harness service and broker in separate windows on Windows.
REM Fleet dashboard stays on its own start-dashboard.bat.
REM Requires META_HARNESS_ADMIN_TOKEN in the environment.

setlocal EnableDelayedExpansion

pushd "%~dp0.."
set "ROOT=%cd%"

REM Accept an optional token as the first arg so PowerShell users don't get
REM bitten by `set VAR=value` being a PS alias that doesn't export env vars.
if not "%~1"=="" set "META_HARNESS_ADMIN_TOKEN=%~1"

if "%META_HARNESS_ADMIN_TOKEN%"=="" (
  echo [meta-harness] META_HARNESS_ADMIN_TOKEN is not set.
  echo.
  echo   cmd.exe:     set META_HARNESS_ADMIN_TOKEN=your-token  ^&^&  scripts\start-all.bat
  echo   PowerShell:  $env:META_HARNESS_ADMIN_TOKEN = "your-token"; .\scripts\start-all.bat
  echo   or pass as arg:   scripts\start-all.bat your-token
  popd
  exit /b 1
)

where node >nul 2>nul
if errorlevel 1 (
  echo [meta-harness] Node.js not found on PATH. Install Node 18+ and try again.
  popd
  exit /b 1
)

if not exist node_modules (
  echo [meta-harness] installing deps...
  call npm install --no-audit --no-fund --loglevel=error
  if errorlevel 1 (
    echo [meta-harness] npm install failed.
    popd
    exit /b 1
  )
)

if not exist data\logs mkdir data\logs
set "HARNESS_LOG=%ROOT%\data\logs\meta-harness.log"
set "BROKER_LOG=%ROOT%\data\logs\meta-broker.log"

REM Port selection + kill any listener already holding it.
if "%META_HARNESS_PORT%"=="" set "META_HARNESS_PORT=20000"

for /f "tokens=5" %%p in ('netstat -ano ^| findstr /R /C:":%META_HARNESS_PORT% .*LISTENING"') do (
  if not "%%p"=="0" (
    echo [meta-harness] stopping previous listener on :%META_HARNESS_PORT% ^(pid %%p^)
    taskkill /F /PID %%p >nul 2>nul
  )
)

echo [meta-harness] starting service on :%META_HARNESS_PORT% ^(log: %HARNESS_LOG%^)
start "meta-harness" /MIN cmd /c "node bin\meta-harness.js > "%HARNESS_LOG%" 2>&1"

REM Give the service a couple of seconds to open its port.
REM ping loopback is the classic .bat sleep trick; works on any Windows shell.
ping -n 3 127.0.0.1 >nul 2>&1

echo [meta-harness] starting broker ^(log: %BROKER_LOG%^)
start "meta-broker" /MIN cmd /c "node bin\meta-broker.js > "%BROKER_LOG%" 2>&1"

echo.
echo   ============================================
echo      META HARNESS STACK - UP
echo   ============================================
echo.
echo   Service:  http://localhost:%META_HARNESS_PORT%
echo   UI:       http://localhost:%META_HARNESS_PORT%/ui/missions.html
echo   WS:       ws://localhost:%META_HARNESS_PORT%/v1/events
echo   Logs:     %HARNESS_LOG%
echo             %BROKER_LOG%
echo.
echo   Fleet dashboard (separate):
echo             .fleet\start-dashboard.bat
echo.
echo   To stop: close the "meta-harness" and "meta-broker" windows,
echo            or run scripts\stop-all.bat
echo.

popd
endlocal
exit /b 0
