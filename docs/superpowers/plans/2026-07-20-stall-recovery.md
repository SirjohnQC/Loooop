# Stall Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Detect the "API Error: Response stalled mid-stream" notice in a supervised Claude Code session and recover it automatically with a bounded retry schedule, escalating to a visible notification when the budget is spent.

**Architecture:** A new pure module `src/claude-monitor.js` holds the text predicates, the backoff constants, and a timer-free retry-counter tracker. The two entry points (`src/main.js`, `src/claude-resume-cli.js`) import it and own all timers, PTY writes, and UI side effects. Detection logic therefore has one home and is testable without a PTY.

**Tech Stack:** Node.js (CommonJS), `node:test` + `node:assert/strict` for tests (no new dependencies), `node-pty`, Electron 37.

## Global Constraints

- **CommonJS only.** Every file in `src/` uses `require`/`module.exports`. Do not introduce ESM.
- **No new dependencies.** Tests use node's built-in `node:test`. `package.json` `dependencies` stays `{ "node-pty": "^1.1.0" }`.
- **`src/claude-monitor.js` must stay side-effect free.** No `setTimeout`, no `fs`, no `require('electron')`, no PTY access. It must be importable by a plain `node` test process with no Electron runtime.
- **Behaviour-preserving refactors stay behaviour-preserving.** Tasks 4 and 5 move code without changing what it matches. The two rate-limit predicates genuinely differ between entry points (see Task 1) — preserve both.
- **Exact constant values:** `BACKOFF_MS = [30_000, 120_000, 300_000]`, `STALL_RESET_MS = 300_000`, `NUDGE = 'continue\r'`.
- **Give-up threshold:** the 4th consecutive stall. Three retries happen; the fourth stall escalates.
- Commit after every task.

## Deviations from the spec

Two points where this plan knowingly differs from `docs/superpowers/specs/2026-07-18-claude-resume-stall-recovery-design.md`. Both are corrections, not scope changes.

1. **The spec says the module exports "predicates and constants only, no timers".** This plan also exports `createStallTracker()` — a factory holding the attempt counter and the give-up decision. It contains no timers and no I/O, so it honours the spec's actual intent (testable without a PTY) while keeping the retry-budget rules from being written twice, once per entry point. The entry points still own every `setTimeout`.

2. **The spec says `detectRateLimit` is duplicated "verbatim" in both entry points.** It is not. `main.js:48-50` tests a broader pattern (`…|try again later|resets? at`) than the inline regex at `claude-resume-cli.js:86` (`/rate\s*limit|usage\s*limit|limit\s+(?:to\s+)?reset/i`). Collapsing them into one predicate would change when the CLI arms `rateLimitContext`, and thus when it schedules a resume. Both are preserved under distinct names: `detectRateLimit` (main.js behaviour) and `detectRateLimitContext` (CLI behaviour).

## File Structure

| File | Responsibility |
|---|---|
| `src/claude-monitor.js` (create) | Pure detection predicates, backoff constants, retry-counter tracker. No I/O. |
| `tests/claude-monitor.test.js` (create) | `node:test` coverage for every export of the module. |
| `package.json` (modify) | Add `"test": "node --test tests/"`. |
| `src/main.js` (modify) | Electron tray entry point. Imports the module; owns tray state, notification, retry timers, IPC cancel. |
| `src/claude-resume-cli.js` (modify) | Terminal wrapper entry point. Imports the module; owns state-file publishing, retry timers, stdin cancel. |

---

### Task 1: Shared module with the existing predicates

Move the four existing pure functions into one module and prove they behave identically. No new behaviour yet.

**Files:**
- Create: `src/claude-monitor.js`
- Create: `tests/claude-monitor.test.js`
- Modify: `package.json:6-9`

**Interfaces:**
- Consumes: nothing.
- Produces: `parseResetTime(text) -> Date|null`, `detectRateLimit(text) -> boolean`, `detectRateLimitContext(text) -> boolean`, `atRateLimitMenu(text) -> boolean`, `resolveClaudeCommand() -> string`.

- [ ] **Step 1: Write the failing test**

