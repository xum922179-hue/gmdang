@echo off
title NEON STRIKE - Update shortcut
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0update_url.ps1"
if errorlevel 1 (
  echo Failed to detect LAN IP. Please check network connection.
  pause
  exit /b 1
)
echo.
echo Shortcut updated. Send the shortcut file to your friends.
pause
