@echo off
REM Kills the Meta Harness service + broker. Leaves the Fleet dashboard alone.

setlocal EnableDelayedExpansion

if "%META_HARNESS_PORT%"=="" set "META_HARNESS_PORT=20000"

echo [meta-harness] stopping listener on :%META_HARNESS_PORT%
for /f "tokens=5" %%p in ('netstat -ano ^| findstr /R /C:":%META_HARNESS_PORT% .*LISTENING"') do (
  if not "%%p"=="0" (
    echo   killing pid %%p
    taskkill /F /PID %%p >nul 2>nul
  )
)

echo [meta-harness] stopping meta-broker windows
taskkill /F /FI "WINDOWTITLE eq meta-broker*" >nul 2>nul
taskkill /F /FI "WINDOWTITLE eq meta-harness*" >nul 2>nul

REM Fallback: any node.exe running our broker/harness binaries
for /f "skip=1 tokens=2 delims=," %%a in ('wmic process where "name='node.exe'" get commandline^,processid /format:csv 2^>nul ^| findstr /I "meta-broker meta-harness"') do (
  taskkill /F /PID %%a >nul 2>nul
)

echo [meta-harness] stopped.
endlocal
exit /b 0
