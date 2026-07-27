# Loooop Bug Fixes, xterm Terminal, Auto-Label & Memory Pass — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the tray reflect live CLI-wrapper state, replace the broken terminal renderer with xterm.js (fixing resize garbling and the unbounded-memory leak), auto-title/color each project tab, and finish with a memory pass.

**Architecture:** Add one pure, unit-tested helper module (`src/session-state.js`) for state normalization, per-project session keys, project colors, and tray status aggregation. The CLI wrapper publishes per-project session files; the Electron tray watches that directory and shows an aggregate status. The Electron terminal window is rebuilt on xterm.js with a capped scrollback and PTY resize forwarding.

**Tech Stack:** Node 20+, Electron 37, node-pty 1.1, `@xterm/xterm` 6.0.0, `@xterm/addon-fit` 0.11.0, `node --test`.

## Global Constraints

- Platform: Windows. Node.js 20+. Electron `^37.0.0`. node-pty `^1.1.0`.
- Pure helpers must stay importable by a plain `node --test` process — no Electron, no timers, no I/O in `session-state.js` (mirrors `claude-monitor.js`).
- Canonical session states (lowercase, exact): `starting | running | confirming-wait | waiting | retrying | resuming | stalled | stopped`.
- Renderer must load xterm from local files only (no network / CDN).
- Work on branch `feature/bugfixes-terminal-memory`. Commit after every task.
- Session data directory resolves to `%APPDATA%/loooop/sessions` from both entry points: CLI uses `path.join(process.env.APPDATA || process.env.LOCALAPPDATA || projectDir, 'loooop', 'sessions')`; tray uses `path.join(app.getPath('userData'), 'sessions')` (Electron `userData` = `%APPDATA%/loooop` because package `name` is `loooop`).

---

### Task 1: Pure helpers — `session-state.js`

**Files:**
- Create: `src/session-state.js`
- Test: `tests/session-state.test.js`

**Interfaces:**
- Consumes: nothing (only `crypto`, `path`).
- Produces:
  - `normalizeState(raw: any) -> canonicalState` — maps any label to a canonical state; unknown/non-string → `'stopped'`.
  - `sessionKey(projectDir: string) -> string` — 16-char lowercase hex, stable per resolved+lowercased path.
  - `projectColor(name: string) -> string` — deterministic `#rrggbb`.
  - `aggregateStatus(embedded, sessions) -> { state, label, projectName, resetAt, count }` — `embedded` is `null`, a canonical state string, or `{ state, projectName?, resetAt? }`; `sessions` is an array of `{ state, projectDir?, projectName?, resetAt? }`. Non-`stopped` entries are ranked; highest-priority wins. `count` = number of non-stopped entries.
  - `STATE_LABELS`, `STATE_PRIORITY` (exported for reuse/tests).

- [ ] **Step 1: Write the failing test**