Create `tests/claude-monitor.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const monitor = require('../src/claude-monitor');

test('parseResetTime reads a 12-hour reset time', () => {
  const target = monitor.parseResetTime('Your limit will reset at 3:30pm');
  assert.ok(target instanceof Date);
  assert.equal(target.getHours(), 15);
  assert.equal(target.getMinutes(), 30);
});

test('parseResetTime returns null when no time is present', () => {
  assert.equal(monitor.parseResetTime('no reset information here'), null);
});

test('parseResetTime rolls a past time to tomorrow', () => {
  const now = new Date();
  const past = new Date(now.getTime() - 60 * 60 * 1000);
  const stamp = `${past.getHours()}:${String(past.getMinutes()).padStart(2, '0')}`;
  const target = monitor.parseResetTime(`resets at ${stamp}`);
  assert.ok(target.getTime() > now.getTime());
});

test('detectRateLimit matches the broad main.js patterns', () => {
  assert.equal(monitor.detectRateLimit('You have hit your usage limit'), true);
  assert.equal(monitor.detectRateLimit('please try again later'), true);
  assert.equal(monitor.detectRateLimit('all good here'), false);
});

test('detectRateLimitContext keeps the narrower CLI patterns', () => {
  assert.equal(monitor.detectRateLimitContext('rate limit reached'), true);
  assert.equal(monitor.detectRateLimitContext('please try again later'), false);
});

test('atRateLimitMenu matches the confirmation menu only when complete', () => {
  const menu = 'What do you want to do?\n> Stop and wait for limit to reset\nEnter to confirm';
  assert.equal(monitor.atRateLimitMenu(menu), true);
  assert.equal(monitor.atRateLimitMenu('What do you want to do?'), false);
});

test('resolveClaudeCommand honours the override env var', () => {
  const previous = process.env.CLAUDE_RESUME_CLAUDE_PATH;
  process.env.CLAUDE_RESUME_CLAUDE_PATH = 'C:\\custom\\claude.exe';
  try {
    assert.equal(monitor.resolveClaudeCommand(), 'C:\\custom\\claude.exe');
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_RESUME_CLAUDE_PATH;
    else process.env.CLAUDE_RESUME_CLAUDE_PATH = previous;
  }
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test`
Expected: FAIL — `Cannot find module '../src/claude-monitor'`. (If `npm test` itself errors with "Missing script: test", that is expected too; Step 4 adds it.)

- [ ] **Step 3: Write the module**

Create `src/claude-monitor.js`:

```js
// Pure detection helpers shared by src/main.js and src/claude-resume-cli.js.
// No timers, no I/O, no Electron: this module must stay importable by a plain
// `node --test` process.
const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');

function parseResetTime(text) {
  const match = text.match(/(?:reset|resets|available)[^\n\r]*?(\d{1,2}:\d{2})\s*(am|pm)?/i);
  if (!match) return null;

  let [hours, minutes] = match[1].split(':').map(Number);
  const meridiem = match[2]?.toLowerCase();
  const now = new Date();
  if (meridiem === 'pm' && hours < 12) hours += 12;
  if (meridiem === 'am' && hours === 12) hours = 0;

  const target = new Date(now);
  target.setHours(hours, minutes, 0, 0);
  if (target <= now) target.setDate(target.getDate() + 1);
  return target;
}

// main.js arms its rate-limit path on a broader match than the CLI does. The two
// are deliberately kept apart so neither entry point changes behaviour.
function detectRateLimit(text) {
  return /rate\s*limit|usage\s*limit|limit\s+(?:to\s+)?reset|try again later|resets? at/i.test(text);
}

function detectRateLimitContext(text) {
  return /rate\s*limit|usage\s*limit|limit\s+(?:to\s+)?reset/i.test(text);
}

function atRateLimitMenu(text) {
  return /What do you want to do\?[\s\S]*?Stop and wait for limit to reset[\s\S]*?Enter to confirm/i.test(text);
}

function resolveClaudeCommand() {
  if (process.env.CLAUDE_RESUME_CLAUDE_PATH) return process.env.CLAUDE_RESUME_CLAUDE_PATH;
  if (process.platform !== 'win32') return 'claude';
  try {
    const found = execFileSync('where.exe', ['claude.exe'], { encoding: 'utf8', windowsHide: true })
      .split(/\r?\n/).find(Boolean);
    if (found) return found.trim();
  } catch (_) {}
  const localInstall = path.join(process.env.USERPROFILE || '', '.local', 'bin', 'claude.exe');
  if (fs.existsSync(localInstall)) return localInstall;
  return 'claude.cmd';
}

module.exports = {
  parseResetTime,
  detectRateLimit,
  detectRateLimitContext,
  atRateLimitMenu,
  resolveClaudeCommand
};
```

