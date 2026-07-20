# Claude Resume

Claude Resume is a Windows tray supervisor for Claude Code. This first MVP launches Claude Code in a pseudo-terminal, detects common rate-limit messages, waits until the displayed reset time, and resumes the most recent session with `claude --continue`.

## Requirements

- Windows
- Node.js 20 or newer
- Claude Code installed and available as `claude` in PowerShell

## Run

```powershell
cd <this-folder>
npm install
npm start
```

## Use it in Windows Terminal (recommended)

Claude Resume cannot attach to an already-running terminal session. To use your usual Windows Terminal in a project, start Claude through the wrapper instead of running `claude` directly:

```powershell
& 'C:\Users\Sirjohn\Documents\Claude Resume\Claude Resume Here.bat'
```

Run that command while your terminal is already in the project folder. The wrapper automatically confirms Claude Code's **Stop and wait for limit to reset** option, waits for the reset time Claude displays, then resumes that project's most recent Claude session.

Use `CLAUDE_RESUME_PROJECT` to choose the project directory:

```powershell
$env:CLAUDE_RESUME_PROJECT = 'C:\path\to\your\project'
npm start
```

## Current scope

The MVP handles rate-limit waiting and session continuation. It does not yet auto-approve permission requests. That should be added using explicit allowlists for safe commands and project-local file access, with an emergency stop.

The activity log is stored in Electron's user-data directory as `claude-resume.log`.
