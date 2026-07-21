@echo off
setlocal
cd /d "%~dp0"

if not exist "node_modules\electron\package.json" (
  echo Installing Loooop dependencies. This only happens the first time.
  call npm.cmd install
  if errorlevel 1 (
    echo.
    echo Installation failed. Make sure Node.js is installed, then try again.
    pause
    exit /b 1
  )
)

call npm.cmd start
