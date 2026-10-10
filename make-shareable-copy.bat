@echo off
REM Makes a copy of this AGMessage bundle that is safe to give away: no meeting history
REM (app\data), no shared files (app\uploads), no saved keys or settings.
setlocal
cd /d "%~dp0"
set DEST=%~dp0..\AGMessage-Portable-Windows-clean
echo.
echo   Making a clean copy at:
echo     %DEST%
echo.
robocopy "%~dp0." "%DEST%" /E /XD "%~dp0app\data" "%~dp0app\uploads" /NFL /NDL /NJH /NJS /NP >nul
if errorlevel 8 (
  echo   Copy failed.
  pause
  exit /b 1
)
mkdir "%DEST%\app\data\rooms" 2>nul
mkdir "%DEST%\app\uploads" 2>nul
type nul > "%DEST%\app\uploads\.gitkeep"
echo   Done. The copy has no meeting history, files, keys or settings.
echo.
pause