Create `tests/session-state.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizeState, sessionKey, projectColor, aggregateStatus, STATE_LABELS
} = require('../src/session-state');

test('normalizeState maps case and legacy labels', () => {
  assert.equal(normalizeState('Running'), 'running');
  assert.equal(normalizeState('running'), 'running');
  assert.equal(normalizeState('confirming wait'), 'confirming-wait');
  assert.equal(normalizeState('confirming-wait'), 'confirming-wait');
  assert.equal(normalizeState('WAITING'), 'waiting');
  assert.equal(normalizeState('bogus'), 'stopped');
  assert.equal(normalizeState(null), 'stopped');
  assert.equal(normalizeState(42), 'stopped');
});

test('sessionKey is stable, case-insensitive, and short hex', () => {
  const a = sessionKey('C:\\Users\\me\\Proj');
  const b = sessionKey('c:\\users\\me\\proj');
  assert.equal(a, b);
  assert.match(a, /^[0-9a-f]{16}$/);
  assert.notEqual(sessionKey('C:\\one'), sessionKey('C:\\two'));
});

test('projectColor is deterministic valid hex', () => {
  assert.match(projectColor('Loooop'), /^#[0-9a-f]{6}$/);
  assert.equal(projectColor('Loooop'), projectColor('Loooop'));
  assert.notEqual(projectColor('a'), projectColor('b'));
  assert.match(projectColor(''), /^#[0-9a-f]{6}$/);
});

test('aggregateStatus: empty is stopped', () => {
  const d = aggregateStatus(null, []);
  assert.equal(d.state, 'stopped');
  assert.equal(d.count, 0);
  assert.equal(d.label, STATE_LABELS.stopped);
});

test('aggregateStatus: single running session carries project name', () => {
  const d = aggregateStatus(null, [{ state: 'running', projectDir: 'C:\\x\\Alpha' }]);
  assert.equal(d.state, 'running');
  assert.equal(d.projectName, 'Alpha');
  assert.equal(d.count, 1);
});

test('aggregateStatus: waiting outranks running and passes resetAt', () => {
  const d = aggregateStatus('running', [
    { state: 'waiting', projectDir: 'C:\\x\\Beta', resetAt: '2026-07-22T20:00:00.000Z' }
  ]);
  assert.equal(d.state, 'waiting');
  assert.equal(d.projectName, 'Beta');
  assert.equal(d.resetAt, '2026-07-22T20:00:00.000Z');
  assert.equal(d.count, 2);
});

test('aggregateStatus: stalled outranks waiting; stopped ignored', () => {
  const d = aggregateStatus(null, [
    { state: 'stopped', projectDir: 'C:\\x\\Gone' },
    { state: 'waiting', projectDir: 'C:\\x\\Beta' },
    { state: 'stalled', projectDir: 'C:\\x\\Zed' }
  ]);
  assert.equal(d.state, 'stalled');
  assert.equal(d.projectName, 'Zed');
  assert.equal(d.count, 2);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — `Cannot find module '../src/session-state'`.

- [ ] **Step 3: Write the implementation**

Create `src/session-state.js`:

```js
// Pure helpers for cross-process session state and tray aggregation.
// No timers, no Electron, no filesystem writes: must stay importable by a
// plain `node --test` process (mirrors claude-monitor.js).
const crypto = require('crypto');
const path = require('path');

const STATE_LABELS = {
  starting: 'Starting',
  running: 'Running',
  'confirming-wait': 'Confirming wait',
  waiting: 'Waiting',
  retrying: 'Retrying',
  resuming: 'Resuming',
  stalled: 'Stalled',
  stopped: 'Stopped'
};

// Higher wins when several sessions are active, so the most actionable state
// (needs-you first, then working, then idle) is what the tray surfaces.
const STATE_PRIORITY = {
  stalled: 7,
  waiting: 6,
  retrying: 5,
  'confirming-wait': 4,
  resuming: 3,
  running: 2,
  starting: 1,
  stopped: 0
};

function normalizeState(raw) {
  if (typeof raw !== 'string') return 'stopped';
  const s = raw.trim().toLowerCase().replace(/\s+/g, '-');
  return Object.prototype.hasOwnProperty.call(STATE_LABELS, s) ? s : 'stopped';
}

function sessionKey(projectDir) {
  const normalized = path.resolve(projectDir).toLowerCase();
  return crypto.createHash('sha1').update(normalized).digest('hex').slice(0, 16);
}

function hslToHex(h, s, l) {
  s /= 100;
  l /= 100;
  const k = (n) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n) => {
    const color = l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
    return Math.round(255 * color).toString(16).padStart(2, '0');
  };
  return `#${f(0)}${f(8)}${f(4)}`;
}

function projectColor(name) {
  const str = String(name || '');
  let hash = 0;
  for (let i = 0; i < str.length; i += 1) {
    hash = (hash * 31 + str.charCodeAt(i)) >>> 0;
  }
  return hslToHex(hash % 360, 65, 45);
}

function aggregateStatus(embedded, sessions = []) {
  const entries = [];
  const push = (state, projectName, resetAt) => {
    const s = normalizeState(state);
    if (s === 'stopped') return;
    entries.push({ state: s, projectName: projectName || null, resetAt: resetAt || null });
  };

  if (embedded) {
    if (typeof embedded === 'string') push(embedded, null, null);
    else push(embedded.state, embedded.projectName || null, embedded.resetAt || null);
  }
  for (const sess of sessions) {
    const name = sess.projectName || (sess.projectDir ? path.basename(sess.projectDir) : null);
    push(sess.state, name, sess.resetAt || null);
  }

  if (!entries.length) {
    return { state: 'stopped', label: STATE_LABELS.stopped, projectName: null, resetAt: null, count: 0 };
  }
  entries.sort((a, b) => STATE_PRIORITY[b.state] - STATE_PRIORITY[a.state]);
  const winner = entries[0];
  return {
    state: winner.state,
    label: STATE_LABELS[winner.state],
    projectName: winner.projectName,
    resetAt: winner.resetAt,
    count: entries.length
  };
}

