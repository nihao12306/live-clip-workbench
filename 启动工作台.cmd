@echo off
setlocal
set "ROOT=%~dp0"

rem Prefer the newest unpacked build when it exists (useful for internal testing).
for /f "delims=" %%F in ('dir /b /a-d "%ROOT%release\win-unpacked\*.exe" 2^>nul ^| findstr /v /i "unins uninstall"') do if not defined APP set "APP=%ROOT%release\win-unpacked\%%F"
for /f "delims=" %%F in ('dir /b /a-d "%ROOT%release\portable\win-unpacked\*.exe" 2^>nul ^| findstr /v /i "unins uninstall"') do if not defined APP set "APP=%ROOT%release\portable\win-unpacked\%%F"
if defined APP (
  start "" "%APP%"
  exit /b 0
)

rem Otherwise open the newest generated installer; the version is not hard-coded.
for /f "delims=" %%F in ('dir /b /a-d /o:-n "%ROOT%release\live-clip-workbench-*-win-x64.exe" 2^>nul') do if not defined INSTALLER set "INSTALLER=%ROOT%release\%%F"
if defined INSTALLER (
  start "" "%INSTALLER%"
  exit /b 0
)

echo No workbench build was found. Run npm.cmd run dist -- --win first.
pause
