const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('octaBrowser', {
  onFrame(fn) { ipcRenderer.on('octa:browser-frame', (_e, data) => fn(data)); },
  toggle() { ipcRenderer.send('octa:browser-toggle'); },
  back() { ipcRenderer.send('octa:browser-back'); },
  newTab() { ipcRenderer.send('octa:browser-tab'); },
  pick(i) { ipcRenderer.send('octa:browser-pick', i); },
  closeTab(i) { ipcRenderer.send('octa:browser-close', i); },
  engine(id) { ipcRenderer.send('octa:browser-engine', id); },
  go(url) { ipcRenderer.send('octa:browser-go', url); },
  // the switch under the page: true = take control (接手), false = back to watch only (繼續)
  control(on) { ipcRenderer.send('octa:browser-control', !!on); },
  // the watch-only shield passes wheel turns on so you can still scroll while only watching
  wheel(d) { ipcRenderer.send('octa:browser-wheel', { x: +d?.x || 0, y: +d?.y || 0, dx: +d?.dx || 0, dy: +d?.dy || 0 }); },
  dragStart() { return ipcRenderer.sendSync('octa:browser-drag-start'); },
  dragBy(dx, dy, edge) { ipcRenderer.send('octa:browser-drag-by', { dx, dy, edge: edge || '' }); },
  dragEnd() { ipcRenderer.send('octa:browser-drag-end'); },
  dot(on) { ipcRenderer.send('octa:browser-dot', !!on); }
});
