@echo off
title Stop NEON STRIKE Server

echo.
echo === NEON STRIKE : STOP SERVER ===
echo.

set "PID="
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":8080" ^| findstr LISTENING') do set "PID=%%a"

if defined PID (
    echo [OK] Found server PID = %PID%
    echo      Killing...
    taskkill /F /PID %PID% >nul 2>&1
    if errorlevel 1 (
        echo [FAIL] Kill failed - try running as Administrator
    ) else (
        echo [OK] Server stopped. Port 8080 is free.
    )
) else (
    echo [--] Port 8080 is free. Server not running.
)

echo.
pause