module.exports = {
  normalizeState, sessionKey, projectColor, aggregateStatus,
  STATE_LABELS, STATE_PRIORITY
};
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: PASS — all `session-state` tests pass and existing `claude-monitor` tests still pass.

- [ ] **Step 5: Commit**

```bash
git add src/session-state.js tests/session-state.test.js
git commit -m "feat: add pure session-state helpers (normalize, key, color, aggregate)"
```

---

### Task 2: CLI wrapper — per-project session files, cleanup, stdout resize

**Files:**
- Modify: `src/loooop-cli.js`

**Interfaces:**
- Consumes: `sessionKey` from Task 1.
- Produces: session files at `%APPDATA%/loooop/sessions/<sessionKey>.json` with shape `{ state, projectDir, pid, updatedAt, ...details }`, deleted on process exit.

- [ ] **Step 1: Import `sessionKey` and switch to per-project session paths**

In `src/loooop-cli.js`, after the existing `require('./claude-monitor')` block (around line 12), add:

```js
const { sessionKey } = require('./session-state');
```

Replace the current state-path lines (the `stateDir` / `stateFile` definitions, ~lines 15-16):

```js
const stateDir = path.join(process.env.APPDATA || process.env.LOCALAPPDATA || projectDir, 'loooop');
const stateFile = path.join(stateDir, 'state.json');
```

with:

```js
const sessionsDir = path.join(process.env.APPDATA || process.env.LOCALAPPDATA || projectDir, 'loooop', 'sessions');
const sessionFile = path.join(sessionsDir, `${sessionKey(projectDir)}.json`);
```

- [ ] **Step 2: Publish to the per-project file and add cleanup**

Replace the current `publish` function:

```js
function publish(state, details = {}) {
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(stateFile, JSON.stringify({ state, projectDir, updatedAt: new Date().toISOString(), ...details }, null, 2));
}
```

with:

```js
function publish(state, details = {}) {
  fs.mkdirSync(sessionsDir, { recursive: true });
  fs.writeFileSync(
    sessionFile,
    JSON.stringify({ state, projectDir, pid: process.pid, updatedAt: new Date().toISOString(), ...details }, null, 2)
  );
}

function removeSessionFile() {
  try { fs.unlinkSync(sessionFile); } catch (_) {}
}
```

- [ ] **Step 3: Remove the redundant `stopped` publish on exit**

In `child.onExit`, replace this pair (the normal-exit tail):

```js
    publish('stopped', { exitCode });
    process.exit(exitCode || 0);
```

with (the `exit` handler added in Step 4 removes the file, so the tray sees the session disappear):

```js
    process.exit(exitCode || 0);
```

- [ ] **Step 4: Clean up on exit and forward stdout resizes to the PTY**

Immediately after the existing `process.on('SIGINT', ...)` handler (around line 217), add:

```js
process.on('exit', removeSessionFile);

process.stdout.on('resize', () => {
  if (!child) return;
  try { child.resize(process.stdout.columns || 120, process.stdout.rows || 36); } catch (_) {}
});
```

- [ ] **Step 5: Manually verify**

Run from a project folder in Windows Terminal: `node "C:\Users\Sirjohn\Documents\Loooop\src\loooop-cli.js"`
Expected:
- A file appears at `%APPDATA%\loooop\sessions\<hex>.json` containing `"state": "running"` and a `"pid"`.
- Resizing the terminal window reflows Claude's output correctly (no stuck 120-column wrapping).
- Exiting Claude (or Ctrl-C) removes that session file.

- [ ] **Step 6: Commit**

```bash
git add src/loooop-cli.js
git commit -m "feat(cli): publish per-project session files and forward terminal resize"
```

---

### Task 3: Tray — watch sessions, aggregate status, canonical states

**Files:**
- Modify: `src/main.js`

**Interfaces:**
- Consumes: `normalizeState`, `aggregateStatus` from Task 1; session files from Task 2.
- Produces: tray tooltip/menu reflecting embedded + CLI sessions. Internal `currentState` now uses canonical lowercase states.

