@echo off
title NEON STRIKE - Game Server
cd /d "%~dp0"

rem ============ Node.js 环境检测 ============
set "NODE_EXE=%~dp0.runtime\node.exe"
if exist "%NODE_EXE%" goto node_ready
set "NODE_EXE="
for /f "delims=" %%N in ('where node.exe 2^>nul') do if not defined NODE_EXE set "NODE_EXE=%%N"
if defined NODE_EXE goto node_ready
echo Node.js was not found.
echo Install Node.js LTS from https://nodejs.org/ and reopen this window.
pause
exit /b 1

:node_ready
"%NODE_EXE%" -e "require('ws')" >nul 2>&1
if errorlevel 1 (
  echo Missing dependency: ws. Run npm install in this folder.
  pause
  exit /b 1
)
if not defined PORT set "PORT=8080"

rem ============ 探测已安装的浏览器 ============
set "CHROME="
if exist "%ProgramFiles%\Google\Chrome\Application\chrome.exe" set "CHROME=%ProgramFiles%\Google\Chrome\Application\chrome.exe"
if exist "%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe" set "CHROME=%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"
if exist "%LocalAppData%\Google\Chrome\Application\chrome.exe" set "CHROME=%LocalAppData%\Google\Chrome\Application\chrome.exe"

set "EDGE="
if exist "%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe" set "EDGE=%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe"
if exist "%ProgramFiles%\Microsoft\Edge\Application\msedge.exe" set "EDGE=%ProgramFiles%\Microsoft\Edge\Application\msedge.exe"

set "FIREFOX="
if exist "%ProgramFiles%\Mozilla Firefox\firefox.exe" set "FIREFOX=%ProgramFiles%\Mozilla Firefox\firefox.exe"
if exist "%ProgramFiles(x86)%\Mozilla Firefox\firefox.exe" set "FIREFOX=%ProgramFiles(x86)%\Mozilla Firefox\firefox.exe"

set "BRAVE="
if exist "%LocalAppData%\BraveSoftware\Brave-Browser\Application\brave.exe" set "BRAVE=%LocalAppData%\BraveSoftware\Brave-Browser\Application\brave.exe"
if exist "%ProgramFiles%\BraveSoftware\Brave-Browser\Application\brave.exe" set "BRAVE=%ProgramFiles%\BraveSoftware\Brave-Browser\Application\brave.exe"

set "CHROMECORE="
if exist "%ProgramFiles(x86)%\ChromeCore\ChromeCore.exe" set "CHROMECORE=%ProgramFiles(x86)%\ChromeCore\ChromeCore.exe"

rem ============ 读取上次的浏览器选择 ============
set "CONF=%~dp0browser_choice.txt"
set "SAVED="
if exist "%CONF%" set /p SAVED=<"%CONF%"

:pick
cls
echo.
echo ================================================
echo   NEON STRIKE - local game server
echo   Keep this window OPEN while playing.
echo   Close this window to stop the server.
echo ================================================
echo.
echo   用哪个浏览器打开游戏？（端口 %PORT%）
if defined SAVED (
  if "%SAVED%"=="NONE" (echo   上次选择：不自动打开浏览器
  ) else if "%SAVED%"=="DEFAULT" (echo   上次选择：系统默认浏览器
  ) else (echo   上次选择：已保存，直接回车沿用
  )
  echo   （直接按回车 = 沿用上次选择）
)
echo   [1] Google Chrome
echo   [2] Microsoft Edge
echo   [3] Mozilla Firefox
echo   [4] Brave
echo   [5] 其他浏览器（手动输入 exe 路径）
echo   [6] 系统默认浏览器
echo   [7] 双核浏览器 (ChromeCore)
echo   [0] 只开服务器，不自动打开
echo.
set "BCHOICE="
set /p BCHOICE=请输入数字后回车：

