@echo off
REM Makes a copy of this AGMessage bundle that is safe to give away: no hall history (app\data), no shared files
REM (app\uploads), no saved keys or settings.
REM Each copy is a new folder beside this one, named with the time (and numbered when a copy was made in the same minute):
REM a folder that already exists is never copied into, so nothing left in an earlier copy (one that was started to test
REM it holds accounts, keys and an audit log) is merged into this one. The copy is checked before "Done": anything under
REM its app\data or app\uploads but the empty folders and .gitkeep, and the copy is deleted instead.
setlocal
cd /d "%~dp0"
for %%P in ("%~dp0..") do set "PARENT=%%~fP"

REM The time from PowerShell, by its absolute path: the same digits whatever the language and date format of this PC.
set "STAMP="
for /f "delims=" %%t in ('call "%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -Command "Get-Date -Format yyyyMMdd-HHmm" 2^>nul') do set "STAMP=%%t"
REM Only digits and the dash are taken: anything else PowerShell printed (a policy's warning) leaves the copy undated.
if not defined STAMP set "STAMP=undated"
for /f "delims=0123456789-" %%x in ("%STAMP%") do set "STAMP=undated"
set "NAME=AGMessage-Portable-clean-%STAMP%"
set "DEST=%PARENT%\%NAME%"
set N=1
:name
if not exist "%DEST%" goto named
set /a N+=1
if %N% gtr 99 goto taken
set "DEST=%PARENT%\%NAME%-%N%"
goto name
:taken
echo.
echo   Not copied: %NAME% and its numbered copies up to -99 already exist.
echo   Move or delete the old copies, then run this again.
echo.
pause
exit /b 1

:named
echo.
echo   Making a clean copy at:
for %%D in ("%DEST%") do echo     %%~fD
echo.
"%SystemRoot%\System32\robocopy.exe" "%~dp0." "%DEST%" /E /XD "%~dp0app\data" "%~dp0app\uploads" /NFL /NDL /NJH /NJS /NP >nul
if errorlevel 8 goto failed
mkdir "%DEST%\app\data\rooms" 2>nul
mkdir "%DEST%\app\uploads" 2>nul
type nul > "%DEST%\app\uploads\.gitkeep"

set "DIRTY="
for %%d in (data uploads) do for /f "delims=" %%f in ('dir /s /b /a-d "%DEST%\app\%%d" 2^>nul') do if /i not "%%~nxf"==".gitkeep" set "DIRTY=1"
if defined DIRTY goto dirty
echo   Done. The copy has no hall history, files, keys or settings.
echo.
pause
exit /b 0

:failed
rmdir /s /q "%DEST%" 2>nul
echo   Copy failed, and the part copied was deleted. Nothing was handed on.
echo.
pause
exit /b 1

:dirty
rmdir /s /q "%DEST%"
echo   Not copied: the copy held files under app\data or app\uploads, so it was deleted.
echo   Nothing was handed on.
echo.
pause
exit /b 1
