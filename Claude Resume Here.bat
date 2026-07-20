@echo off
setlocal
set "CLAUDE_RESUME_ROOT=%~dp0"
node "%CLAUDE_RESUME_ROOT%src\claude-resume-cli.js" %*
