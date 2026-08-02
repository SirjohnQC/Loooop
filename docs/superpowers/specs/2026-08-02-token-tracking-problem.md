# Loooop — Token tracking: verified constraints and open problems

Date: 2026-08-02
Status: **Not a design. Needs a design pass before implementation.**

A combined settings + token-tracking design was drafted and reviewed on
2026-08-02. Review found four independent defects that each make the displayed
number wrong, plus one that means it would never display at all. Rather than
patch a design built on wrong premises, the settings work was split out
(`2026-08-02-settings-window-design.md`) and the token work reduced to this: what
is verified true, and what must be decided.

## Goal

Notify when a Claude Code session is burning tokens heavily, so a rate limit can
be anticipated rather than discovered.

## Verified constraints

Measured on this machine, 2026-08-02, Claude Code v2.1.220. These are facts, not
assumptions — re-verify only if the Claude Code version changes materially.

### Nothing exposes subscription limit state to a supervisor

- No rate-limit or reset keys are persisted anywhere under `~/.claude`
  (`resetsAt`, `unified_rate_limit`, `five_hour`, `seven_day`, `utilization` all
  return nothing).
- `stats-cache.json` holds only `messageCount` / `sessionCount` / `toolCallCount`
  per day. No tokens, no limits.
- There is no `claude usage` subcommand. `/usage` is TUI-only, so a supervisor
  cannot invoke it non-interactively.
- The `anthropic-ratelimit-*` and `retry-after` HTTP headers are unreachable —
  Loooop supervises the `claude` binary and never sees the HTTP layer.
- Claude cannot report its own usage. `message.usage` is a field on the API
  response returned to the caller; the model never sees it.

**Therefore:** any token feature is a *consumption trend*, never a percentage of a
limit, and the UI must not imply otherwise. The reset time Claude prints to the
terminal remains the only authoritative limit signal, and `planLimitWait` already
parses it.

### The usage data is real and free to read

Claude Code writes each assistant message — including the API response's `usage`
object verbatim — to `~/.claude/projects/<slug>/<session-uuid>.jsonl`. Reading it
costs no tokens and does not involve the model.

## Open problems

Each of these must be resolved before implementation. They are ordered by how
badly they corrupt the number.

### P1 — One API response writes many JSONL lines

Claude Code writes one `assistant` line **per content block** (text, each
`tool_use`), and every line repeats the **same** `usage` object verbatim.

Measured in `afa24e74-….jsonl`: **111 usage-bearing lines, 48 unique
`message.id`** — a 2.3–2.8× overcount if summed per line.

Repeats were observed contiguous (0 non-contiguous), so `lastCountedId` is
probably sufficient, but a bounded LRU set is the safe form. **Deduplication must
be part of the parser's contract and its tests.**

### P2 — Cache expiry spikes the metric on exactly the event Loooop causes

The obvious metric (`input + cache_creation + output`, excluding `cache_read`) has
a specific failure mode.

With prompt caching in steady state, `input_tokens` is 1–2 and the resent
conversation lands in `cache_read_input_tokens`:

```
in   cacheCreate  cacheRead   out
 2        1612      31771    312
 2         576      61762    168
 2         413      82118    243
```

But when the cache TTL expires, the **entire prefix** is rewritten into
`cache_creation_input_tokens`, which the metric includes. Requests following an
idle gap, from `884b6b22-….jsonl`:

```
gap  9,388s   cacheCreate  44,670
gap 35,618s   cacheCreate  79,857
gap 69,770s   cacheCreate 110,731
gap 88,347s   cacheCreate 187,625   ← one request
```

Steady-state is 400–3,000.

**Loooop's entire purpose is to wait out a limit and then resume**, so every
resume is by definition a cache-expiry event. The burn total would jump by a full
context on a session that has done no work — and combined with P1, one resume
alone is roughly 500k of apparent "burn".

Candidate approaches: treat `cache_creation` as re-creation rather than new burn
when `cache_read === 0`; or use `output + input + delta(cache_creation)` with
spike suppression. Undecided.

### P3 — Usage would never reach the tray

The draft assumed usage could ride existing `publish()` calls. It cannot: in a
session that never stalls and never hits a limit, `publish()` fires **twice** —
`'starting'` (`loooop-cli.js:255`) and `'running'` (line 184). Everything else is
gated on stall, limit, or `cancelRetry()`'s `wasPending || wasStalled`.

So the tail loop must publish on its own cadence, which reopens the question the
draft claimed to have avoided: N wrappers writing periodically, each write firing
the tray's `fs.watch` → full `readdirSync` + parse + `process.kill(pid, 0)` per
session. A throttle (publish at most every 30 s, and only when the total changed)
is the obvious answer but must be specified and measured.

