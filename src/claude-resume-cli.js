#!/usr/bin/env node

// Run this wrapper from the project directory instead of invoking `claude`
// directly. It keeps the normal terminal experience while supervising Claude's
// rate-limit prompt and restarting the current project session at reset time.
const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');
const pty = require('node-pty');

const projectDir = process.cwd();
const stateDir = path.join(process.env.APPDATA || process.env.LOCALAPPDATA || projectDir, 'claude-resume');
const stateFile = path.join(stateDir, 'state.json');
let child = null;
let outputBuffer = '';
let resetAt = null;
let waitMenuConfirmed = false;
let rateLimitContext = false;
let resumeAfterExit = false;
let shuttingDown = false;

function publish(state, details = {}) {
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(stateFile, JSON.stringify({ state, projectDir, updatedAt: new Date().toISOString(), ...details }, null, 2));
}

function writeNotice(message) {
  process.stdout.write(`\r\n\x1b[36m[Claude Resume] ${message}\x1b[0m\r\n`);
}

function parseResetTime(text) {
  const match = text.match(/(?:reset|resets|available)[^\n\r]*?(\d{1,2}:\d{2})\s*(am|pm)?/i);
  if (!match) return null;

  let [hours, minutes] = match[1].split(':').map(Number);
  const meridiem = match[2]?.toLowerCase();
  if (meridiem === 'pm' && hours < 12) hours += 12;
  if (meridiem === 'am' && hours === 12) hours = 0;

  const target = new Date();
  target.setHours(hours, minutes, 0, 0);
  if (target <= new Date()) target.setDate(target.getDate() + 1);
  return target;
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

function scheduleResume(time) {
  if (resetAt || !time) return;
  resetAt = time;
  const delay = Math.max(0, resetAt.getTime() - Date.now()) + 5000;
  publish('waiting', { resetAt: resetAt.toISOString() });
  writeNotice(`Limit reset detected. I will resume this project at ${resetAt.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}.`);
  setTimeout(resumeSession, delay);
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

  if (/rate\s*limit|usage\s*limit|limit\s+(?:to\s+)?reset/i.test(outputBuffer)) rateLimitContext = true;
  const detectedReset = rateLimitContext ? parseResetTime(outputBuffer) : null;
  if (detectedReset) scheduleResume(detectedReset);
}

function startClaude(args = []) {
  outputBuffer = '';
  waitMenuConfirmed = false;
  rateLimitContext = false;
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