- [ ] **Step 4: Wire up `npm test`**

In `package.json`, replace the `scripts` block:

```json
  "scripts": {
    "start": "electron .",
    "dev": "electron .",
    "test": "node --test tests/"
  },
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm test`
Expected: PASS — `# pass 7`, `# fail 0`.

- [ ] **Step 6: Commit**

```bash
git add src/claude-monitor.js tests/claude-monitor.test.js package.json
git commit -m "refactor: extract shared detection helpers into claude-monitor"
```

---

### Task 2: Stall detection and constants

**Files:**
- Modify: `src/claude-monitor.js`
- Test: `tests/claude-monitor.test.js`

**Interfaces:**
- Consumes: the module from Task 1.
- Produces: `detectStall(text) -> boolean`, `BACKOFF_MS` (`number[]`), `STALL_RESET_MS` (`number`), `NUDGE` (`string`).

- [ ] **Step 1: Write the failing test**

Append to `tests/claude-monitor.test.js`:

```js
test('detectStall matches the real stall notice', () => {
  const notice = 'API Error: Response stalled mid-stream. The response above may be incomplete.';
  assert.equal(monitor.detectStall(notice), true);
});

test('detectStall is case-insensitive', () => {
  assert.equal(monitor.detectStall('api error: response STALLED mid-stream'), true);
});

test('detectStall ignores unrelated API errors', () => {
  assert.equal(monitor.detectStall('API Error: 429 rate_limit_error'), false);
  assert.equal(monitor.detectStall('API Error: overloaded_error'), false);
});

test('backoff constants hold the agreed schedule', () => {
  assert.deepEqual(monitor.BACKOFF_MS, [30_000, 120_000, 300_000]);
  assert.equal(monitor.STALL_RESET_MS, 300_000);
  assert.equal(monitor.NUDGE, 'continue\r');
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test`
Expected: FAIL — `monitor.detectStall is not a function`.

- [ ] **Step 3: Add the exports**

In `src/claude-monitor.js`, add above `module.exports`:

```js
const STALL_RE = /API Error: Response stalled mid-stream/i;

function detectStall(text) {
  return STALL_RE.test(text);
}

const BACKOFF_MS = [30_000, 120_000, 300_000];
const STALL_RESET_MS = 300_000;
const NUDGE = 'continue\r';
```

And extend `module.exports` to:

```js
module.exports = {
  parseResetTime,
  detectRateLimit,
  detectRateLimitContext,
  atRateLimitMenu,
  resolveClaudeCommand,
  detectStall,
  BACKOFF_MS,
  STALL_RESET_MS,
  NUDGE
};
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test`
Expected: PASS — `# pass 11`, `# fail 0`.

- [ ] **Step 5: Commit**

```bash
git add src/claude-monitor.js tests/claude-monitor.test.js
git commit -m "feat: add stall detection and backoff constants"
```

---

### Task 3: Retry-budget tracker

The counter rules live here so `main.js` and the CLI cannot drift apart. Timer-free: callers decide *when* to call these, the tracker decides *what* should happen.

**Files:**
- Modify: `src/claude-monitor.js`
- Test: `tests/claude-monitor.test.js`

**Interfaces:**
- Consumes: `BACKOFF_MS` from Task 2.
- Produces: `createStallTracker() -> { attempt: number, onStall(): Decision, onQuiet(): void, reset(): void }` where `Decision` is either `{ action: 'retry', delayMs: number, attempt: number }` (`attempt` is 1-based: the number of this retry) or `{ action: 'give-up', attempts: number }`.

- [ ] **Step 1: Write the failing test**

Append to `tests/claude-monitor.test.js`:

