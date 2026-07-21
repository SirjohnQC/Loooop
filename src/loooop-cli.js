#!/usr/bin/env node

// Run this wrapper from the project directory instead of invoking `claude`
// directly. It keeps the normal terminal experience while supervising Claude's
// rate-limit prompt and restarting the current project session at reset time.
const path = require('path');
const fs = require('fs');
const pty = require('node-pty');
const {
  parseResetTime, detectRateLimitContext, atRateLimitMenu, resolveClaudeCommand,
  detectStall, createStallTracker, STALL_RESET_MS, NUDGE
} = require('./claude-monitor');

const projectDir = process.cwd();
const stateDir = path.join(process.env.APPDATA || process.env.LOCALAPPDATA || projectDir, 'loooop');
const stateFile = path.join(stateDir, 'state.json');
let child = null;
let outputBuffer = '';
let resetAt = null;
let waitMenuConfirmed = false;
let rateLimitContext = false;
let resumeAfterExit = false;
let shuttingDown = false;

const stallTracker = createStallTracker();
let stallHandled = false;
let retryTimer = null;
let stallResetTimer = null;
let stalledNotified = false;

function publish(state, details = {}) {
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(stateFile, JSON.stringify({ state, projectDir, updatedAt: new Date().toISOString(), ...details }, null, 2));
}

function writeNotice(message) {
  process.stdout.write(`\r\n\x1b[36m[Loooop] ${message}\x1b[0m\r\n`);
}

function scheduleResume(time) {
  if (resetAt || !time) return;
  resetAt = time;
  // The rate-limit path takes precedence and will respawn the session, so cancel
  // any pending nudge and reset the stall machine (clears timers, tracker budget,
  // latch and the give-up flag) before the wait is published.
  cancelRetry();
  const delay = Math.max(0, resetAt.getTime() - Date.now()) + 5000;
  publish('waiting', { resetAt: resetAt.toISOString() });
  writeNotice(`Limit reset detected. I will resume this project at ${resetAt.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}.`);
  setTimeout(resumeSession, delay);
}

function clearStallTimers() {
  if (retryTimer) clearTimeout(retryTimer);
  if (stallResetTimer) clearTimeout(stallResetTimer);
  retryTimer = null;
  stallResetTimer = null;
}

// Abandon automated recovery. Runs on every keystroke via forwardInput, so it
// must stay cheap and side-effect-free when nothing was pending.
function cancelRetry() {
  const wasPending = !!retryTimer;
  const wasStalled = stalledNotified;
  clearStallTimers();
  stallTracker.reset();
  stallHandled = false;
  stalledNotified = false;
  // Only a genuinely pending retry latched a stall notice into outputBuffer;
  // guarding the clear (and the notice) on wasPending avoids wiping a mid-repaint
  // rate-limit-menu buffer on a stray keypress.
  if (wasPending) {
    outputBuffer = '';
    writeNotice('Stall retry cancelled — you have the session.');
  }
  // `stalled` is terminal for automation but not for the session: any keystroke
  // means the user took over, so return a live session to `running` from either
  // `retrying` or `stalled` — independent of wasPending.
  if (wasPending || wasStalled) publish(child ? 'running' : 'stopped');
}