- [ ] **Step 1: Import helpers and add the sessions directory + state**

In `src/main.js`, extend the `claude-monitor` require and add the new module + module-level state. Replace the top requires/state block (lines 6-26) so it reads:

```js
const {
  parseResetTime, detectRateLimit, atRateLimitMenu, resolveClaudeCommand,
  detectStall, createStallTracker, STALL_RESET_MS, NUDGE
} = require('./claude-monitor');
const { aggregateStatus } = require('./session-state');

let tray;
let terminalWindow;
let terminal;
let currentState = 'stopped';
let resetAt = null;
let countdownTimer;
let lastOutput = '';
let waitMenuConfirmed = false;
const stallTracker = createStallTracker();
let stallHandled = false;
let retryTimer = null;
let stallResetTimer = null;
const logFile = path.join(app.getPath('userData'), 'loooop.log');
const favoritesFile = path.join(app.getPath('userData'), 'favorite-projects.json');
const sessionsDir = path.join(app.getPath('userData'), 'sessions');
const SESSION_STALE_MS = 6 * 60 * 60 * 1000; // fallback prune age for pid-less files
const iconPath = path.join(__dirname, '..', 'assets', 'loooop.png');
let favoriteProjects = [];
let sessions = [];
let sessionWatcher = null;
let watchDebounce = null;
let uiTicker = null;
```

- [ ] **Step 2: Convert embedded states to canonical lowercase**

Apply these exact replacements in `src/main.js` (embedded-terminal state vocabulary → canonical):

- In `waitForReset`: `setState('Waiting');` → `setState('waiting');`
- In `cancelRetry`: `if (currentState === 'Retrying' || currentState === 'Stalled') {` → `if (currentState === 'retrying' || currentState === 'stalled') {`
- In `cancelRetry`: `setState(terminal ? 'Running' : 'Stopped');` → `setState(terminal ? 'running' : 'stopped');`
- In `giveUpOnStall`: `if (currentState !== 'Stalled' && Notification.isSupported()) {` → `if (currentState !== 'stalled' && Notification.isSupported()) {`
- In `giveUpOnStall`: `setState('Stalled');` → `setState('stalled');`
- In `handleStall`: `setState('Retrying');` → `setState('retrying');`
- In `handleStall` (inside the retry timer): `setState('Running');` → `setState('running');`
- In `startClaude`: `setState('Running');` → `setState('running');`
- In `startClaude`'s `onExit`: `if (!resetAt) setState('Stopped');` → `if (!resetAt) setState('stopped');`
- In `stopClaude`: `setState('Stopped');` → `setState('stopped');`

- [ ] **Step 3: Add session reading, pruning, and directory watching**

Add these functions to `src/main.js` (place them just above `function stopClaude()`):

```js
function isProcessAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; }
  catch (err) { return err.code === 'EPERM'; }
}

function readSessions() {
  let files;
  try { files = fs.readdirSync(sessionsDir); }
  catch (_) { return []; }
  const now = Date.now();
  const active = [];
  for (const file of files) {
    if (!file.endsWith('.json')) continue;
    const full = path.join(sessionsDir, file);
    let data;
    try { data = JSON.parse(fs.readFileSync(full, 'utf8')); }
    catch (_) { continue; }
    const stale = data.pid
      ? !isProcessAlive(data.pid)
      : !(data.updatedAt && now - new Date(data.updatedAt).getTime() < SESSION_STALE_MS);
    if (stale) { try { fs.unlinkSync(full); } catch (_) {} continue; }
    active.push(data);
  }
  return active;
}

function refreshSessions() {
  sessions = readSessions();
  updateTray();
}

function startSessionWatch() {
  try { fs.mkdirSync(sessionsDir, { recursive: true }); } catch (_) {}
  refreshSessions();
  try {
    sessionWatcher = fs.watch(sessionsDir, () => {
      if (watchDebounce) clearTimeout(watchDebounce);
      watchDebounce = setTimeout(refreshSessions, 200);
    });
  } catch (_) {
    setInterval(refreshSessions, 3000);
  }
}
```

- [ ] **Step 4: Replace status formatting with the aggregate + a countdown ticker**

Replace the whole `formatStatus` function:

