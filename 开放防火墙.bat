@echo off
title NEON STRIKE - Firewall Setup
echo ================================================
echo   NEON STRIKE - Open firewall for port 8080
echo   Run this ONCE on the computer that HOSTS the game.
echo   (Other computers will connect to this one.)
echo ================================================

REM Check for administrator rights
net session >nul 2>&1
if %errorlevel% neq 0 (
  echo.
  echo Need administrator privileges. Restarting elevated...
  powershell -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  exit /b
)

echo.
echo Removing old rule (if any)...
netsh advfirewall firewall delete rule name="NEON STRIKE Server" >nul 2>&1

echo Adding inbound rule for TCP port 8080...
netsh advfirewall firewall add rule name="NEON STRIKE Server" dir=in action=allow protocol=TCP localport=8080

echo.
echo ================================================
echo   Done! Port 8080 is now open for incoming game
echo   connections. Other computers on your LAN/Wi-Fi
echo   can now join this computer as the game server.
echo   You only need to run this once.
echo ================================================
echo.
pause
