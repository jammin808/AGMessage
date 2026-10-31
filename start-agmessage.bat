@echo off
setlocal
title AGMessage
cd /d "%~dp0"

echo.
echo   ================================================
echo     AGMessage is starting...
for %%I in ("%~dp0.") do echo     from %%~fI
echo   ================================================
echo.

REM An AGMessage installed on this PC is named first: the installer's one record, HKLM\SOFTWARE\AGMessage's Version.
REM reg.exe by its absolute path: cmd looks for a bare name in this folder before anywhere else. /reg:64 reads the 64-bit
REM view, where the record is written, also when this window is a 32-bit cmd (whose reads would go to WOW6432Node).
set "INSTALLED="
for /f "tokens=1,2,*" %%a in ('call "%SystemRoot%\System32\reg.exe" query HKLM\SOFTWARE\AGMessage /v Version /reg:64 2^>nul') do if /i "%%a"=="Version" (
  set "INSTALLED=1"
  echo   AGMessage %%c is installed on this PC and starts with Windows.
  echo   This window starts a separate portable copy.
  echo.
)

REM The preflight: what this copy needs beside this file, checked before anything is opened or started. A missing one is
REM named with its likely cause, and the window ends with a code of its own (2), so cmd's own "path not found" (3) never
REM reads as AGMessage's "cannot start as configured" (3).
set "MISSING="
if not exist "%~dp0node\node.exe" set "MISSING=node\node.exe"
if not defined MISSING if not exist "%~dp0app\supervise.js" set "MISSING=app\supervise.js"
if not defined MISSING if not exist "%~dp0app\server.js" set "MISSING=app\server.js"
if not defined MISSING if not exist "%~dp0app\node_modules\" set "MISSING=app\node_modules"
if defined MISSING goto missing

echo   Keep this window open while the meeting runs.
echo   Press Ctrl+C to stop the server when you're done.
echo.
echo   Your browser opens on this copy once it is serving.
echo   Share the LAN URL below with your team so they can
echo   join from their phones, tablets, or laptops.
echo.

REM Node runs from this folder's own runtime. PORT can be overridden.
REM The watchdog (app\supervise.js) runs the server and restarts it if it crashes or stops responding
REM (heartbeat), backing off 2-30 s; rooms, history and everyone's place come back from the saved log.
REM It gives up after 6 crashes in 10 minutes and says why on the admin page. Ctrl+C stops it for good.
REM AGM_OPEN asks the server to open the browser once it serves, so the page that opens is this copy's and never whatever
REM else answers on the port. Only this window's first run asks: a run after the loop below restarts it opens nothing.
REM This loop is the last line of defence, should the watchdog itself ever stop.
if "%PORT%"=="" set PORT=3023
set AGM_OPEN=1
:run
"%~dp0node\node.exe" "%~dp0app\supervise.js"
set CODE=%ERRORLEVEL%
set AGM_OPEN=
if "%CODE%"=="0" goto stopped
if "%CODE%"=="3" goto notstarted
echo.
echo   AGMessage stopped unexpectedly (code %CODE%) - restarting in 2 seconds...
"%SystemRoot%\System32\timeout.exe" /t 2 /nobreak >nul
goto run

REM Code 0: stopped on purpose. Code 3: the server or the watchdog said why it cannot run, just above.
:stopped
echo.
echo   Server stopped. Press any key to close this window.
pause >nul
exit /b 0

:notstarted
echo.
echo   AGMessage did not start - the reason is above. Press any key to close this window.
pause >nul
exit /b 3

:missing
set "FROMZIP="
if defined TEMP for %%T in ("%TEMP%\.") do for %%H in ("%~dp0.") do (
  call :under "%%~fH" "%%~fT"
  call :under "%%~sH" "%%~sT"
)
echo.
if defined FROMZIP goto fromzip
echo   This copy is missing %MISSING%.
echo   Download the portable zip again and Extract All.
echo   If it keeps going missing, your antivirus may be removing it.
goto missingend
:fromzip
echo   AGMessage was started from inside the zip.
echo   Close this window, right-click the zip, choose Extract All,
echo   and run start-agmessage.bat from the extracted folder.
:missingend
if defined INSTALLED echo   To use the installed AGMessage: Start -^> AGMessage -^> Open AGMessage.
echo.
echo   Press any key to close this window.
pause >nul
exit /b 2

REM Sets FROMZIP when the folder %1 is the folder %2 or inside it; both are full paths, compared without regard to case.
REM Explorer runs a .bat opened inside a zip from a folder under %TEMP%, with nothing of the zip beside it. Called with the
REM long names and again with the short ones, since %TEMP% is often given in the short form.
:under
set "U_PATH=%~1\"
set "U_ROOT=%~2\"
call set "U_TAIL=%%U_PATH:*%U_ROOT%=%%"
if /i "%U_ROOT%%U_TAIL%"=="%U_PATH%" set "FROMZIP=1"
exit /b 0
