const { app, Menu, Tray, BrowserWindow, nativeImage, dialog, shell, ipcMain, Notification } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');
const pty = require('node-pty');
const {
  parseResetTime, detectRateLimit, atRateLimitMenu, resolveClaudeCommand,
  detectStall, createStallTracker, STALL_RESET_MS, NUDGE
} = require('./claude-monitor');

let tray;
let terminalWindow;
let terminal;
let currentState = 'Stopped';
let resetAt = null;
let countdownTimer;
let lastOutput = '';
let waitMenuConfirmed = false;
const stallTracker = createStallTracker();
let stallHandled = false;
let retryTimer = null;
let stallResetTimer = null;
const logFile = path.join(app.getPath('userData'), 'claude-resume.log');
const favoritesFile = path.join(app.getPath('userData'), 'favorite-projects.json');
const iconPath = path.join(__dirname, '..', 'assets', 'claude-resume.png');
let favoriteProjects = [];

function log(message) {
  const line = `[${new Date().toISOString()}] ${message}\n`;
  fs.appendFileSync(logFile, line);
  console.log(message);
}

function setState(state) {
  currentState = state;
  updateTray();
}

function waitForReset(text) {
  if (resetAt) return;
  const detectedReset = parseResetTime(text);
  if (!detectedReset) return;
  resetAt = detectedReset;
  cancelRetry();
  setState('Waiting');
  log(`Rate limit detected; waiting until ${resetAt.toISOString()}`);
  countdownTimer = setInterval(() => {
    if (Date.now() >= resetAt.getTime()) {
      clearInterval(countdownTimer);
      countdownTimer = null;
      resetAt = null;
      resumeSession();
    } else {
      updateTray();
    }
  }, 1000);
}

function resumeSession() {
  if (terminal) {
    try { terminal.kill(); } catch (_) {}
    terminal = null;
  }
  log('Resuming the most recent Claude Code session.');
  startClaude(['--continue']);
}

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
  // Releasing the latch without emptying the buffer would let a repainted stall
  // notice re-trigger detection on the very next chunk.
  lastOutput = '';
  if (wasPending) log('Stall retry cancelled.');
  // `Stalled` is terminal for automation but not for the session: user input
  // returns a live session to `Running`, so this must not depend on wasPending.
  if (currentState === 'Retrying' || currentState === 'Stalled') {
    setState(terminal ? 'Running' : 'Stopped');
  } else if (wasPending) {
    // A pending retry was dropped without a state change; refresh `Cancel retry`.
    updateTray();
  }
}

function giveUpOnStall(attempts) {
  clearStallTimers();
  stallHandled = false;
  lastOutput = '';
  log(`Stall recovery exhausted after ${attempts} attempts; leaving the session interactive.`);
  // Notify only on the transition into Stalled: once the budget is spent every
  // later stall notice lands here, and an unguarded toast becomes a storm.
  if (currentState !== 'Stalled' && Notification.isSupported()) {
    new Notification({
      title: 'Claude Resume — recovery failed',
      body: `The session stalled ${attempts + 1} times. It is still open and waiting for you.`,
      icon: iconPath
    }).show();
  }
  setState('Stalled');
}

function handleStall() {
  // Any timer still pending from an earlier stall belongs to a superseded
  // recovery. Clear before latching so no handle is orphaned by a re-arm.
  clearStallTimers();
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
      lastOutput = '';
      updateTray();
      return;
    }
    terminal.write(NUDGE);
    setState('Running');
    stallHandled = false;
    // The nudge's own echo is the next chunk; start from an empty buffer so it
    // cannot re-match the stall notice this retry was raised for.
    lastOutput = '';
    // A quiet interval means the session recovered — restore the full budget.
    stallResetTimer = setTimeout(() => {
      stallResetTimer = null;
      stallTracker.onQuiet();
      log('Session stable; stall retry budget restored.');
    }, STALL_RESET_MS);
  }, decision.delayMs);
}

function startClaude(args = []) {
  if (terminal) {
    dialog.showMessageBox({ type: 'info', message: 'Claude Resume is already running.' });
    return;
  }
  const shellName = process.env.ComSpec || 'powershell.exe';
  const command = resolveClaudeCommand();
  lastOutput = '';
  waitMenuConfirmed = false;
  clearStallTimers();
  stallTracker.reset();
  stallHandled = false;
  openTerminalWindow();
  terminal = pty.spawn(command, args, {
    name: 'xterm-color',
    cols: 120,
    rows: 36,
    cwd: process.env.CLAUDE_RESUME_PROJECT || process.cwd(),
    env: process.env
  });
  setState('Running');
  log(`Started ${command} ${args.join(' ')}`);
  terminal.onData((data) => {
    if (terminalWindow && !terminalWindow.isDestroyed()) terminalWindow.webContents.send('terminal-data', data);
    lastOutput = (lastOutput + data).slice(-12000);
    if (!waitMenuConfirmed && atRateLimitMenu(lastOutput)) {
      waitMenuConfirmed = true;
      log('Rate-limit menu detected; confirming “Stop and wait for limit to reset”.');
      setTimeout(() => terminal?.write('\r'), 250);
    }
    if (detectRateLimit(lastOutput)) waitForReset(lastOutput);
    // Last: waitForReset sets resetAt, so a chunk carrying both signals gives
    // the rate-limit path precedence via this guard.
    if (!stallHandled && !resetAt && detectStall(lastOutput)) handleStall();
  });
  terminal.onExit(({ exitCode }) => {
    log(`Claude exited with code ${exitCode}`);
    terminal = null;
    // Abandon any in-flight recovery: it belongs to the session that just died.
    clearStallTimers();
    stallHandled = false;
    if (!resetAt) setState('Stopped');
  });
}