function handleStall() {
  // Any timer still pending from an earlier stall belongs to a superseded
  // recovery. Clear FIRST — before latching — so no handle is orphaned by a
  // re-arm and no stray onQuiet() resets the budget mid-recovery.
  clearStallTimers();
  // The stall notice lingers in outputBuffer, so latch AND empty it: the latch
  // alone would re-fire the instant it is released.
  stallHandled = true;
  outputBuffer = '';

  const decision = stallTracker.onStall();
  if (decision.action === 'give-up') {
    clearStallTimers();
    stallHandled = false;
    outputBuffer = '';
    // Notify once, on the transition into `stalled`: once the budget is spent
    // every later stall notice lands here and an unguarded notice becomes a storm.
    if (!stalledNotified) {
      stalledNotified = true;
      publish('stalled', { attempts: decision.attempts });
      writeNotice(`Recovery failed after ${decision.attempts} attempts. The session is still open — take it from here.`);
    }
    return;
  }

  publish('retrying', { attempt: decision.attempt, delayMs: decision.delayMs });
  writeNotice(`Response stalled. Retry ${decision.attempt} of 3 in ${decision.delayMs / 1000}s. Press any key to cancel.`);
  retryTimer = setTimeout(() => {
    retryTimer = null;
    if (!child) {
      stallHandled = false;
      outputBuffer = '';
      return;
    }
    child.write(NUDGE);
    publish('running');
    stallHandled = false;
    // The nudge's own echo is the next chunk; start from an empty buffer so it
    // cannot re-match the stall notice this retry was raised for.
    outputBuffer = '';
    // A quiet interval means the session recovered — restore the full budget.
    stallResetTimer = setTimeout(() => {
      stallResetTimer = null;
      stallTracker.onQuiet();
    }, STALL_RESET_MS);
  }, decision.delayMs);
}

function handleOutput(data) {
  process.stdout.write(data);
  outputBuffer = (outputBuffer + data).slice(-24000);

  if (!waitMenuConfirmed && atRateLimitMenu(outputBuffer)) {
    waitMenuConfirmed = true;
    rateLimitContext = true;
    publish('confirming-wait');
    writeNotice('Rate-limit menu detected. Confirming “Stop and wait for limit to reset”.');
    setTimeout(() => child?.write('\r'), 250);
  }

  if (detectRateLimitContext(outputBuffer)) rateLimitContext = true;
  const detectedReset = rateLimitContext ? parseResetTime(outputBuffer) : null;
  if (detectedReset) scheduleResume(detectedReset);

  // Last: scheduleResume sets resetAt, so a chunk carrying both a stall notice
  // and rate-limit text gives the rate-limit path precedence via the !resetAt
  // guard, which also ignores a stall seen while waiting on a reset (no live
  // session to nudge).
  if (!stallHandled && !resetAt && detectStall(outputBuffer)) handleStall();
}

function startClaude(args = []) {
  outputBuffer = '';
  waitMenuConfirmed = false;
  rateLimitContext = false;
  clearStallTimers();
  stallTracker.reset();
  stallHandled = false;
  stalledNotified = false;
  const command = resolveClaudeCommand();
  child = pty.spawn(command, args, {
    name: process.env.TERM || 'xterm-256color',
    cols: process.stdout.columns || 120,
    rows: process.stdout.rows || 36,
    cwd: projectDir,
    env: process.env
  });
  publish('running');
  child.onData(handleOutput);
  child.onExit(({ exitCode }) => {
    child = null;
    // Abandon any in-flight recovery: it belongs to the session that just died,
    // so a pending stallResetTimer cannot fire onQuiet() against a dead session
    // or leak into the next one.
    clearStallTimers();
    stallHandled = false;
    if (shuttingDown) return process.exit(exitCode || 0);
    if (resumeAfterExit) {
      resumeAfterExit = false;
      startClaude(['--continue']);
      return;
    }
    if (resetAt) {
      publish('waiting', { resetAt: resetAt.toISOString() });
      return;
    }
    publish('stopped', { exitCode });
    process.exit(exitCode || 0);
  });
}

function resumeSession() {
  resetAt = null;
  publish('resuming');
  writeNotice('Usage limit should be reset. Resuming the most recent Claude session in this project.');
  if (child) {
    resumeAfterExit = true;
    child.kill();
  } else {
    startClaude(['--continue']);
  }
}

function forwardInput(data) {
  cancelRetry();
  if (child) child.write(data);
}

process.stdin.setRawMode?.(true);
process.stdin.resume();
process.stdin.on('data', forwardInput);
process.on('SIGINT', () => {
  shuttingDown = true;
  if (child) child.kill();
  else process.exit(0);
});

publish('starting');
startClaude(process.argv.slice(2));
