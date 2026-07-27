# Bugs

## Fixed
- [FIXED 2026-07-27] Status of claude in the tray is stuck on stopped even when it is working
  - The tray now watches per-project session files the CLI wrapper publishes
    (`%APPDATA%\loooop\sessions\`) and shows an aggregate status.
- [FIXED 2026-07-27] Text is messed up when resizing the window of the terminal
  - Terminal window rebuilt on xterm.js; window size is forwarded to the PTY
    (and re-synced after each spawn), so wrapping stays in sync on resize.

## Open
(none)
