# Loooop — Bug fixes, terminal upgrade, auto-label, and memory pass

Date: 2026-07-22
Status: Approved (design)

## Scope

This round delivers, in order:

1. Fix: tray status stuck on "Stopped" while a CLI-wrapper session is working.
2. Fix: garbled terminal text on window resize (and the unbounded-memory leak behind it).
3. Enhancement: auto-title and auto-color each project terminal tab.
4. Final memory-optimization pass.

Deferred to a later round (explicitly out of scope): full settings GUI window,
launch-at-startup / start-minimized, request analysis / auto-approval.

## Context

Two entry points share `src/claude-monitor.js` (pure detection helpers):

- `src/main.js` — Electron tray supervisor. Runs Claude in an **embedded** node-pty
  and renders it in a BrowserWindow (`terminal.html`). Tray status comes only from
  this embedded terminal's `currentState`.
- `src/loooop-cli.js` — the **recommended** path. Launched in a separate Windows
  Terminal process via `startProjectTerminal` (wt.exe). Supervises Claude in the
  user's real terminal and publishes state to `%APPDATA%/loooop/state.json`.

The tray never reads the CLI's state file, and the embedded terminal is idle in the
recommended workflow — so the tray sits on "Stopped" while Claude is working.

## 1. Cross-process state sync (Bug: tray stuck on "Stopped")

### Problem
`main.js` derives tray status solely from its embedded pty. The CLI wrapper's
published state (`state.json`) is ignored. A single shared `state.json` also means
multiple project wrappers clobber each other's state.

### Design
- **Per-project session files.** `loooop-cli.js` publishes to
  `%APPDATA%/loooop/sessions/<key>.json`, where `<key>` is a stable hash of the
  absolute `projectDir` (see `sessionKey` helper). Payload:
  `{ state, projectDir, pid, updatedAt, resetAt?, attempt?, ... }`.
  On clean exit (`stopped`), the wrapper deletes its own session file.
- **Shared vocabulary.** Introduce one canonical, lowercase state set used by both
  entry points and by the aggregate: `starting | running | confirming-wait |
  waiting | retrying | resuming | stalled | stopped`. The tray formats these for
  display (title-cased) rather than storing capitalized strings.
- **Tray watches the directory.** `main.js` uses a debounced `fs.watch` on
  `sessions/` (fallback to a low-frequency interval if watch is unavailable). On
  change it reads all session files, **prunes stale entries** (process not alive via
  `process.kill(pid, 0)`, or `updatedAt` older than `SESSION_STALE_MS`), and removes
  their files.
- **Aggregate status.** A pure `aggregateStatus(embeddedState, sessions[])` helper
  computes what the tray shows, by priority so the most actionable state wins
  (e.g. `waiting`/`retrying`/`stalled` outrank `running`, which outranks `stopped`).
  Tooltip shows the winning state plus project name and, for `waiting`, the live
  countdown; when multiple sessions are active it appends `· N sessions`.

### Units / interfaces
- `sessionKey(projectDir) -> string` (pure) — stable filesystem-safe key.
- `normalizeState(raw) -> canonicalState` (pure).
- `aggregateStatus(embedded, sessions) -> { state, label, projectName, count }` (pure).
- These live in `claude-monitor.js` (or a new small `session-state.js`) and are
  unit-tested. Directory watching / pruning / IPC stay in `main.js` (manual verify).

## 2. xterm.js terminal (Bug: garbled resize + memory leak)

### Problem
`terminal.html` appends raw PTY bytes to a `<div>` via `textContent +=`: it ignores
ANSI escapes, never resizes the PTY (locked at 120×36), and grows without bound.

### Design
- Replace the div with **xterm.js** + **@xterm/addon-fit**, loaded from local files
  (vendored or referenced from `node_modules`; no network — CSP-safe, offline-safe).
- `scrollback` capped at ~1000 lines → bounded memory (fixes the leak).
- On load and on window `resize`, the renderer runs `fitAddon.fit()` and sends the
  resulting `{ cols, rows }` over a new `terminal-resize` IPC channel.
- `main.js` handles `terminal-resize` by calling `terminal.resize(cols, rows)` on the
  pty so display and PTY stay in sync. Guarded against no-op / no-terminal.
- Keyboard input keeps flowing through the existing `terminal-input` channel; xterm's
  `onData` replaces the ad-hoc keydown handler for correct key encoding.
- Bonus (recommended path): `loooop-cli.js` listens for `process.stdout` `'resize'`
  and calls `child.resize(process.stdout.columns, process.stdout.rows)`.

### Dependencies
Add `@xterm/xterm` and `@xterm/addon-fit`. Renderer loads their UMD/ESM build +
`xterm.css` locally. No bundler is introduced.

## 3. Auto title + color per project terminal

### Design
`startProjectTerminal(projectDir)` passes Windows Terminal native flags:
`wt.exe -d <dir> --title "<projectName>" --tabColor "#rrggbb" cmd /k node <wrapper>`.
- `projectName = path.basename(projectDir)`.
- Color derived deterministically: `projectColor(name) -> "#rrggbb"` (pure) — hash the
  name to a hue, fixed saturation/lightness, so the same project is always the same
  color. Unit-tested for stability and valid hex.
- The `cmd.exe` fallback (when `wt.exe` is absent) sets the console title via
  `title <projectName>` and skips color (not supported there).

Note: `/color` and `/rename` are not standard Claude Code slash-commands; Windows
Terminal's `--title`/`--tabColor` are the robust equivalent and require no Claude
support. `projectColor` is unit-tested.

## 4. Memory-optimization pass

Applied last, measured where it matters:

- **Single-instance lock** (`app.requestSingleInstanceLock()`): prevents duplicate
  tray processes; second launch focuses/no-ops.
- **Bounded terminal scrollback** (from §2) removes the primary leak.
- **Lazy, disposable terminal window**: confirm it is created on demand and fully
  released on close (null the reference — already done; verify no listeners retained).
- **Debounced watching**: no busy polling; coalesce rapid `fs.watch` events.
- **Bounded buffers**: `lastOutput`/`outputBuffer` already capped (12k/24k) — keep.
- **Electron/V8 trims** (measured, reverted if they hurt UX): evaluate
  `backgroundThrottling`, disabling unused Chromium features, and a modest
  `--max-old-space-size`. Only keep changes that measurably lower RSS without
  breaking rendering.

Success criterion: the terminal window's memory no longer grows with session length,
and idle tray RSS is measured before/after with the applied trims documented.

## Testing

- Pure helpers unit-tested with `node --test` (matching `tests/claude-monitor.test.js`):
  `sessionKey`, `normalizeState`, `aggregateStatus`, `projectColor`.
- IPC wiring, xterm rendering, resize forwarding, wt.exe flags, and directory
  watching are verified manually in the running app (documented steps).

## Risks / notes

- `fs.watch` reliability varies on Windows; interval fallback covers it.
- Cross-process liveness via `process.kill(pid, 0)` is best-effort; staleness age is
  the backstop.
- Vendoring xterm vs. referencing `node_modules` affects future packaging; either is
  fine now (no electron-builder yet).
