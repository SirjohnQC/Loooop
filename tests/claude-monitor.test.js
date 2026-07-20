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