```js
test('tracker walks the backoff schedule then gives up on the 4th stall', () => {
  const tracker = monitor.createStallTracker();
  assert.deepEqual(tracker.onStall(), { action: 'retry', delayMs: 30_000, attempt: 1 });
  assert.deepEqual(tracker.onStall(), { action: 'retry', delayMs: 120_000, attempt: 2 });
  assert.deepEqual(tracker.onStall(), { action: 'retry', delayMs: 300_000, attempt: 3 });
  assert.deepEqual(tracker.onStall(), { action: 'give-up', attempts: 3 });
});

test('tracker keeps giving up once the budget is spent', () => {
  const tracker = monitor.createStallTracker();
  tracker.onStall();
  tracker.onStall();
  tracker.onStall();
  tracker.onStall();
  assert.deepEqual(tracker.onStall(), { action: 'give-up', attempts: 3 });
});

test('a stall-free interval restores the full budget', () => {
  const tracker = monitor.createStallTracker();
  tracker.onStall();
  tracker.onStall();
  tracker.onQuiet();
  assert.deepEqual(tracker.onStall(), { action: 'retry', delayMs: 30_000, attempt: 1 });
});

test('reset clears the counter for user takeover', () => {
  const tracker = monitor.createStallTracker();
  tracker.onStall();
  assert.equal(tracker.attempt, 1);
  tracker.reset();
  assert.equal(tracker.attempt, 0);
});

test('trackers are independent of one another', () => {
  const a = monitor.createStallTracker();
  const b = monitor.createStallTracker();
  a.onStall();
  assert.equal(b.attempt, 0);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test`
Expected: FAIL — `monitor.createStallTracker is not a function`.

- [ ] **Step 3: Implement the tracker**

In `src/claude-monitor.js`, add above `module.exports`:

```js
// Holds the retry budget for one supervised session. Deliberately timer-free:
// the caller schedules the wait and reports back what happened.
function createStallTracker() {
  let attempt = 0;
  return {
    get attempt() { return attempt; },
    onStall() {
      if (attempt >= BACKOFF_MS.length) return { action: 'give-up', attempts: attempt };
      const delayMs = BACKOFF_MS[attempt];
      attempt += 1;
      return { action: 'retry', delayMs, attempt };
    },
    onQuiet() { attempt = 0; },
    reset() { attempt = 0; }
  };
}
```

Add `createStallTracker` to `module.exports`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test`
Expected: PASS — `# pass 16`, `# fail 0`.

- [ ] **Step 5: Commit**

```bash
git add src/claude-monitor.js tests/claude-monitor.test.js
git commit -m "feat: add timer-free stall retry tracker"
```

---

### Task 4: Point `main.js` at the shared module

Pure refactor. `main.js` must behave exactly as before.

**Files:**
- Modify: `src/main.js:1-6` (imports), `src/main.js:32-67` (delete the four moved functions)

**Interfaces:**
- Consumes: `parseResetTime`, `detectRateLimit`, `atRateLimitMenu`, `resolveClaudeCommand` from Task 1.
- Produces: nothing new.

- [ ] **Step 1: Add the import**

In `src/main.js`, after the `const pty = require('node-pty');` line (line 6), add:

```js
const { parseResetTime, detectRateLimit, atRateLimitMenu, resolveClaudeCommand } = require('./claude-monitor');
```

- [ ] **Step 2: Delete the now-duplicated definitions**

Delete lines 32-67 of `src/main.js` — the whole run of `function parseResetTime(text) { … }`, `function detectRateLimit(text) { … }`, `function atRateLimitMenu(text) { … }`, and `function resolveClaudeCommand() { … }`. Leave `log`, `setState`, and `waitForReset` untouched.

- [ ] **Step 3: Drop the imports that are now unused**

`execFileSync` was used only by `resolveClaudeCommand`. On line 5, change:

```js
const { spawn, execFileSync } = require('child_process');
```

to:

```js
const { spawn } = require('child_process');
```

Keep `path`, `fs`, and `os` — they are still used elsewhere in the file.

- [ ] **Step 4: Verify the file still parses and nothing dangles**

Run: `node --check src/main.js`
Expected: no output (exit 0).

Run: `npm test`
Expected: PASS — `# pass 16`, `# fail 0` (unchanged; this task adds no tests).

Then confirm no stale references remain — search `src/main.js` for `function parseResetTime`, `function detectRateLimit`, `function atRateLimitMenu`, `function resolveClaudeCommand`. Expected: no matches.

- [ ] **Step 5: Commit**

```bash
git add src/main.js
git commit -m "refactor: main.js uses shared claude-monitor helpers"
```

