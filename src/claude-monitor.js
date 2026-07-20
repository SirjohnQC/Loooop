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

const STALL_RE = /API Error: Response stalled mid-stream/i;

function detectStall(text) {
  return STALL_RE.test(text);
}

const BACKOFF_MS = [30_000, 120_000, 300_000];
const STALL_RESET_MS = 300_000;
const NUDGE = 'continue\r';

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
