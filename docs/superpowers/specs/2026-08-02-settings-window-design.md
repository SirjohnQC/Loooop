# Loooop — Settings file and settings window

Date: 2026-08-02
Status: Approved (design)
Supersedes: the combined settings + token-tracking draft of the same date.
Token tracking moved to `2026-08-02-token-tracking-problem.md` after review found
four independent defects in its design; it needs its own design pass.

## Scope

Two phases, in order:

1. **`settings.json`** — a shared cross-process config replacing the hardcoded
   timing constants and absorbing `favorite-projects.json`. Pure, unit-testable,
   no UI.
2. **The settings window** — an Electron BrowserWindow editing that file.

Out of scope: token tracking (own spec), auto-answering stuck prompts, the
Gemini-driven decision agent.

## Context

Two processes share `src/claude-monitor.js` and `src/session-state.js`:

- `src/main.js` — Electron tray. Owns the tray menu, notifications, the xterm
  window, and an embedded node-pty session.
- `src/loooop-cli.js` — the recommended path. Launched detached inside a Windows
  Terminal tab per project. Publishes state to
  `%APPDATA%\loooop\sessions\<key>.json`; the tray watches that directory.

There is no settings file today. `favorite-projects.json` (a bare array of paths)
is the only persisted configuration. Timing lives in module constants:
`LIMIT_POLL_MS` (15 min), `BACKOFF_MS` `[30s, 2m, 5m]`, `STALL_RESET_MS` (5 min).

`SESSION_STALE_MS` is deliberately **not** exposed — it is a tray-internal prune
fallback for pid-less session files, not a user-facing tunable.

## 1. Settings storage

### `settings.json`

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
    "openProjectTabsUnfocused": false
  },
  "notifications": {
    "recoveryFailed": true,
    "limitHit": false,
    "sessionResumed": false
  }
}
```

`windows.startMinimized` was cut: `app.whenReady()` (`main.js:446`) already creates
only a tray and no window, and the setting was specified not to suppress the xterm
window either. There is no state in which it changes behaviour.

### Where the file lives

Both processes must resolve the **same** directory. Today the tray uses
`app.getPath('userData')` while `loooop-cli.js` hardcodes
`process.env.APPDATA || process.env.LOCALAPPDATA || projectDir` (line 16) — they
coincide only by accident, and the wrapper's last fallback can land in the project
directory.

**`src/paths.js`** (new, no Electron import) exports `userDataDir()`, and the tray
additionally stamps its resolved path into `LOOOOP_USER_DATA` on the `wt.exe`
spawn it already controls. The wrapper prefers the env var, falls back to
`userDataDir()`. Without this, a packaged build or a `--user-data-dir` flag leaves
the wrapper silently reading `DEFAULTS` forever.

### `src/settings.js`

Mirrors `session-state.js`: no Electron import, directly testable under
`node --test`.

| Export | Behaviour |
|---|---|
| `DEFAULTS` | The object above |
| `validate(raw)` | **Total** — never throws. Clamps **per field** (bounds below) |
| `load(dir)` | Read + `validate`. Missing/corrupt returns `DEFAULTS` |
| `save(dir, settings)` | `validate`, write temp file in the same directory, rename over target, bounded retry on `EPERM`/`EBUSY` (Windows: AV and the search indexer can hold the target) |
| `migrateFavorites(dir)` | See below |

### Clamps

`validate()` was previously described as clamping without stating a single bound.
Unbounded values are not cosmetic: `backoffSeconds: []` makes `onStall()` return
`give-up` on the first stall, and `limitPollMinutes: 0` produces a hot resume loop.

| Field | Bound | On violation |
|---|---|---|
| `limitPollMinutes` | 1–240 | Clamp |
| `backoffSeconds` | 1–6 entries, each 5–3600, ascending | Clamp entries; empty or non-array → default |
| `stallResetMinutes` | 1–120 | Clamp |
| `projects[].path` | Non-empty string that `fs.existsSync` | Drop the entry |
| `projects[].color` | `/^#[0-9a-f]{6}$/i` or null | → null |
| `projects[].label` | Non-empty string ≤ 64 chars, or null | → null |
| booleans | Actual boolean | → default |

### Migration

Run `migrateFavorites` **only when `settings.json` does not exist.** A
merge-missing-entries migration would resurrect a project removed in the new UI,
because `favorite-projects.json` is deliberately left on disk.

`saveFavoriteProjects()` (`main.js:259`) is **deleted** in the same change — left
in place the tray keeps writing the legacy file and the two diverge.

### Constants become arguments

- `createStallTracker(backoffMs)` and `planLimitWait(text, pollMs)` take their
  tunables as parameters, defaulting to today's values. Verified: every call site
  (`main.js:34, 61`; `loooop-cli.js:27, 160`) passes no extra argument, and the
  32 existing tests pass provided `LIMIT_POLL_MS` and `BACKOFF_MS` stay exported
  with their current values as defaults.
- **`STALL_RESET_MS` is not a helper parameter** — it is used at the call site in
  both files (`main.js:182`, `loooop-cli.js:145`), so those two sites read
  `stallResetMinutes` directly. "Constants become arguments" does not cover it.
- **`const stallTracker` at `main.js:34` is module-level.** The tray is long-lived
  and starts many sessions, so it must become `let` and be **re-created inside
  `startClaude()`**. Miss this and `backoffSeconds` silently never applies in the
  tray while appearing to work in the wrapper (one process per session).