This also makes two pre-existing hazards load-bearing:

- **`publish()` is not atomic** — `fs.writeFileSync` truncates to 0 first, and
  `readSessions()` silently drops a session on a torn read (`main.js:353`).
  Harmless at twice per session; not at N per minute per project.
- **`sessionKey()` keys on directory, not process** — two wrappers in one project
  share a session file and delete each other's. Fix: `<key>-<pid>.json`, tray
  groups by `projectDir`.

### P4 — Locating the transcript

The draft computed a slug (`: \ /` → `-`) and matched case-insensitively. Both
parts are wrong:

```
C--Users-Sirjohn--claude-mem-observer-sessions  ⇐ C:\Users\Sirjohn\.claude-mem\observer-sessions
C--Users-Sirjohn-Documents-Claude-Resume        ⇐ C:\Users\Sirjohn\Documents\Claude Resume
```

Dots and spaces convert too — the rule is closer to "every non-alphanumeric →
`-`". And it is **lossy**: `Claude Resume` and `Claude-Resume` collapse to one
directory, silently merging two projects' totals.

**Better mechanism, verified available:** `claude --session-id <uuid>` is a real
CLI flag. The wrapper can mint the UUID and pass it on spawn, then knows the
transcript path exactly — removing the slug computation, the case problem, and the
mtime race together. Caveat: do not inject it when the user passed
`--continue`/`--resume` in `process.argv.slice(2)`.

Secondary, undocumented, usable only as a cross-check: `~/.claude/sessions/<pid>.json`
maps pid → `sessionId` → `cwd`, and the wrapper has `child.pid` from node-pty.

### P5 — Tail mechanics

The draft's re-selection trigger rested on a false premise: **`--continue`
appends to the same file.** `884b6b22-….jsonl` carries one `sessionId` spanning
2026-07-22 → 2026-07-27 across many resumes. (`--fork-session` is what mints a new
ID.) Unspecified and needed:

- **Initial byte offset.** At wrapper startup the newest `.jsonl` is the *previous*
  session's file. Offset 0 attributes a week-old transcript to this session;
  EOF is right for `--continue` but must reset to 0 when a genuinely new file is
  selected.
- **`size < storedOffset`** (truncation or re-selection to a shorter file) is
  unhandled — reads garbage or nothing, permanently.
- **Whether accumulated usage carries over or resets** on re-selection, and on
  `startClaude(['--continue'])` re-spawn (`loooop-cli.js:194`).
- **Partial UTF-8 across a read boundary.** The draft buffered partial *lines* but
  not partial *multibyte characters*: 2,376 non-ASCII bytes in 801 KB means roughly
  one corruption per ~700 read boundaries, and an 8-hour session at 30 s polling
  does ~960 reads. A split character becomes `U+FFFD` in both halves, unrecoverable
  at string level, and the line silently fails `JSON.parse`. Use
  `string_decoder.StringDecoder`, or keep the residual as a **Buffer** and concat
  at byte level.
- **Directory entries are not all files** — the slug dir contains `memory/` and
  per-session `<uuid>/` subdirectories. Use `readdirSync(dir, {withFileTypes:true})`.
- **Max observed line length is 34 KB.** Fine, but cap the buffer so a pathological
  line without a newline cannot grow unbounded.

### P6 — Subagent burn is invisible

Subagent transcripts live in `<slug>/<session-uuid>/subagents/agent-*.jsonl`, not
the top-level directory. In one session that is a 210 KB transcript contributing
nothing.

This is a systematic **under**count running opposite to P1's **over**count; they
do not cancel predictably. Either include `subagents/*.jsonl` in the tail set, or
state the exclusion explicitly so the UI wording stays honest.

### P7 — Threshold lifecycle

Undefined in the draft: what the latch is keyed on (filename and `projectDir` are
both stable across `--continue`, so the latch would persist across exactly the
resume that spikes the total per P2); whether the accumulator resets on resume;
that the tray itself deletes stale session files (`main.js:358`) so "file
disappeared" does not distinguish a clean exit from a transient pid-check failure;
and that an in-memory latch re-fires for every over-threshold session on tray
restart.

## Also worth noting

`~/.claude/sessions/<pid>.json` carries a `status` field (`"busy"` and similar).
If that proves reliable it is a cleaner stall signal than regex-matching terminal
paint, and worth evaluating against `detectStall()` independently of token work.

`CLAUDE_CONFIG_DIR` relocates `~/.claude`; any implementation must honour it
rather than hardcoding the path.
