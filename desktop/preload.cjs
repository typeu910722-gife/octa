// Bridge between the OCTA page (cloud or local) and the desktop app.
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('octaDesktop', {
  isDesktop: true,
  version: () => ipcRenderer.invoke('octa:version'),
  call: (path, body) => ipcRenderer.invoke('octa:desk', path, body),   // this-computer features: status, install AI, autostart…
  connect: webToken => ipcRenderer.invoke('octa:connect', webToken),   // signed in: start this computer's runner for the account
  disconnect: opts => ipcRenderer.invoke('octa:disconnect', opts),   // {keep: true}: sign out but keep working for the account
  working: () => ipcRenderer.invoke('octa:working'),
  show: () => ipcRenderer.invoke('octa:show'),   // bring the window forward (notification clicked)
  focusBot: id => ipcRenderer.invoke('octa:focus-bot', id || ''),   // only this bot's browser stays on screen
  onStage: cb => ipcRenderer.on('octa:stage', (_e, d) => cb(d)),
  cover: on => ipcRenderer.invoke('octa:cover', !!on),   // a dialog is open: the bot's browser steps aside
  pip: () => ipcRenderer.invoke('octa:pip'),   // where the bot's corner card is now ({mode, dot, x, y, width, height} or null)
  onPip: cb => ipcRenderer.on('octa:pip', (_e, d) => cb(d)),
  useOffline: () => ipcRenderer.invoke('octa:offline'),
  useCloud: () => ipcRenderer.invoke('octa:cloud'),
  update: {
    status: () => ipcRenderer.invoke('octa:update-status'),
    check: () => ipcRenderer.invoke('octa:update-check'),
    download: () => ipcRenderer.invoke('octa:update-download'),
    install: () => ipcRenderer.invoke('octa:update-install'),
    onChange: cb => ipcRenderer.on('octa:update', (_e, u) => cb(u))
  }
});