---

### Task 5: Point `claude-resume-cli.js` at the shared module

Pure refactor. Note the CLI uses `detectRateLimitContext`, **not** `detectRateLimit` — see "Deviations from the spec".

**Files:**
- Modify: `src/claude-resume-cli.js:6-9` (imports), `src/claude-resume-cli.js:31-63` (delete moved functions), `src/claude-resume-cli.js:86` (use the named predicate)

**Interfaces:**
- Consumes: `parseResetTime`, `detectRateLimitContext`, `atRateLimitMenu`, `resolveClaudeCommand` from Task 1.
- Produces: nothing new.

- [ ] **Step 1: Add the import**

In `src/claude-resume-cli.js`, after `const pty = require('node-pty');` (line 9), add:

```js
const { parseResetTime, detectRateLimitContext, atRateLimitMenu, resolveClaudeCommand } = require('./claude-monitor');
```

- [ ] **Step 2: Delete the now-duplicated definitions**

Delete lines 31-63 — `function parseResetTime(text) { … }`, `function atRateLimitMenu(text) { … }`, and `function resolveClaudeCommand() { … }`. Leave `publish`, `writeNotice`, and `scheduleResume` untouched.

- [ ] **Step 3: Replace the inline rate-limit regex**

In `handleOutput`, change:

```js
  if (/rate\s*limit|usage\s*limit|limit\s+(?:to\s+)?reset/i.test(outputBuffer)) rateLimitContext = true;
```

to:

```js
  if (detectRateLimitContext(outputBuffer)) rateLimitContext = true;
```

- [ ] **Step 4: Drop the imports that are now unused**

`execFileSync` was used only by `resolveClaudeCommand`. Delete line 8 entirely:

```js
const { execFileSync } = require('child_process');
```

Keep `path` and `fs` — both are still used by `publish` and the state-file paths.

- [ ] **Step 5: Verify**

Run: `node --check src/claude-resume-cli.js`
Expected: no output (exit 0).

Run: `npm test`
Expected: PASS — `# pass 16`, `# fail 0`.

- [ ] **Step 6: Commit**

```bash
git add src/claude-resume-cli.js
git commit -m "refactor: cli uses shared claude-monitor helpers"
```

---

### Task 6: Stall recovery in `main.js`

Wire detection, backoff, nudge, tray cancel, and the give-up notification into the Electron entry point.

**Files:**
- Modify: `src/main.js` — imports, module state, `startClaude`, `stopClaude`, `updateTray`, the `terminal-input` IPC handler

**Interfaces:**
- Consumes: `detectStall`, `createStallTracker`, `STALL_RESET_MS`, `NUDGE` from Tasks 2-3.
- Produces: no exports; behaviour only.

- [ ] **Step 1: Extend the import and add module state**

Change the Task 4 import line to:

```js
const {
  parseResetTime, detectRateLimit, atRateLimitMenu, resolveClaudeCommand,
  detectStall, createStallTracker, STALL_RESET_MS, NUDGE
} = require('./claude-monitor');
```

Add `Notification` to the electron destructure on line 1:

```js
const { app, Menu, Tray, BrowserWindow, nativeImage, dialog, shell, ipcMain, Notification } = require('electron');
```

Alongside the other module-level `let` declarations (near `let waitMenuConfirmed = false;`), add:

```js
const stallTracker = createStallTracker();
let stallHandled = false;
let retryTimer = null;
let stallResetTimer = null;
```

- [ ] **Step 2: Add the recovery functions**

Insert these above `function startClaude(` in `src/main.js`:

