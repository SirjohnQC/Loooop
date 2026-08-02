# Loooop — Settings window, Windows integration, and token tracking

Date: 2026-08-02
Status: Approved (design)

## Scope

1. A settings GUI window: favourite projects, timing thresholds, Windows
   integration, notifications.
2. A settings file (`settings.json`) shared by both entry points, replacing the
   hardcoded timing constants and absorbing `favorite-projects.json`.
3. Per-session token tracking, read from Claude Code's own transcripts, feeding a
   configurable threshold notification.

Out of scope: auto-answering stuck prompts, the Gemini-driven decision agent, and
anything that requires knowing how much of the *subscription* limit remains (see
Constraints).

## Context

Two processes share `src/claude-monitor.js` and `src/session-state.js`:

- `src/main.js` — Electron tray. Owns the tray menu, notifications, the xterm
  window, and an embedded node-pty session.
- `src/loooop-cli.js` — the recommended path. Launched detached inside a Windows
  Terminal tab per project (`startProjectTerminal` → `wt.exe`). Publishes state to
  `%APPDATA%\loooop\sessions\<key>.json`; the tray watches that directory.

There is no settings file today. `favorite-projects.json` (a bare array of paths)
is the only persisted configuration. Every other tunable is a module constant:
`LIMIT_POLL_MS` (15 min), `BACKOFF_MS` `[30s, 2m, 5m]`, `STALL_RESET_MS` (5 min),
`SESSION_STALE_MS`.

### Constraints established while designing this

Investigated on 2026-08-02, and the reason the token feature is shaped the way it
is rather than as a "% of limit remaining" gauge:

- **No rate-limit or reset state is persisted anywhere.** Searching all of
  `~/.claude` for `resetsAt`, `unified_rate_limit`, `five_hour`, `seven_day`,
  `utilization` returns nothing.
- **`stats-cache.json` holds only** `messageCount` / `sessionCount` /
  `toolCallCount` per day. No tokens, no limits.
- **There is no `claude usage` subcommand.** `/usage` exists only inside the TUI,
  so a supervisor cannot invoke it non-interactively.
- **The `anthropic-ratelimit-*` and `retry-after` HTTP headers are unreachable.**
  Loooop supervises the `claude` binary as a subprocess and never sees the HTTP
  layer.
- **Claude cannot be asked for its own usage.** `message.usage` is a field on the
  API response object returned to the caller; the model never sees it.

So the reset time Claude prints to the terminal remains the most authoritative
signal available, and `planLimitWait` already parses it. Token tracking is a
*consumption trend*, not a fuel gauge, and the UI must not imply otherwise.

## 1. Settings storage

### `settings.json` (in `app.getPath('userData')`)

```json
{
  "version": 1,
  "projects": [{ "path": "C:\\Users\\...\\Loooop", "color": null, "label": null }],
  "timing": {
    "limitPollMinutes": 15,
    "backoffSeconds": [30, 120, 300],
    "stallResetMinutes": 5
  },
  "windows": {
    "launchAtLogin": false,
    "startMinimized": false,
    "openProjectTabsUnfocused": false
  },
  "notifications": {
    "recoveryFailed": true,
    "limitHit": false,
    "sessionResumed": false,
    "tokenThreshold": { "enabled": false, "burnTokens": 500000 }
  }
}
```

Projects are objects rather than bare strings so a project can override its
auto-assigned tab colour and display name. `projectColor()` in `session-state.js`
stays the default when `color` is null; `label` overrides `path.basename()`
everywhere a project is named — the tray submenu, the `wt.exe --title`, and the
tray status line — and falls back to the basename when null.

`windows.startMinimized` means: when Loooop is launched at login, create the tray
icon only and open no window. It has no effect on a manual launch, and it does not
suppress the xterm window that `startClaude()` opens on demand.

### New pure module `src/settings.js`

Mirrors `session-state.js`: no Electron import, no I/O policy baked in, directly
testable under `node --test`.

| Export | Behaviour |
|---|---|
| `DEFAULTS` | The object above |
| `validate(raw)` | **Total** — never throws. Clamps and falls back **per field**, so one bad value cannot discard the rest |
| `load(dir)` | Read + `validate`. Missing/corrupt file returns `DEFAULTS` |
| `save(dir, settings)` | `validate`, write temp file, rename over the target |
| `migrateFavorites(dir)` | One-time `favorite-projects.json` → `projects[]` |

Both processes read settings only through `load()`.

Rejected alternatives: keeping favourites in a separate file (two config files for
the UI to edit, and favourites is the part getting the most UI work);
`electron-store` (Electron-coupled, so `loooop-cli.js` — a plain node process —
could not read timing values from it).

## 2. Settings window

`src/settings.html`, self-contained, following the `terminal.html` convention. A
separate `src/settings-preload.js` — **not** the existing `preload.js`, which
exposes `write()` straight into the PTY.

Tray gains one item, `Settings…`. Opening focuses the existing window rather than
spawning a second.

IPC uses `handle`/`invoke`, not `send` — settings are request/response, unlike the
terminal's one-way stream:

| Channel | Purpose |
|---|---|
| `settings:get` | Current validated settings |
| `settings:save` | Validate, persist, apply, **return what was persisted** |
| `settings:pick-folder` | Native folder dialog; path or null |

`settings:save` returning the persisted state means a clamped value re-renders in
the UI instead of silently disagreeing with disk.

### Apply semantics

