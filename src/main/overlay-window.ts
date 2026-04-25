import { BrowserWindow, screen, ipcMain, Display } from 'electron';
import * as path from 'path';
import {
  OverlaySettings,
  SnapZone,
  loadOverlaySettings,
  saveOverlaySettings,
} from './settings';
import { logger } from '@shared/logger';

const MARGIN = 20;

export interface OverlayHandle {
  win: BrowserWindow;
  moveToZone: (zone: SnapZone) => void;
  resetPosition: () => void;
  setOpacity: (v: number) => void;
  setClickThrough: (v: boolean) => void;
  getSettings: () => OverlaySettings;
}

export function createOverlayWindow(): OverlayHandle {
  const settings = loadOverlaySettings();
  const display = findDisplay(settings.displayId);

  const { x, y } = computeInitialPosition(settings, display);

  const win = new BrowserWindow({
    width: settings.width,
    height: settings.height,
    x, y,
    frame: false,
    transparent: true,
    resizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.setOpacity(settings.opacity);
  win.setIgnoreMouseEvents(settings.clickThrough, { forward: true });
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.setAlwaysOnTop(true, 'screen-saver');

  if (process.env.ELECTRON_RENDERER_URL) {
    win.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    win.loadFile(path.join(__dirname, '../overlay/index.html'));
  }

  // ── IPC: renderer-driven height changes (expanding "Full reasoning") ─────
  ipcMain.on('overlay-resize', (_e, desiredHeight: number) => {
    if (win.isDestroyed()) return;
    const disp = screen.getDisplayMatching(win.getBounds());
    const maxH = Math.min(720, disp.workArea.height - 40);
    const s = loadOverlaySettings();
    const h = Math.max(s.height, Math.min(maxH, Math.ceil(desiredHeight)));
    const [curW] = win.getSize();
    // Anchor expansion based on zone — grow upward when docked at bottom,
    // downward when docked at top, otherwise keep the y as-is.
    const [curX, curY] = win.getPosition();
    let newY = curY;
    if (s.snapZone && s.snapZone.startsWith('bottom')) {
      newY = disp.workArea.y + disp.workArea.height - h - MARGIN;
    } else if (s.snapZone && s.snapZone.startsWith('top')) {
      newY = disp.workArea.y + MARGIN;
    }
    win.setBounds({ x: curX, y: newY, width: curW, height: h });
  });

  // ── IPC: unlocked-drag from the renderer ─────────────────────────────────
  // Renderer sends a delta each mousemove while unlocked.
  ipcMain.on('overlay-drag', (_e, dx: number, dy: number) => {
    if (win.isDestroyed()) return;
    const [x0, y0] = win.getPosition();
    const nx = x0 + Math.round(dx);
    const ny = y0 + Math.round(dy);
    const disp = screen.getDisplayNearestPoint({ x: nx, y: ny });
    const clamped = clampToDisplay(nx, ny, win.getSize()[0], win.getSize()[1], disp);
    win.setPosition(clamped.x, clamped.y);
  });

  // When the user finishes a drag, persist the final position + display.
  ipcMain.on('overlay-drag-end', () => {
    if (win.isDestroyed()) return;
    const [fx, fy] = win.getPosition();
    const disp = screen.getDisplayMatching(win.getBounds());
    saveOverlaySettings({
      x: fx - disp.workArea.x,
      y: fy - disp.workArea.y,
      displayId: disp.id,
      snapZone: null,
    });
    logger.debug('overlay custom position saved', { x: fx, y: fy, display: disp.id });
  });

  function moveToZone(zone: SnapZone) {
    const disp = screen.getDisplayMatching(win.getBounds());
    const [w, h] = win.getSize();
    const { x, y } = zoneToPoint(zone, w, h, disp);
    win.setPosition(x, y);
    saveOverlaySettings({ snapZone: zone, x: null, y: null, displayId: disp.id });
  }

  function resetPosition() {
    saveOverlaySettings({ snapZone: 'bottom-right', x: null, y: null, displayId: null });
    moveToZone('bottom-right');
  }

  function setOpacity(v: number) {
    const clamped = Math.max(0.3, Math.min(1.0, v));
    win.setOpacity(clamped);
    saveOverlaySettings({ opacity: clamped });
  }

  function setClickThrough(v: boolean) {
    win.setIgnoreMouseEvents(v, { forward: true });
    saveOverlaySettings({ clickThrough: v });
  }

  return { win, moveToZone, resetPosition, setOpacity, setClickThrough, getSettings: loadOverlaySettings };
}

// ── helpers ────────────────────────────────────────────────────────────────

function findDisplay(id: number | null): Display {
  if (id == null) return screen.getPrimaryDisplay();
  return screen.getAllDisplays().find((d) => d.id === id) ?? screen.getPrimaryDisplay();
}

function computeInitialPosition(s: OverlaySettings, disp: Display): { x: number; y: number } {
  if (s.snapZone) {
    return zoneToPoint(s.snapZone, s.width, s.height, disp);
  }
  if (s.x != null && s.y != null) {
    const abs = { x: disp.workArea.x + s.x, y: disp.workArea.y + s.y };
    return clampToDisplay(abs.x, abs.y, s.width, s.height, disp);
  }
  return zoneToPoint('bottom-right', s.width, s.height, disp);
}

function zoneToPoint(zone: SnapZone, w: number, h: number, disp: Display): { x: number; y: number } {
  const wa = disp.workArea;
  const leftX = wa.x + MARGIN;
  const centerX = wa.x + Math.round((wa.width - w) / 2);
  const rightX = wa.x + wa.width - w - MARGIN;
  const topY = wa.y + MARGIN;
  const centerY = wa.y + Math.round((wa.height - h) / 2);
  const bottomY = wa.y + wa.height - h - MARGIN;
  switch (zone) {
    case 'top-left':     return { x: leftX,   y: topY };
    case 'top':          return { x: centerX, y: topY };
    case 'top-right':    return { x: rightX,  y: topY };
    case 'left':         return { x: leftX,   y: centerY };
    case 'center':       return { x: centerX, y: centerY };
    case 'right':        return { x: rightX,  y: centerY };
    case 'bottom-left':  return { x: leftX,   y: bottomY };
    case 'bottom':       return { x: centerX, y: bottomY };
    case 'bottom-right': return { x: rightX,  y: bottomY };
  }
}

function clampToDisplay(x: number, y: number, w: number, h: number, disp: Display) {
  const wa = disp.workArea;
  const minX = wa.x;
  const minY = wa.y;
  const maxX = wa.x + wa.width - w;
  const maxY = wa.y + wa.height - h;
  return {
    x: Math.max(minX, Math.min(maxX, x)),
    y: Math.max(minY, Math.min(maxY, y)),
  };
}
