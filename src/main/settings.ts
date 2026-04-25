import { app } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { logger } from '@shared/logger';

/**
 * Tiny JSON-on-disk settings store for things that need to survive restarts:
 *  - overlay position + size
 *  - overlay opacity
 *  - click-through state
 *
 * Kept separate from the SQLite app DB so it's trivial to inspect/edit by hand.
 */

export interface OverlaySettings {
  displayId: number | null;   // screen.Display.id; null = primary
  x: number | null;           // absolute x within the remembered display; null = snap
  y: number | null;
  width: number;
  height: number;             // collapsed height; expanded is computed
  opacity: number;            // 0.5–1.0
  clickThrough: boolean;
  snapZone: SnapZone | null;  // when non-null, x/y are derived from the zone
}

export type SnapZone =
  | 'top-left' | 'top' | 'top-right'
  | 'left'     | 'center' | 'right'
  | 'bottom-left' | 'bottom' | 'bottom-right';

const DEFAULTS: OverlaySettings = {
  displayId: null,
  x: null,
  y: null,
  width: 420,
  height: 240,
  opacity: 1.0,
  clickThrough: false,
  snapZone: 'bottom-right',
};

let cached: OverlaySettings | null = null;

function settingsFile(): string {
  const dir = app.getPath('userData');
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, 'overlay-settings.json');
}

export function loadOverlaySettings(): OverlaySettings {
  if (cached) return cached;
  try {
    const raw = fs.readFileSync(settingsFile(), 'utf8');
    const parsed = JSON.parse(raw);
    cached = { ...DEFAULTS, ...parsed };
    logger.debug('overlay settings loaded', cached);
  } catch {
    cached = { ...DEFAULTS };
  }
  return cached!;
}

export function saveOverlaySettings(patch: Partial<OverlaySettings>): OverlaySettings {
  const next = { ...loadOverlaySettings(), ...patch };
  cached = next;
  try {
    fs.writeFileSync(settingsFile(), JSON.stringify(next, null, 2));
  } catch (err) {
    logger.warn('failed to persist overlay settings', err);
  }
  return next;
}

export function resetOverlaySettings(): OverlaySettings {
  cached = { ...DEFAULTS };
  try { fs.writeFileSync(settingsFile(), JSON.stringify(cached, null, 2)); } catch {}
  return cached;
}