if not defined BCHOICE goto use_saved
if "%BCHOICE%"=="1" goto b_chrome
if "%BCHOICE%"=="2" goto b_edge
if "%BCHOICE%"=="3" goto b_firefox
if "%BCHOICE%"=="4" goto b_brave
if "%BCHOICE%"=="5" goto b_other
if "%BCHOICE%"=="6" goto b_default
if "%BCHOICE%"=="7" goto b_chromecore
if "%BCHOICE%"=="0" goto b_none
echo   无效输入，请重新选择
timeout /t 1 >nul
goto pick

:use_saved
if not defined SAVED goto b_default
if "%SAVED%"=="NONE" goto b_none
if "%SAVED%"=="DEFAULT" goto b_default
set "BROWSER_EXE=%SAVED%"
set "BROWSER_KEEP=%SAVED%"
goto b_verify

:b_chrome
if not defined CHROME (echo   [X] 未检测到 Chrome，请先安装或选其他 & timeout /t 1 >nul & goto pick)
set "BROWSER_EXE=%CHROME%"
set "BROWSER_KEEP=%CHROME%"
goto b_verify
:b_edge
if not defined EDGE (echo   [X] 未检测到 Edge & timeout /t 1 >nul & goto pick)
set "BROWSER_EXE=%EDGE%"
set "BROWSER_KEEP=%EDGE%"
goto b_verify
:b_firefox
if not defined FIREFOX (echo   [X] 未检测到 Firefox & timeout /t 1 >nul & goto pick)
set "BROWSER_EXE=%FIREFOX%"
set "BROWSER_KEEP=%FIREFOX%"
goto b_verify
:b_brave
if not defined BRAVE (echo   [X] 未检测到 Brave & timeout /t 1 >nul & goto pick)
set "BROWSER_EXE=%BRAVE%"
set "BROWSER_KEEP=%BRAVE%"
goto b_verify
:b_chromecore
if not defined CHROMECORE (echo   [X] 未检测到双核浏览器 & timeout /t 1 >nul & goto pick)
set "BROWSER_EXE=%CHROMECORE%"
set "BROWSER_KEEP=%CHROMECORE%"
goto b_verify
:b_other
set "BROWSER_EXE="
set /p BROWSER_EXE=请输入浏览器 exe 的完整路径，例如 C:\Program Files\...\chrome.exe：
if not defined BROWSER_EXE (echo   未输入路径，请重新选择 & timeout /t 1 >nul & goto pick)
if not exist "%BROWSER_EXE%" (echo   路径不存在，请重新选择 & timeout /t 1 >nul & goto pick)
set "BROWSER_KEEP=%BROWSER_EXE%"
goto b_verify
:b_default
set "BROWSER_EXE="
set "BROWSER_KEEP=DEFAULT"
goto b_verify
:b_none
set "BROWSER_EXE=__NONE__"
set "BROWSER_KEEP=NONE"
goto b_verify

:b_verify
if "%BROWSER_EXE%"=="__NONE__" goto b_save
if not defined BROWSER_EXE goto b_save
if not exist "%BROWSER_EXE%" (
  echo   上次的浏览器路径已失效，请重新选择
  timeout /t 1 >nul
  goto pick
)

:b_save
> "%CONF%" echo %BROWSER_KEEP%

rem ============ 延迟 2 秒后打开所选浏览器 ============
if "%BROWSER_EXE%"=="__NONE__" goto run_server
if defined BROWSER_EXE (
  start "" powershell -NoProfile -WindowStyle Hidden -Command "Start-Sleep -Seconds 2; Start-Process -FilePath '%BROWSER_EXE%' -ArgumentList 'http://localhost:%PORT%/?v=3'"
) else (
  start "" cmd /c "timeout /t 2 /nobreak >nul & start "" http://localhost:%PORT%/?v=3"
)

:run_server
echo.
echo   Starting server on http://localhost:%PORT%/ ...
echo.
"%NODE_EXE%" server.js
echo.
echo Server stopped.
pause
