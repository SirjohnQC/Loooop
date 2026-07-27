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

test('aggregateStatus: string embedded form with no sessions', () => {
  const d = aggregateStatus('running', []);
  assert.equal(d.state, 'running');
  assert.equal(d.projectName, null);
  assert.equal(d.count, 1);
});

test('aggregateStatus: confirming-wait outranks resuming; running outranks starting', () => {
  const a = aggregateStatus(null, [
    { state: 'resuming', projectDir: 'C:\\x\\R' },
    { state: 'confirming-wait', projectDir: 'C:\\x\\C' }
  ]);
  assert.equal(a.state, 'confirming-wait');
  const b = aggregateStatus(null, [
    { state: 'starting', projectDir: 'C:\\x\\S' },
    { state: 'running', projectDir: 'C:\\x\\U' }
  ]);
  assert.equal(b.state, 'running');
});
