const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('octaBrowser', {
  onFrame(fn) { ipcRenderer.on('octa:browser-frame', (_e, data) => fn(data)); },
  toggle() { ipcRenderer.send('octa:browser-toggle'); },
  back() { ipcRenderer.send('octa:browser-back'); },
  newTab() { ipcRenderer.send('octa:browser-tab'); },
  pick(i) { ipcRenderer.send('octa:browser-pick', i); },
  closeTab(i) { ipcRenderer.send('octa:browser-close', i); },
  go(url) { ipcRenderer.send('octa:browser-go', url); },
  dragStart() { return ipcRenderer.sendSync('octa:browser-drag-start'); },
  dragBy(dx, dy, edge) { ipcRenderer.send('octa:browser-drag-by', { dx, dy, edge: edge || '' }); },
  dragEnd() { ipcRenderer.send('octa:browser-drag-end'); }
});