```js
function clearStallTimers() {
  if (retryTimer) clearTimeout(retryTimer);
  if (stallResetTimer) clearTimeout(stallResetTimer);
  retryTimer = null;
  stallResetTimer = null;
}

// Abandon automated recovery. Any explicit user takeover restores a full budget.
function cancelRetry() {
  const wasPending = !!retryTimer;
  clearStallTimers();
  stallTracker.reset();
  stallHandled = false;
  if (wasPending) {
    log('Stall retry cancelled.');
    if (currentState === 'Retrying') setState(terminal ? 'Running' : 'Stopped');
  }
}

function giveUpOnStall(attempts) {
  clearStallTimers();
  stallHandled = false;
  setState('Stalled');
  log(`Stall recovery exhausted after ${attempts} attempts; leaving the session interactive.`);
  if (Notification.isSupported()) {
    new Notification({
      title: 'Claude Resume — recovery failed',
      body: `The session stalled ${attempts + 1} times. It is still open and waiting for you.`,
      icon: iconPath
    }).show();
  }
}

function handleStall() {
  // The stall notice lingers in lastOutput, so latch AND clear the buffer:
  // the latch alone would re-fire the moment it is released.
  stallHandled = true;
  lastOutput = '';

  const decision = stallTracker.onStall();
  if (decision.action === 'give-up') {
    giveUpOnStall(decision.attempts);
    return;
  }

  setState('Retrying');
  log(`Stall detected; retry ${decision.attempt} in ${decision.delayMs / 1000}s.`);
  retryTimer = setTimeout(() => {
    retryTimer = null;
    if (!terminal) {
      log('Session exited during backoff; abandoning stall recovery.');
      stallHandled = false;
      return;
    }
    terminal.write(NUDGE);
    setState('Running');
    stallHandled = false;
    // A quiet interval means the session recovered — restore the full budget.
    stallResetTimer = setTimeout(() => {
      stallResetTimer = null;
      stallTracker.onQuiet();
      log('Session stable; stall retry budget restored.');
    }, STALL_RESET_MS);
  }, decision.delayMs);
}
```

- [ ] **Step 3: Hook detection into the output handler**

In `startClaude`, add the stall check inside `terminal.onData`, immediately after the `lastOutput` assignment and before the `waitMenuConfirmed` check:

```js
    lastOutput = (lastOutput + data).slice(-12000);
    if (!stallHandled && !resetAt && detectStall(lastOutput)) handleStall();
```

The `!resetAt` guard implements the spec's rule: a stall arriving while we are already waiting on a rate-limit reset is ignored, because there is no live session to nudge.

Still in `startClaude`, reset the stall state next to the existing `waitMenuConfirmed = false;` at the top of the function:

```js
  lastOutput = '';
  waitMenuConfirmed = false;
  clearStallTimers();
  stallTracker.reset();
  stallHandled = false;
```

- [ ] **Step 4: Give the rate-limit path precedence**

In `waitForReset`, immediately after the `resetAt = detectedReset;` assignment, add:

```js
  cancelRetry();
```

The rate-limit path kills and respawns the session, which invalidates any pending nudge.

- [ ] **Step 5: Cancel on user input and on stop**

In the IPC handler at the bottom of the file, change:

```js
ipcMain.on('terminal-input', (_event, data) => {
  if (terminal) terminal.write(data);
});
```

to:

```js
ipcMain.on('terminal-input', (_event, data) => {
  cancelRetry();
  if (terminal) terminal.write(data);
});
```

In `stopClaude`, add `clearStallTimers();` and `stallTracker.reset();` next to the existing `clearInterval(countdownTimer)` cleanup.

- [ ] **Step 6: Add the tray item**

In `updateTray`, insert directly after the `Resume now` entry:

```js
    { label: 'Cancel retry', enabled: !!retryTimer, click: cancelRetry },
```

- [ ] **Step 7: Verify**

Run: `node --check src/main.js`
Expected: no output (exit 0).

Run: `npm test`
Expected: PASS — `# pass 16`, `# fail 0`.

Manual check (PTY-driven paths cannot be unit tested): run `npm start`, use **Start Claude**, and paste the literal text `API Error: Response stalled mid-stream.` into the session so it echoes into the buffer. Expect the tray status to read `Retrying` within a second, `Cancel retry` to become enabled, and — if left alone for 30s — `continue` to be typed into the session. Record what you observed in the commit message or the PR body; do not claim this passed without running it.

- [ ] **Step 8: Commit**

```bash
git add src/main.js
git commit -m "feat: recover stalled sessions in the tray app"
```

---

### Task 7: Stall recovery in `claude-resume-cli.js`

Same state machine, expressed through the CLI's notice/state-file protocol.

**Files:**
- Modify: `src/claude-resume-cli.js` — imports, module state, `handleOutput`, `startClaude`, `scheduleResume`, `forwardInput`

