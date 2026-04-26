import { app, BrowserWindow } from 'electron';
import * as path from 'path';
import { logger } from '@shared/logger';

/**
 * Single-instance settings window. Unlike the overlay, this is a normal
 * always-visible window with a titlebar and a regular taskbar/dock entry
 * so users can find it the way they expect.
 */

let win: BrowserWindow | null = null;

export function openSettingsWindow(): BrowserWindow {
  if (win && !win.isDestroyed()) {
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
    return win;
  }

  win = new BrowserWindow({
    width: 560,
    height: 720,
    minWidth: 480,
    minHeight: 580,
    title: 'STS2 Coach \u2014 Settings',
    show: false,
    resizable: true,
    minimizable: true,
    maximizable: false,
    fullscreenable: false,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  win.removeMenu();

  // Mirror the overlay loader pattern: ELECTRON_RENDERER_URL in dev,
  // bundled file in production. Renderer bundles live under dist/renderer/.
  const baseUrl = process.env.ELECTRON_RENDERER_URL;
  if (baseUrl) {
    void win.loadURL(`${baseUrl}/settings/index.html`);
  } else {
    void win.loadFile(path.join(__dirname, '../renderer/settings/index.html'));
  }

  win.once('ready-to-show', () => {
    win?.show();
    win?.focus();
  });

  win.on('closed', () => {
    win = null;
  });

  // Block external nav \u2014 settings page never leaves itself.
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  // Re-enable dock on macOS while settings is open so users can find it via
  // ⌘-Tab / Mission Control. Hide it again when settings closes.
  if (process.platform === 'darwin' && app.dock) {
    try {
      const r = (app.dock as any).show?.();
      if (r && typeof r.then === 'function') r.catch((e: unknown) => logger.warn('app.dock.show failed', e));
    } catch (e) {
      logger.warn('app.dock.show threw', e);
    }
    win.on('closed', () => {
      // Only hide if the only visible window was settings.
      if (BrowserWindow.getAllWindows().every((w) => w.isDestroyed() || !w.isVisible())) {
        app.dock?.hide();
      }
    });
  }

  return win;
}

export function closeSettingsWindow(): void {
  if (win && !win.isDestroyed()) win.close();
  win = null;
}

export function isSettingsWindowOpen(): boolean {
  return !!win && !win.isDestroyed();
}
