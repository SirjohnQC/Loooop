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
  const previous = process.env.LOOOOP_CLAUDE_PATH;
  process.env.LOOOOP_CLAUDE_PATH = 'C:\\custom\\claude.exe';
  try {
    assert.equal(monitor.resolveClaudeCommand(), 'C:\\custom\\claude.exe');
  } finally {
    if (previous === undefined) delete process.env.LOOOOP_CLAUDE_PATH;
    else process.env.LOOOOP_CLAUDE_PATH = previous;
  }
});

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