```js
function formatStatus() {
  if (currentState !== 'Waiting' || !resetAt) return currentState;
  const seconds = Math.max(0, Math.ceil((resetAt - Date.now()) / 1000));
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return `Waiting ${h ? `${h}h ` : ''}${m}m ${s}s`;
}
```

with:

```js
function currentDisplay() {
  const embedded = currentState !== 'stopped'
    ? { state: currentState, resetAt: resetAt ? resetAt.toISOString() : null }
    : null;
  return aggregateStatus(embedded, sessions);
}

function formatStatus() {
  const d = currentDisplay();
  if (d.state === 'stopped') return 'Stopped';
  let text = d.label;
  if (d.state === 'waiting' && d.resetAt) {
    const seconds = Math.max(0, Math.ceil((new Date(d.resetAt).getTime() - Date.now()) / 1000));
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = seconds % 60;
    text = `Waiting ${h ? `${h}h ` : ''}${m}m ${s}s`;
  }
  if (d.projectName) text += ` (${d.projectName})`;
  if (d.count > 1) text += ` \u00b7 ${d.count} sessions`;
  return text;
}

function ensureTicker(active) {
  if (active && !uiTicker) uiTicker = setInterval(updateTray, 1000);
  if (!active && uiTicker) { clearInterval(uiTicker); uiTicker = null; }
}
```

- [ ] **Step 5: Drop the embedded countdown's own repaint (the ticker owns UI now)**

In `waitForReset`, replace the interval body:

```js
  countdownTimer = setInterval(() => {
    if (Date.now() >= resetAt.getTime()) {
      clearInterval(countdownTimer);
      countdownTimer = null;
      resetAt = null;
      resumeSession();
    } else {
      updateTray();
    }
  }, 1000);
```

with (the per-second repaint is handled by `ensureTicker`; this timer only triggers the resume):

```js
  countdownTimer = setInterval(() => {
    if (Date.now() >= resetAt.getTime()) {
      clearInterval(countdownTimer);
      countdownTimer = null;
      resetAt = null;
      resumeSession();
    }
  }, 1000);
```

- [ ] **Step 6: Update the tray menu to use the aggregate + drive the ticker**

Replace the `updateTray` function body's opening lines and the `Resume now` item. Replace:

```js
function updateTray() {
  if (!tray) return;
  tray.setToolTip(`Loooop — ${formatStatus()}`);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: `Status: ${formatStatus()}`, enabled: false },
```

with:

```js
function updateTray() {
  if (!tray) return;
  const status = formatStatus();
  ensureTicker(currentDisplay().state === 'waiting');
  tray.setToolTip(`Loooop — ${status}`);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: `Status: ${status}`, enabled: false },
```

And change the `Resume now` menu item:

```js
    { label: 'Resume now', enabled: currentState === 'Waiting', click: resumeSession },
```

to:

```js
    { label: 'Resume now', enabled: currentState === 'waiting', click: resumeSession },
```

- [ ] **Step 7: Start watching when the app is ready**

In the `app.whenReady().then(...)` callback, add `startSessionWatch();` right after `loadFavoriteProjects();`:

```js
app.whenReady().then(() => {
  loadFavoriteProjects();
  startSessionWatch();
  const icon = nativeImage.createFromPath(iconPath);
  tray = new Tray(icon);
  updateTray();
  tray.on('click', updateTray);
});
```

- [ ] **Step 8: Run existing tests and manually verify**

Run: `npm test`
Expected: PASS (no regressions; this task changes no pure helpers).

Manual: `npm start`, then in a separate Windows Terminal run the wrapper (`node src/loooop-cli.js`) from a project folder.
Expected: within ~1s the tray tooltip/menu shows `Running (<project>)` instead of `Stopped`; closing that session returns the tray to `Stopped`.

- [ ] **Step 9: Commit**

```bash
git add src/main.js
git commit -m "feat(tray): reflect CLI sessions via aggregate status and directory watch"
```

---

### Task 4: xterm.js terminal window with PTY resize forwarding

**Files:**
- Modify: `package.json`, `src/preload.js`, `src/terminal.html`, `src/main.js`

**Interfaces:**
- Consumes: `terminal-data` (main→renderer), `terminal-input` (renderer→main) — existing channels.
- Produces: new `terminal-resize` channel (renderer→main) carrying `{ cols, rows }`; main calls `terminal.resize(cols, rows)`.