**Interfaces:**
- Consumes: `detectStall`, `createStallTracker`, `STALL_RESET_MS`, `NUDGE` from Tasks 2-3.
- Produces: a `stalled` state in `state.json`, shaped `{ state: 'stalled', attempts: <number>, projectDir, updatedAt }`.

- [ ] **Step 1: Extend the import and add module state**

Change the Task 5 import line to:

```js
const {
  parseResetTime, detectRateLimitContext, atRateLimitMenu, resolveClaudeCommand,
  detectStall, createStallTracker, STALL_RESET_MS, NUDGE
} = require('./claude-monitor');
```

Alongside the other module-level `let` declarations (near `let shuttingDown = false;`), add:

```js
const stallTracker = createStallTracker();
let stallHandled = false;
let retryTimer = null;
let stallResetTimer = null;
```

- [ ] **Step 2: Add the recovery functions**

Insert these above `function handleOutput(` in `src/claude-resume-cli.js`:

```js
function clearStallTimers() {
  if (retryTimer) clearTimeout(retryTimer);
  if (stallResetTimer) clearTimeout(stallResetTimer);
  retryTimer = null;
  stallResetTimer = null;
}

function cancelRetry() {
  const wasPending = !!retryTimer;
  clearStallTimers();
  stallTracker.reset();
  stallHandled = false;
  if (wasPending) {
    writeNotice('Stall retry cancelled — you have the session.');
    publish('running');
  }
}

function handleStall() {
  // The notice stays in outputBuffer, so latch AND clear it or the next chunk re-fires.
  stallHandled = true;
  outputBuffer = '';

  const decision = stallTracker.onStall();
  if (decision.action === 'give-up') {
    clearStallTimers();
    stallHandled = false;
    publish('stalled', { attempts: decision.attempts });
    writeNotice(`Recovery failed after ${decision.attempts} attempts. The session is still open — take it from here.`);
    return;
  }

  publish('retrying', { attempt: decision.attempt, delayMs: decision.delayMs });
  writeNotice(`Response stalled. Retry ${decision.attempt} of 3 in ${decision.delayMs / 1000}s. Press any key to cancel.`);
  retryTimer = setTimeout(() => {
    retryTimer = null;
    if (!child) {
      stallHandled = false;
      return;
    }
    child.write(NUDGE);
    publish('running');
    stallHandled = false;
    stallResetTimer = setTimeout(() => {
      stallResetTimer = null;
      stallTracker.onQuiet();
    }, STALL_RESET_MS);
  }, decision.delayMs);
}
```

- [ ] **Step 3: Hook detection into `handleOutput`**

In `handleOutput`, add immediately after the `outputBuffer` assignment and before the `waitMenuConfirmed` check:

```js
  outputBuffer = (outputBuffer + data).slice(-24000);
  if (!stallHandled && !resetAt && detectStall(outputBuffer)) handleStall();
```

- [ ] **Step 4: Reset stall state on each spawn, and yield to the rate-limit path**

In `startClaude`, alongside the existing resets at the top of the function:

```js
  outputBuffer = '';
  waitMenuConfirmed = false;
  rateLimitContext = false;
  clearStallTimers();
  stallTracker.reset();
  stallHandled = false;
```

In `scheduleResume`, immediately after the `resetAt = time;` assignment, add:

```js
  cancelRetry();
```

- [ ] **Step 5: Cancel on any keystroke**

Change `forwardInput`:

```js
function forwardInput(data) {
  cancelRetry();
  if (child) child.write(data);
}
```

- [ ] **Step 6: Verify**

Run: `node --check src/claude-resume-cli.js`
Expected: no output (exit 0).

Run: `npm test`
Expected: PASS — `# pass 16`, `# fail 0`.

Manual check: run `node src/claude-resume-cli.js` in a project directory and echo the stall notice into the session. Expect the cyan `[Claude Resume] Response stalled. Retry 1 of 3 in 30s.` notice, `state.json` to read `"state": "retrying"`, and a keystroke to cancel it. Report what you actually saw.

- [ ] **Step 7: Commit**

```bash
git add src/claude-resume-cli.js
git commit -m "feat: recover stalled sessions in the cli wrapper"
```

---

## Done when

- `npm test` reports 16 passing, 0 failing.
- `node --check` passes on all three files in `src/`.
- No detection predicate is defined in more than one place.
- Both entry points have been manually exercised against a simulated stall, with the observed behaviour written down.