Deliberately one rule for both processes: **timing is read at session start.**

- **Immediately:** favourites (tray menu rebuild); `launchAtLogin`
  (`app.setLoginItemSettings` — a system-level change, deferring it would be
  surprising); `openProjectTabsUnfocused` (read per launch anyway).
- **Next session start:** all timing values. Wrappers read at spawn; the tray
  re-reads inside `startClaude()`.
- **At fire time:** notification toggles. The tray reads them when it is about to
  raise a toast, so turning one off silences it immediately — including for
  sessions already running.

A running session therefore keeps the values it started with. This is intentional:
live reload would need a watcher per session plus a decision about what happens to
an already-armed timer.

### Constants become arguments

`createStallTracker(backoffMs)` and `planLimitWait(text, pollMs)` take their
tunables as parameters, defaulting to today's values so the existing 32 tests pass
untouched.

## 3. Token tracking

### Source

Claude Code writes each assistant message — including the API response's `usage`
object verbatim — to `~/.claude/projects/<slug>/<session-uuid>.jsonl`:

```json
"usage":{"input_tokens":2,"cache_creation_input_tokens":10962,
         "cache_read_input_tokens":17964,"output_tokens":514}
```

This is the same data `message.usage` carries, obtained without spending a token
or involving the model.

### Flow — no new watcher in the tray

```
~/.claude/projects/<slug>/<session>.jsonl   (written by claude)
            │ tail from byte offset
            ▼
      loooop-cli.js  ──writes──▶  %APPDATA%\loooop\sessions\<key>.json
                                          │  { …, usage: {…} }
                                          │ existing fs.watch
                                          ▼
                                      main.js  → tray label + threshold toast
```

The wrapper holds a module-level `usage` object that `publish()` spreads into
every write, so usage rides existing state transitions rather than adding a
separate write path.

### New pure module `src/usage-tracker.js`

`parseUsageLine(line)`, `addUsage(a, b)`, `burnTotal(usage)`,
`transcriptDirName(projectPath)`. No I/O, no timers.

### The metric

`burnTotal = input_tokens + cache_creation_input_tokens + output_tokens`.

`cache_read_input_tokens` is **excluded** — it bills at roughly 0.1× and dominates
the raw numbers (17,964 against 514 output in the sample above), so including it
produces a figure driven almost entirely by the cheapest component.

All four fields are stored separately in the session file regardless, so changing
the displayed metric later is a one-line change rather than a rewrite.

**Known limitation, deliberately accepted:** `usage` is per-request, and every
turn resends the conversation, so the input-side fields re-count earlier turns.
`output_tokens` is the only field that accumulates cleanly. The burn total is a
comparative signal ("this session is climbing fast"), not an absolute measure of
tokens sent. The UI must not present it as a percentage of anything.

### Resolving the transcript

Two details that will otherwise silently break it:

1. **Directory lookup is case-insensitive.** The slug is the cwd with `:`, `\` and
   `/` replaced by `-`, but observed drive-letter case is inconsistent —
   `C--Users-Sirjohn-Documents-Loooop` and
   `c--Users-Sirjohn-Documents-Eternal-System` coexist. A computed exact match
   finds nothing and the feature appears dead with no error.
2. **The wrapper never learns Claude's session UUID** (it spawns `claude` as a PTY
   child). It tails the most-recently-modified `.jsonl` in the slug directory,
   re-selecting when a newer file appears — which is what `--continue` produces.

### Threshold notification

Fires in the tray, next to the existing `Notification.isSupported()` call, and
latches once per session per crossing. The latch clears when the session file
disappears.

## 4. Error handling

- **Corrupt `settings.json`** — `validate()` degrades per field, so a hand-edited
  typo in `timing` cannot wipe `projects`. Writes go temp-file-then-rename, so a
  crash mid-write cannot leave a truncated config.
- **Migration** — `favorite-projects.json` is read once and **left in place, not
  deleted**; a rollback is then non-destructive.
- **Partial JSONL lines** — we tail a file being actively appended, so a read can
  land mid-line. The tail buffers any trailing incomplete line and prepends it to
  the next read. Without this, nearly every read raises a parse error.
- **`launchAtLogin` silently failing** — `setLoginItemSettings` can no-op on
  Windows. The UI renders `getLoginItemSettings()` read back from the OS, not the
  value just written.

Missing transcript directory, no `.jsonl` yet, or a project never opened in Claude
Code are **normal**: `usage` is absent from the session file and the tray shows
nothing.

## 5. Testing

Unit-tested under `node --test`, no Electron:

- `settings.js` — each field clamps independently; corrupt input degrades rather
  than throwing; migration is idempotent.
- `usage-tracker.js` — line parsing; summing; `burnTotal` excludes cache reads;
  case-insensitive slug resolution; **partial-line buffering specifically**.

The 32 existing tests must pass untouched.

Not unit-testable, added to the manual-verify list alongside the two outstanding
`BUG.md` items: the settings window itself, `launchAtLogin`, and
`openProjectTabsUnfocused`.

## 6. Open risk

`openProjectTabsUnfocused` has no clean mechanism. `wt.exe` has no
background/minimized flag; the workable trick is `cmd /c start /min wt.exe …`, but
`wt.exe` is a stub that hands off to `WindowsTerminal.exe`, so `/min` may not
propagate. **Verify during implementation.** If it does not work, the setting is
dropped rather than shipped as a no-op toggle.