- [ ] **Step 1: Add the xterm dependencies**

Run:

```bash
npm install @xterm/xterm@6.0.0 @xterm/addon-fit@0.11.0
```

Expected: `package.json` `dependencies` gains `@xterm/xterm` and `@xterm/addon-fit`; `node_modules/@xterm/xterm/lib/xterm.js`, `node_modules/@xterm/xterm/css/xterm.css`, and `node_modules/@xterm/addon-fit/lib/addon-fit.js` exist.

- [ ] **Step 2: Expose a resize bridge in preload**

Replace the whole body of `src/preload.js`:

```js
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('loooop', {
  onData: (callback) => ipcRenderer.on('terminal-data', (_event, data) => callback(data)),
  write: (data) => ipcRenderer.send('terminal-input', data),
  resize: (size) => ipcRenderer.send('terminal-resize', size)
});
```

- [ ] **Step 3: Rebuild the terminal page on xterm.js**

Replace the entire contents of `src/terminal.html`:

```html
<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>Loooop</title>
  <link rel="stylesheet" href="../node_modules/@xterm/xterm/css/xterm.css">
  <style>
    html, body { margin: 0; height: 100%; background: #101114; }
    #terminal { box-sizing: border-box; width: 100%; height: 100%; padding: 8px; }
  </style>
</head>
<body>
  <div id="terminal"></div>
  <script src="../node_modules/@xterm/xterm/lib/xterm.js"></script>
  <script src="../node_modules/@xterm/addon-fit/lib/addon-fit.js"></script>
  <script>
    const term = new Terminal({
      fontFamily: 'Consolas, monospace',
      fontSize: 14,
      scrollback: 1000,
      cursorBlink: true,
      theme: { background: '#101114', foreground: '#e7e7e7' }
    });
    const fit = new FitAddon.FitAddon();
    term.loadAddon(fit);
    term.open(document.getElementById('terminal'));

    function syncSize() {
      fit.fit();
      window.loooop.resize({ cols: term.cols, rows: term.rows });
    }

    window.loooop.onData((data) => term.write(data));
    term.onData((data) => window.loooop.write(data));
    window.addEventListener('resize', syncSize);
    requestAnimationFrame(syncSize);
    term.focus();
  </script>
</body>
</html>
```

- [ ] **Step 4: Handle resize in main and stop hard-coding 120x36 growth**

In `src/main.js`, add a resize IPC handler next to the existing `ipcMain.on('terminal-input', ...)` (near the bottom of the file):

```js
ipcMain.on('terminal-resize', (_event, size) => {
  if (terminal && size && size.cols > 0 && size.rows > 0) {
    try { terminal.resize(size.cols, size.rows); } catch (_) {}
  }
});
```

(The `pty.spawn` `cols: 120, rows: 36` stays as the initial size; the renderer corrects it via `syncSize` on load.)

- [ ] **Step 5: Manually verify**

