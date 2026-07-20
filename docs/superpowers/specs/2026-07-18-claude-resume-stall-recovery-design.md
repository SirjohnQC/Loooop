# Claude Resume — Stall Recovery Design

Date: 2026-07-18
Status: Approved, pending implementation plan

## Background

Claude Code intermittently aborts a turn with:

```
API Error: Response stalled mid-stream. The response above may be incomplete.
```

Investigation on 2026-07-18 against `Project-Vigil` established the failure shape from
proxy logs and session transcripts:

- Time-to-first-byte is healthy (1.4–4s) and the HTTP response is 200.
- The stream then delivers ~118–896 output tokens over 304–398 seconds
  (≈0.4–2 tok/s) before terminating without a `message_delta` usage block.
- Healthy long turns for comparison: 104–269s at 7,500–20,900 tokens (≈70–80 tok/s).

Two candidate causes were ruled out by the data:

- **Request size.** A 52,982-token turn completed in 6s; a 54,146-token turn seven
  minutes later took 382s. Near-identical payloads, 60x difference. Size does not
  predict the stall.
- **The local Headroom proxy.** 468 Opus turns from 07-09 to 07-17 routed through it
  with zero stalls, and the binary was unchanged since 06-29.

What does correlate is *when* the request went out, alongside an explicit
`429 rate_limit_error` on the same account and model that day. The conclusion is
transient upstream capacity — time-varying and payload-independent.

**The practical remedy is therefore to retry.** That is what this feature automates.

## Goals

Detect a stalled turn and recover it automatically, without user presence, while
keeping the recovery bounded and visible.

## Non-Goals

- **No proxy-log scraping.** Reading Headroom's logs would couple this tool to a
  component we ruled out, and to a setup most users do not run.
- **No configuration mutation.** The `settings.json` bypass performed during the
  investigation was a deliberate one-time A/B test, not a remedy. Automating it would
  silently alter project config to target a cause the evidence does not support.
- **No permission auto-approval.** Out of scope; tracked separately in `IDEA.md`.

## Architecture

### Shared module: `src/claude-monitor.js`

`main.js` and `claude-resume-cli.js` currently duplicate `parseResetTime`,
`detectRateLimit`, `atRateLimitMenu`, and `resolveClaudeCommand` verbatim. Rather than
add a third copy of stall logic, these move into one module that both entry points
import, together with the new stall functions.

Exports:

| Export | Purpose |
|---|---|
| `parseResetTime(text)` | Existing; moved unchanged. |
| `detectRateLimit(text)` | Existing; moved unchanged. |
| `atRateLimitMenu(text)` | Existing; moved unchanged. |
| `resolveClaudeCommand()` | Existing; moved unchanged. |
| `detectStall(text)` | New. Returns `true` when the buffer contains a stall notice. |
| `BACKOFF_MS` | New. `[30_000, 120_000, 300_000]`. |
| `STALL_RESET_MS` | New. `300_000`. |
| `NUDGE` | New. `'continue\r'`. |

The two entry points keep their own state and side effects. The module stays pure:
predicates and constants only, no timers, no I/O. This is what makes it testable
without a PTY.

### Detection

```js
const STALL_RE = /API Error: Response stalled mid-stream/i;
function detectStall(text) { return STALL_RE.test(text); }
```

**Re-fire hazard.** Both entry points retain a trailing output buffer (`lastOutput`,
12,000 chars in `main.js`; `outputBuffer`, 24,000 in the CLI). The stall string
persists in that scrollback, so a naive check re-fires on every subsequent chunk.
This is the same hazard the existing `waitMenuConfirmed` latch guards against.

Mitigation is twofold: a `stallHandled` latch, **and** clearing the output buffer when
a stall is handled. The latch alone is insufficient — it must be released to catch a
later genuine stall, and on release the stale string would still be in the buffer.

### Retry sequence

On detection, with `attempt` starting at 0:

1. Latch, clear the output buffer, set state to `Retrying`, log the attempt.
2. Wait `BACKOFF_MS[attempt]`.
3. If the session is still alive, write `NUDGE` into the PTY. If it has exited, abandon
   recovery and fall through to normal exit handling.
4. Increment `attempt`. Release the latch. Start a `STALL_RESET_MS` timer.
5. If that timer fires without a new stall, reset `attempt` to 0 — the session
   recovered, so a later unrelated stall gets a full budget rather than inheriting a
   spent one.
6. If a new stall arrives first and `attempt` exceeds `BACKOFF_MS.length`, give up.

The nudge is a plain user message into a live session. The stall leaves Claude Code
interactive at its prompt, so no restart and no `--continue` is involved — this is
distinct from the rate-limit path, which waits for a reset time and respawns.

### Give-up

After three failed attempts:

- `main.js`: tray state → `Stalled`; fire an Electron `Notification`. (Notifications
  are listed as desired in `IDEA.md`; this introduces the first one.)
- `claude-resume-cli.js`: `writeNotice(...)` and `publish('stalled', { attempts })`,
  consistent with its existing state-file protocol.

The session is left alive and interactive in both cases. Recovery failed; the session
did not.

### Cancellation

A pending retry must be interruptible.

- `main.js`: a `Cancel retry` tray item, enabled only while a retry is pending. Also
  cancel on user input arriving through the existing `terminal-input` IPC handler.
- `claude-resume-cli.js`: cancel in `forwardInput` — any keystroke clears the pending
  timer, then forwards to the child as normal.

Cancelling clears the timer and resets `attempt` to 0. An explicit user takeover ends
automated recovery entirely.

## State model

`Running → Retrying → Running` on success; `Running → Retrying → Stalled` on
exhaustion. `Stalled` is terminal for automation but not for the session — the user
can type into it, which returns it to `Running`.

## Error handling

- Session exits mid-backoff: abandon the retry, clear timers, fall through to the
  existing `onExit` path.
- Rate-limit menu appears during a pending retry: the rate-limit path takes precedence.
  Cancel the retry, reset `attempt`, and let `waitForReset` handle it — it kills and
  respawns the session, which invalidates any pending nudge.
- Stall detected while already waiting on a rate-limit reset: ignore. No live session
  to nudge.

## Testing

`detectStall` and the backoff/reset schedule are pure and testable without a PTY:

- `detectStall` matches the real notice, is case-insensitive, and does not match
  unrelated `API Error:` text.
- Retry-counter progression: advances across attempts, resets after a stall-free
  interval, gives up on the fourth consecutive stall.
- Buffer clearing prevents a second trigger from retained scrollback.

`package.json` has no test framework. Use node's built-in `node:test` so this adds no
dependency, wired as `npm test`.

PTY-driven paths (nudge delivery, tray and notification side effects) are verified
manually against a real stall or a simulated one.

## Open question

The project is not currently under version control — it has a `.gitignore` but no
`.git`. Initializing a repo before implementation is recommended so this change is
reviewable, but that is the user's call.
