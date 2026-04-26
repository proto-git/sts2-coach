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
  // Patch 16: hotkey ack — main fires this the instant a hotkey lands so the
  // overlay can flip to a "Thinking…" state and (optionally) play a ding.
  onPending: (cb: (info: { kind: 'advise' | 'deck-dump'; ding: boolean }) => void) => {
    ipcRenderer.on('coach-pending', (_, info) => cb(info));
  },
  onError: (cb: (msg: string) => void) => {
    ipcRenderer.on('coach-error', (_, msg) => cb(msg));
  },
  getState:   () => ipcRenderer.invoke('get-state'),
  getModel:   () => ipcRenderer.invoke('get-model'),
  getLocked:  () => ipcRenderer.invoke('overlay-get-locked'),
  // Patch 16: read-only mode signal for the overlay badge.
  getReadOnly: () => ipcRenderer.invoke('coach-get-read-only'),
  onReadOnlyChange: (cb: (v: boolean) => void) => {
    ipcRenderer.on('coach-read-only', (_, v: boolean) => cb(v));
  },
  setLocked:  (v: boolean) => ipcRenderer.send('overlay-set-locked', v),
  hideOverlay:  () => ipcRenderer.send('hide-overlay'),
  resizeOverlay:(height: number) => ipcRenderer.send('overlay-resize', height),
  dragOverlay:  (dx: number, dy: number) => ipcRenderer.send('overlay-drag', dx, dy),
  endDragOverlay: () => ipcRenderer.send('overlay-drag-end'),

  // Settings window IPC — see src/main/config.ts and src/settings/.
  settings: {
    load:           () => ipcRenderer.invoke('settings:load'),
    save:           (patch: Record<string, unknown>) => ipcRenderer.invoke('settings:save', patch),
    detectSaveDir:  () => ipcRenderer.invoke('settings:detect-save-dir'),
    pickSaveDir:    () => ipcRenderer.invoke('settings:pick-save-dir'),
    getModelOptions:() => ipcRenderer.invoke('settings:get-models'),
    close:          () => ipcRenderer.send('settings:close'),
  },

  // Diagnostics IPC (Patch 17) — see src/main/db.ts (DiagnosticRow).
  diagnostics: {
    get:    (limit?: number) => ipcRenderer.invoke('diagnostics:get', limit),
    clear:  () => ipcRenderer.invoke('diagnostics:clear'),
  },
});
