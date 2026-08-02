# Bugs

## Fixed
- [FIXED 2026-08-02] Doesn't resume on a usage message it doesn't recognise
  ("You've hit your monthly spend limit")
  - Two faults: neither detector matched "spend limit" (or "weekly limit"), and
    the notice carries no reset time so there was nothing to count down to.
  - `planLimitWait()` now recognises spend/weekly limits and returns either a
    real reset time or a 15-minute poll. Poll mode retries the session every
    15 min until it goes through, and upgrades itself to a real countdown if a
    reset time shows up in a later chunk.
  - Verified end-to-end against a stand-in `claude` emitting the exact message:
    session publishes `waiting` + `limitMode: poll`, and upgrades to `reset`
    when a time arrives late.
- [FIXED 2026-08-02] Got stuck on the "No completion record was found…" +
  spend-limit message instead of Loooping
  - Same root cause as above: the spend-limit line was never detected, so no
    wait was ever armed.
- [FIXED 2026-07-27] Status of claude in the tray is stuck on stopped even when it is working
  - The tray now watches per-project session files the CLI wrapper publishes
    (`%APPDATA%\loooop\sessions\`) and shows an aggregate status.
- [FIXED 2026-07-27] Text is messed up when resizing the window of the terminal
  - Terminal window rebuilt on xterm.js; window size is forwarded to the PTY
    (and re-synced after each spawn), so wrapping stays in sync on resize.

## Fixed — needs a real-world confirmation
- [2026-08-02] Tab not renaming itself after the project name
  - Root cause: `cmd /k` and Claude Code both rewrite the console title, and
    Windows Terminal honours that over `--title`. Added
    `--suppressApplicationTitle` to the `wt.exe` invocation (supported since WT
    1.9; 1.24 installed). Open a favourite project to confirm the tab keeps the
    project name.
- [2026-08-02] Can't type in the chat field after ending a convo and starting a
  new one in the same terminal window
  - Root cause candidate: the wrapper puts stdin in raw mode and no exit path
    restored it, so the next program in that window inherits a console with line
    input and echo switched off. `process.on('exit')` now restores it.
  - Not reproducible from an automated shell (no console attached to measure
    console mode), so this one needs you to hit the sequence again. If it still
    happens, the next suspect is Claude's DEC private modes (bracketed paste /
    mouse tracking) left set when the session is killed rather than exited.

## Open
(none)
