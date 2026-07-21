@echo off
setlocal
set "LOOOOP_ROOT=%~dp0"
node "%LOOOOP_ROOT%src\loooop-cli.js" %*