- **`` `Retry ${n} of 3` `` is hardcoded** (`loooop-cli.js:127`). With configurable
  backoff it becomes `of ${backoffSeconds.length}`.

### Apply semantics

One rule per category, deliberately:

- **Immediately:** favourites (tray menu rebuild); `launchAtLogin`
  (`setLoginItemSettings` — a system-level change); `openProjectTabsUnfocused`
  (read per launch anyway).
- **At fire time:** notification toggles. The tray reads them when about to raise a
  toast, so turning one off silences it immediately, including for running
  sessions.
- **Next session start:** all timing. Wrappers read at spawn; the tray re-reads
  inside `startClaude()`.

A running session keeps the timing it started with. Live reload would need a
watcher per session plus a decision about already-armed timers.

### `label` and `color` delivery

`aggregateStatus()` derives the tray status name as
`sess.projectName || path.basename(sess.projectDir)` (`session-state.js:76`), but
`publish()` never writes `projectName`, and `session-state.js` is pure by design.

- The **wrapper** reads `projects[].label` at spawn and includes `projectName` in
  its `publish()` payload. This is the one non-timing setting a wrapper reads.
- `startProjectTerminal()` seeds `projectColor()` from **`projectDir`, not the
  display name** (currently `projectColor(projectName)`, `main.js:267`). Otherwise
  setting a `label` silently changes the auto-assigned tab colour — the opposite of
  what a per-project colour override is for.
- An explicit `projects[].color` overrides `projectColor()` entirely.

## 2. Settings window

`src/settings.html`, self-contained, following the `terminal.html` convention, with
a separate **`src/settings-preload.js`**. Not the existing `preload.js` — that
exposes `write()` straight into the PTY, which would hand the settings renderer a
keystroke-injection channel into a live Claude session.

Tray gains `Settings…`; opening focuses the existing window rather than spawning a
second.

### IPC

`handle`/`invoke`, not `send` — settings are request/response, unlike the
terminal's one-way stream.

| Channel | Direction | Purpose |
|---|---|---|
| `settings:get` | invoke → | Current validated settings |
| `settings:save` | invoke → | Validate, persist, apply, **return what was persisted** |
| `settings:pick-folder` | invoke → | Native folder dialog; path or null |
| `settings:changed` | ← push | Tray-side mutation occurred; re-render |

`settings:save` returning the persisted object means a clamped value re-renders
instead of silently disagreeing with disk.

### Interaction model

- **Explicit Save.** Edits are local to the renderer until saved; the window shows
  a dirty indicator and prompts on close with unsaved changes. This is what makes
  the clamp-and-re-render round trip coherent.
- **The tray's `Add a favorite project` / `Remove a favorite` items stay.** They
  mutate settings directly and then emit `settings:changed`, so an open window
  re-renders rather than holding stale state and reverting the change on its next
  save.
- **Projects section:** list with add (folder dialog), remove, colour swatch
  (picker + "reset to auto"), and a label field (blank = use folder name).
- **Reset to defaults** per section.
- **Clamped values are surfaced,** not silently corrected: if `settings:save`
  returns a value differing from what was submitted, the field shows an inline
  note. `validate()` never throwing must not mean the user never learns.

## 3. Error handling

- **Corrupt `settings.json`** — `validate()` degrades per field, so a typo in
  `timing` cannot wipe `projects`. Temp-file-then-rename, so a crash mid-write
  cannot leave a truncated config.
- **`rename` on Windows** can fail `EPERM`/`EBUSY` when a third party holds the
  target without `FILE_SHARE_DELETE`. Bounded retry; temp file in the same
  directory (same volume) with a unique name.
- **`launchAtLogin` silently failing** — `setLoginItemSettings` can no-op. The UI
  renders `getLoginItemSettings()` read back from the OS, not the value just
  written.

### Pre-existing hazards this spec does not fix

Both were surfaced by review, both predate this work, and both are recorded so they
are not rediscovered as regressions of it:

- **`publish()` is not atomic** (`loooop-cli.js:35` truncates before writing) while
  `readSessions()` silently drops a session on a torn read (`main.js:353`). Rare
  today because `publish()` fires roughly twice per session — but the token spec
  makes it periodic, so it must be fixed there.
- **`sessionKey()` is a function of the directory only, not the process.** Opening
  the same project twice gives both wrappers the same session file; whichever exits
  first deletes the live one's file. Fix is `<key>-<pid>.json` with the tray
  grouping by `projectDir`.

## 4. Testing

Unit-tested under `node --test`, no Electron:

- `settings.js` — every clamp bound above; per-field degradation on corrupt input;
  migration runs only when `settings.json` is absent; `save`/`load` round-trip.
- `paths.js` — env-var precedence over the computed default.

The 32 existing tests must pass untouched (verified: they do, given the stated
defaults).

Not unit-testable, added to the manual-verify list alongside the two outstanding
`BUG.md` items: the window itself, `launchAtLogin`, `openProjectTabsUnfocused`.

## 5. Open risk

`openProjectTabsUnfocused` has no clean mechanism. `wt.exe` has no
background/minimized flag; the workable trick is `cmd /c start /min wt.exe …`, but
`wt.exe` is a stub that hands off to `WindowsTerminal.exe`, so `/min` may not
propagate. **Verify during implementation.** If it does not work, the setting is
dropped rather than shipped as a no-op toggle.
