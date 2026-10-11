@echo off
setlocal enabledelayedexpansion
title AGMessage
cd /d "%~dp0"

echo.
echo   ================================================
echo     AGMessage is starting...
echo   ================================================
echo.
echo   Keep this window open while the meeting runs.
echo   Press Ctrl+C to stop the server when you're done.
echo.
echo   A browser will open in a moment. Share the LAN
echo   URL below with your team so they can join from
echo   their phones, tablets, or laptops.
echo.

REM Open the local page after a short delay so the server is ready.
start "" /b cmd /c "timeout /t 2 /nobreak >nul & start "" http://localhost:3023"

REM Launch Node with the bundled runtime. PORT can be overridden.
REM The watchdog (app\supervise.js) runs the server and restarts it if it crashes or stops responding
REM (heartbeat), backing off 2-30 s; rooms, history and everyone's place come back from the saved log.
REM It gives up after 6 crashes in 10 minutes and says why on the admin page. Ctrl+C stops it for good.
REM This loop is the last line of defence, should the watchdog itself ever stop.
if "%PORT%"=="" set PORT=3023
:run
"%~dp0node\node.exe" "%~dp0app\supervise.js"
set CODE=%ERRORLEVEL%
if "%CODE%"=="0" goto stopped
if "%CODE%"=="3" goto stopped
echo.
echo   AGMessage stopped unexpectedly (code %CODE%) - restarting in 2 seconds...
timeout /t 2 /nobreak >nul
goto run
:stopped

echo.
echo   Server stopped. Press any key to close this window.
pause >nul
