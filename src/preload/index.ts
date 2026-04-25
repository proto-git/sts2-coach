import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('api', {
  onAdvice: (cb: (advice: any) => void) => {
    ipcRenderer.on('advice', (_, a) => cb(a));
  },
  onState: (cb: (state: any) => void) => {
    ipcRenderer.on('state', (_, s) => cb(s));
  },
  onLockChange: (cb: (locked: boolean) => void) => {
    ipcRenderer.on('overlay-lock', (_, locked) => cb(locked));
  },
  getState:   () => ipcRenderer.invoke('get-state'),
  getModel:   () => ipcRenderer.invoke('get-model'),
  getLocked:  () => ipcRenderer.invoke('overlay-get-locked'),
  setLocked:  (v: boolean) => ipcRenderer.send('overlay-set-locked', v),
  hideOverlay:  () => ipcRenderer.send('hide-overlay'),
  resizeOverlay:(height: number) => ipcRenderer.send('overlay-resize', height),
  dragOverlay:  (dx: number, dy: number) => ipcRenderer.send('overlay-drag', dx, dy),
  endDragOverlay: () => ipcRenderer.send('overlay-drag-end'),
});