Run: `npm start`, open the terminal window (tray → "Open terminal"), then "Start Claude".
Expected:
- Claude Code renders as a real terminal (colors, boxes, cursor) — not raw escape codes.
- Resizing the window reflows content cleanly with no garbled/overlapping text.
- Long output scrolls; memory does not grow without bound (scrollback capped at 1000 lines).

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json src/preload.js src/terminal.html src/main.js
git commit -m "feat(terminal): render with xterm.js and forward resize to the PTY"
```

---

### Task 5: Auto title + color per project terminal

**Files:**
- Modify: `src/main.js`

**Interfaces:**
- Consumes: `projectColor` from Task 1.
- Produces: project terminals launched with a per-project Windows Terminal title and tab color.

- [ ] **Step 1: Import `projectColor`**

In `src/main.js`, extend the `session-state` require:

```js
const { aggregateStatus } = require('./session-state');
```

to:

```js
const { aggregateStatus, projectColor } = require('./session-state');
```

- [ ] **Step 2: Pass title + color to Windows Terminal (with a cmd fallback title)**

Replace the whole `startProjectTerminal` function:

```js
function startProjectTerminal(projectDir) {
  const wrapper = path.join(__dirname, 'loooop-cli.js');
  const command = `node "${wrapper}"`;
  const options = { detached: true, stdio: 'ignore', windowsHide: false };
  const terminal = spawn('wt.exe', ['-d', projectDir, 'cmd.exe', '/k', command], options);
  terminal.on('error', () => {
    const fallback = spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/k', `cd /d "${projectDir}" && ${command}`], options);
    fallback.unref();
  });
  terminal.unref();
  log(`Opened Loooop terminal for ${projectDir}`);
}
```

with:

```js
function startProjectTerminal(projectDir) {
  const wrapper = path.join(__dirname, 'loooop-cli.js');
  const command = `node "${wrapper}"`;
  const projectName = path.basename(projectDir) || projectDir;
  const color = projectColor(projectName);
  const options = { detached: true, stdio: 'ignore', windowsHide: false };
  const terminal = spawn(
    'wt.exe',
    ['-d', projectDir, '--title', projectName, '--tabColor', color, 'cmd.exe', '/k', command],
    options
  );
  terminal.on('error', () => {
    const fallback = spawn(
      process.env.ComSpec || 'cmd.exe',
      ['/d', '/k', `title ${projectName} && cd /d "${projectDir}" && ${command}`],
      options
    );
    fallback.unref();
  });
  terminal.unref();
  log(`Opened Loooop terminal for ${projectDir} (${color})`);
}
```

- [ ] **Step 3: Manually verify**

Run: `npm start`, tray → "Start in project folder…", choose a folder.
Expected: a new Windows Terminal tab opens titled with the folder's name and a stable tab color; re-opening the same project yields the same color.

- [ ] **Step 4: Commit**

```bash
git add src/main.js
git commit -m "feat: auto-title and color each project terminal tab"
```

---

### Task 6: Memory-optimization pass

**Files:**
- Modify: `src/main.js`

**Interfaces:**
- Consumes: nothing new.
- Produces: single-instance behavior; reduced idle footprint.

- [ ] **Step 1: Measure baseline**

Run `npm start`, open the terminal, run a session for a minute, then note the Electron processes' memory in Task Manager (Details → sum of `electron.exe` working sets). Record the number — this is the before value.

- [ ] **Step 2: Add a single-instance lock and drop the GPU process**

At the very top of `src/main.js`, immediately after the `require` block (before any function definitions), add:

```js
// One tray process is enough; a second launch just focuses the terminal window.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (terminalWindow && !terminalWindow.isDestroyed()) terminalWindow.show();
  });
  // The tray + xterm (DOM renderer) do not need hardware acceleration; skipping
  // the GPU process trims idle memory. Must be called before app is ready.
  app.disableHardwareAcceleration();
}
```

- [ ] **Step 3: Keep the terminal window from retaining a GPU/paint budget while hidden**

In `openTerminalWindow`, add `backgroundThrottling: true` to `webPreferences` (Chromium default, made explicit so throttling of the hidden window is intentional):

```js
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, backgroundThrottling: true }
```

- [ ] **Step 4: Verify scrollback bound and no retained terminal references**

Confirm (already true from Task 4) `scrollback: 1000` is set in `terminal.html`, and that `terminalWindow.on('closed', () => { terminalWindow = null; })` remains in `openTerminalWindow` so the window is released on close.

- [ ] **Step 5: Measure after and confirm no functional regressions**

Run `npm start` again, repeat the Step 1 measurement, and confirm:
- Idle/after-session working set is <= the baseline (record the delta).
- Terminal still renders and resizes correctly (no GPU-accel regressions visible with xterm's DOM renderer).
- Launching a second instance does not create a second tray icon; it focuses the terminal window instead.

If `disableHardwareAcceleration()` visibly harms rendering, remove that single line and keep the rest.

- [ ] **Step 6: Commit**

```bash
git add src/main.js
git commit -m "perf: single-instance lock, drop GPU process, explicit hidden-window throttling"
```

---

## Notes for the implementer

- `npm test` runs `node --test tests/**/*.test.js`; only pure helpers are unit-tested. Tasks 2–6 rely on the documented manual verification because they touch Electron/PTY/DOM wiring.
- Both entry points must resolve the same `sessions` directory. If a mismatch is suspected at runtime, log `sessionsDir` from `main.js` and compare with the file the CLI writes.
- `fs.watch` on Windows can miss events under load; the 3s interval fallback in `startSessionWatch` covers environments where `fs.watch` throws. Stale/dead sessions are pruned on every read via `isProcessAlive`.