function openTerminalWindow() {
  if (terminalWindow && !terminalWindow.isDestroyed()) {
    terminalWindow.show();
    return;
  }
  terminalWindow = new BrowserWindow({
    width: 1100,
    height: 700,
    title: 'Claude Resume',
    icon: iconPath,
    backgroundColor: '#101114',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false }
  });
  terminalWindow.loadFile(path.join(__dirname, 'terminal.html'));
  terminalWindow.on('closed', () => { terminalWindow = null; });
}

function loadFavoriteProjects() {
  try {
    const entries = JSON.parse(fs.readFileSync(favoritesFile, 'utf8'));
    favoriteProjects = [...new Set(entries.filter((entry) => typeof entry === 'string' && fs.existsSync(entry)))];
  } catch (_) {
    favoriteProjects = [];
  }
}

function saveFavoriteProjects() {
  fs.writeFileSync(favoritesFile, JSON.stringify(favoriteProjects, null, 2));
}

function startProjectTerminal(projectDir) {
  const wrapper = path.join(__dirname, 'claude-resume-cli.js');
  const command = `node "${wrapper}"`;
  const options = { detached: true, stdio: 'ignore', windowsHide: false };
  const terminal = spawn('wt.exe', ['-d', projectDir, 'cmd.exe', '/k', command], options);
  terminal.on('error', () => {
    const fallback = spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/k', `cd /d "${projectDir}" && ${command}`], options);
    fallback.unref();
  });
  terminal.unref();
  log(`Opened Claude Resume terminal for ${projectDir}`);
}

async function chooseProjectFolder(title, buttonLabel) {
  const { canceled, filePaths } = await dialog.showOpenDialog({ title, buttonLabel, properties: ['openDirectory'] });
  return canceled ? null : filePaths[0] || null;
}

async function startInProjectFolder() {
  const projectDir = await chooseProjectFolder('Choose the project folder for Claude Resume', 'Start Claude Resume here');
  if (projectDir) startProjectTerminal(projectDir);
}

async function addFavoriteProject() {
  const projectDir = await chooseProjectFolder('Choose a project to add to Favorites', 'Add to Favorites');
  if (!projectDir || favoriteProjects.includes(projectDir)) return;
  favoriteProjects.push(projectDir);
  favoriteProjects.sort((a, b) => path.basename(a).localeCompare(path.basename(b)));
  saveFavoriteProjects();
  updateTray();
  log(`Added favorite project ${projectDir}`);
}

function removeFavoriteProject(projectDir) {
  favoriteProjects = favoriteProjects.filter((entry) => entry !== projectDir);
  saveFavoriteProjects();
  updateTray();
  log(`Removed favorite project ${projectDir}`);
}

function favoriteProjectsMenu() {
  const projects = favoriteProjects.map((projectDir) => ({
    label: path.basename(projectDir) || projectDir,
    toolTip: projectDir,
    click: () => startProjectTerminal(projectDir)
  }));
  const removeItems = favoriteProjects.map((projectDir) => ({
    label: path.basename(projectDir) || projectDir,
    toolTip: projectDir,
    click: () => removeFavoriteProject(projectDir)
  }));

  return [
    ...(projects.length ? projects : [{ label: 'No saved projects yet', enabled: false }]),
    { type: 'separator' },
    { label: 'Add a favorite project', click: addFavoriteProject },
    ...(removeItems.length ? [{ label: 'Remove a favorite', submenu: removeItems }] : [])
  ];
}

function stopClaude() {
  if (countdownTimer) clearInterval(countdownTimer);
  countdownTimer = null;
  clearStallTimers();
  stallTracker.reset();
  resetAt = null;
  if (terminal) {
    terminal.kill();
    terminal = null;
  }
  setState('Stopped');
  log('Stopped by user.');
}

function formatStatus() {
  if (currentState !== 'Waiting' || !resetAt) return currentState;
  const seconds = Math.max(0, Math.ceil((resetAt - Date.now()) / 1000));
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return `Waiting ${h ? `${h}h ` : ''}${m}m ${s}s`;
}

function updateTray() {
  if (!tray) return;
  tray.setToolTip(`Claude Resume — ${formatStatus()}`);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: `Status: ${formatStatus()}`, enabled: false },
    { type: 'separator' },
    { label: 'Favorite projects', submenu: favoriteProjectsMenu() },
    { label: 'Start in project folder…', click: startInProjectFolder },
    { label: 'Start Claude', click: () => startClaude() },
    { label: 'Open terminal', click: openTerminalWindow },
    { label: 'Resume now', enabled: currentState === 'Waiting', click: resumeSession },
    { label: 'Cancel retry', enabled: !!retryTimer, click: cancelRetry },
    { label: 'Stop', enabled: !!terminal, click: stopClaude },
    { type: 'separator' },
    { label: 'Open log', click: () => shell.openPath(logFile) },
    { label: 'Quit', click: () => { stopClaude(); app.quit(); } }
  ]));
}

app.whenReady().then(() => {
  loadFavoriteProjects();
  const icon = nativeImage.createFromPath(iconPath);
  tray = new Tray(icon);
  updateTray();
  tray.on('click', updateTray);
});

ipcMain.on('terminal-input', (_event, data) => {
  cancelRetry();
  if (terminal) terminal.write(data);
});

app.on('window-all-closed', (event) => event.preventDefault());
