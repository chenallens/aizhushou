@echo off
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0manage-service.ps1" -Action restart
pause
endlocal
