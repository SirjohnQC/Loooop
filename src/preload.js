const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('loooop', {
  onData: (callback) => ipcRenderer.on('terminal-data', (_event, data) => callback(data)),
  write: (data) => ipcRenderer.send('terminal-input', data),
  resize: (size) => ipcRenderer.send('terminal-resize', size)
});
