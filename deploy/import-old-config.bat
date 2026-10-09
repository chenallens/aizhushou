@echo off
setlocal
echo Example old configuration: D:\nginx-1.23.2-old\app\aizhushou\.env
set /p "OLD_ENV=Enter the full path to the OLD server .env: "
set "OLD_ENV=%OLD_ENV:"=%"
"%~dp0app\aizhushou\runtime\node.exe" "%~dp0app\aizhushou\deploy\import-env.cjs" "%OLD_ENV%"
pause
endlocal
