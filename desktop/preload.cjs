// Bridge between the OCTA page (served by this computer's own server) and the desktop app.
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('octaDesktop', {
  isDesktop: true,
  version: () => ipcRenderer.invoke('octa:version'),
  call: (path, body) => ipcRenderer.invoke('octa:desk', path, body),   // this-computer features: status, install AI, autostart, phone remote…
  show: () => ipcRenderer.invoke('octa:show'),   // bring the window forward (notification clicked)
  focusBot: id => ipcRenderer.invoke('octa:focus-bot', id || ''),   // only this bot's browser stays on screen
  dock: rect => ipcRenderer.invoke('octa:dock', rect || null),   // 4.1: the work panel's 瀏覽器 area {x, y, width, height, bot, theme} (CSS px); null hides the browser
  onStage: cb => ipcRenderer.on('octa:stage', (_e, d) => cb(d)),
  control: (id, on) => ipcRenderer.invoke('octa:control', String(id || ''), !!on),   // the chat's 接手/繼續 also flips the browser's watch-only switch
  cover: on => ipcRenderer.invoke('octa:cover', !!on),   // a dialog is open: the bot's browser steps aside
  pip: () => ipcRenderer.invoke('octa:pip'),   // where the bot's corner card is now ({mode, dot, x, y, width, height} or null)
  onPip: cb => ipcRenderer.on('octa:pip', (_e, d) => cb(d)),
  // 3.x cloud users: their data is moved here on the first 4.0 start; if that failed, settings can retry
  cloudImport: {
    status: () => ipcRenderer.invoke('octa:cloud-import-status'),   // {state: none|pending|running|failed|done, at, error, counts, backup}
    run: () => ipcRenderer.invoke('octa:cloud-import'),   // → {ok, counts, backup} or {ok: false, error}; the page reloads on success
    onProgress: cb => ipcRenderer.on('octa:cloud-import-progress', (_e, d) => cb(d))   // {p: 0–100, text}
  },
  update: {
    status: () => ipcRenderer.invoke('octa:update-status'),
    check: () => ipcRenderer.invoke('octa:update-check'),
    download: () => ipcRenderer.invoke('octa:update-download'),
    install: () => ipcRenderer.invoke('octa:update-install'),
    onChange: cb => ipcRenderer.on('octa:update', (_e, u) => cb(u))
  }
});
