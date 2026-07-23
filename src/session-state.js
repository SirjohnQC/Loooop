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
