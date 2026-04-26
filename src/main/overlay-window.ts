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
// Keep at least this many pixels of the overlay on-screen so it can never
// be dragged fully off the visible desktop.
const MIN_VISIBLE = 24;
// 'floating' keeps the window above normal app windows but stops macOS from
// dragging it along when another app is moved between displays. 'screen-saver'
// caused the overlay to follow whichever window was being moved across
// monitors and then become trapped on the new display.
const ALWAYS_ON_TOP_LEVEL = 'floating' as const;

export interface OverlayHandle {
  win: BrowserWindow;
  moveToZone: (zone: SnapZone) => void;
  resetPosition: () => void;
  setOpacity: (v: number) => void;
  setClickThrough: (v: boolean) => void;
  getSettings: () => OverlaySettings;
  bringToCursor: () => void;
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
  win.setAlwaysOnTop(true, ALWAYS_ON_TOP_LEVEL);

  // Renderer is built as multi-entry under dist/renderer/{overlay,settings}/.
  // Dev: ELECTRON_RENDERER_URL is the Vite dev-server root, so we append the entry path.
  if (process.env.ELECTRON_RENDERER_URL) {
    win.loadURL(`${process.env.ELECTRON_RENDERER_URL}/overlay/index.html`);
  } else {
    win.loadFile(path.join(__dirname, '../renderer/overlay/index.html'));
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
    const [w, h] = win.getSize();
    const nx = x0 + Math.round(dx);
    const ny = y0 + Math.round(dy);
    // Clamp against the union of ALL displays so the user can drag freely
    // between monitors. We only enforce that a small sliver stays visible
    // somewhere on the desktop so the window can't be lost entirely.
    const clamped = clampToAnyDisplay(nx, ny, w, h);
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

  // Emergency rescue: snap the overlay to whichever display the cursor is on.
  // Useful if a monitor is unplugged or the window somehow ends up off-screen.
  function bringToCursor() {
    if (win.isDestroyed()) return;
    const cursor = screen.getCursorScreenPoint();
    const disp = screen.getDisplayNearestPoint(cursor);
    const [w, h] = win.getSize();
    const wa = disp.workArea;
    const x = wa.x + Math.max(MARGIN, Math.round((wa.width - w) / 2));
    const y = wa.y + Math.max(MARGIN, Math.round((wa.height - h) / 2));
    win.setPosition(x, y);
    saveOverlaySettings({
      x: x - wa.x,
      y: y - wa.y,
      displayId: disp.id,
      snapZone: null,
    });
    logger.debug('overlay brought to cursor', { x, y, display: disp.id });
  }

  // Re-anchor if the display layout changes and the overlay would be stranded
  // off-screen (e.g. monitor unplugged, resolution swap, dock/undock).
  function reanchorIfStranded() {
    if (win.isDestroyed()) return;
    const [x, y] = win.getPosition();
    const [w, h] = win.getSize();
    const rect = { x, y, width: w, height: h };
    const visible = screen.getAllDisplays().some((d) => rectIntersects(rect, d.workArea));
    if (!visible) {
      logger.warn('overlay stranded after display change, re-anchoring');
      bringToCursor();
    }
  }
  screen.on('display-added', reanchorIfStranded);
  screen.on('display-removed', reanchorIfStranded);
  screen.on('display-metrics-changed', reanchorIfStranded);
  win.on('closed', () => {
    screen.removeListener('display-added', reanchorIfStranded);
    screen.removeListener('display-removed', reanchorIfStranded);
    screen.removeListener('display-metrics-changed', reanchorIfStranded);
  });

  return { win, moveToZone, resetPosition, setOpacity, setClickThrough, getSettings: loadOverlaySettings, bringToCursor };
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

// Clamp against the bounding box of ALL displays. This lets the user drag
// the overlay across monitor boundaries (including the gaps between displays
// of different sizes) while still preventing it from being dragged fully
// off-screen. We require at least MIN_VISIBLE pixels to remain inside the
// union rect so the window is always reachable for another drag.
function clampToAnyDisplay(x: number, y: number, w: number, h: number) {
  const displays = screen.getAllDisplays();
  if (displays.length === 0) return { x, y };
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const d of displays) {
    const wa = d.workArea;
    if (wa.x < minX) minX = wa.x;
    if (wa.y < minY) minY = wa.y;
    if (wa.x + wa.width > maxX) maxX = wa.x + wa.width;
    if (wa.y + wa.height > maxY) maxY = wa.y + wa.height;
  }
  // Allow the window to extend past edges as long as MIN_VISIBLE pixels
  // remain inside the union rect on each axis.
  const lowX = minX - (w - MIN_VISIBLE);
  const highX = maxX - MIN_VISIBLE;
  const lowY = minY - (h - MIN_VISIBLE);
  const highY = maxY - MIN_VISIBLE;
  return {
    x: Math.max(lowX, Math.min(highX, x)),
    y: Math.max(lowY, Math.min(highY, y)),
  };
}

function rectIntersects(
  a: { x: number; y: number; width: number; height: number },
  b: { x: number; y: number; width: number; height: number },
): boolean {
  return (
    a.x < b.x + b.width &&
    a.x + a.width > b.x &&
    a.y < b.y + b.height &&
    a.y + a.height > b.y
  );
}
