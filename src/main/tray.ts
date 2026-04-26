import { Tray, Menu, nativeImage } from 'electron';
import * as path from 'path';
import { MODEL_OPTIONS } from '@shared/models';
import type { SnapZone, OverlaySettings } from './settings';

interface TrayDeps {
  getCurrentModel: () => string;
  setModel: (slug: string) => void;
  triggerAdvise: () => void;
  triggerDeckDump: () => void;
  showOverlay: () => void;
  hideOverlay: () => void;
  moveOverlayToZone: (zone: SnapZone) => void;
  resetOverlay: () => void;
  /** Emergency rescue: snap overlay to display under the cursor. */
  bringOverlayToCursor: () => void;
  setOverlayOpacity: (v: number) => void;
  setOverlayClickThrough: (v: boolean) => void;
  getOverlaySettings: () => OverlaySettings;
  openSettings: () => void;
  /** Patch 17: opens settings window pre-focused on the Diagnostics tab. */
  openDiagnostics: () => void;
  /** Patch 16: read-only mode (no voice + no ding). */
  isReadOnly: () => boolean;
  setReadOnly: (v: boolean) => void;
  quit: () => void;
}

const ZONES: { label: string; zone: SnapZone }[] = [
  { label: 'Top Left',     zone: 'top-left' },
  { label: 'Top',          zone: 'top' },
  { label: 'Top Right',    zone: 'top-right' },
  { label: 'Left',         zone: 'left' },
  { label: 'Center',       zone: 'center' },
  { label: 'Right',        zone: 'right' },
  { label: 'Bottom Left',  zone: 'bottom-left' },
  { label: 'Bottom',       zone: 'bottom' },
  { label: 'Bottom Right', zone: 'bottom-right' },
];

const OPACITIES = [1.0, 0.85, 0.7, 0.55];

export function createTray(deps: TrayDeps): Tray {
  const iconPath = path.join(__dirname, '../../assets/trayTemplate.png');
  let icon: Electron.NativeImage;
  try {
    icon = nativeImage.createFromPath(iconPath);
    if (icon.isEmpty()) icon = nativeImage.createEmpty();
    else icon.setTemplateImage(true);
  } catch {
    icon = nativeImage.createEmpty();
  }

  const tray = new Tray(icon);
  tray.setToolTip('STS2 Coach');

  const rebuild = () => {
    const model = deps.getCurrentModel();
    const s = deps.getOverlaySettings();

    const menu = Menu.buildFromTemplate([
      { label: 'Advise now  ⌥⇧S',      click: () => deps.triggerAdvise() },
      { label: 'Deck dump now  ⌥⇧D',   click: () => deps.triggerDeckDump() },
      { type: 'separator' },
      {
        label: 'Model',
        submenu: MODEL_OPTIONS.map((m) => ({
          label: m.label,
          type: 'radio' as const,
          checked: m.slug === model,
          click: () => { deps.setModel(m.slug); rebuild(); },
        })),
      },
      { label: 'Settings\u2026',     click: () => deps.openSettings() },
      { label: 'Diagnostics\u2026',  click: () => deps.openDiagnostics() },
      {
        label: 'Read-only mode (silence voice)',
        type: 'checkbox',
        checked: deps.isReadOnly(),
        click: (item) => { deps.setReadOnly(item.checked); rebuild(); },
      },
      { type: 'separator' },
      { label: 'Show overlay', click: () => deps.showOverlay() },
      { label: 'Hide overlay', click: () => deps.hideOverlay() },
      {
        label: 'Overlay position',
        submenu: [
          ...ZONES.map((z) => ({
            label: z.label,
            type: 'radio' as const,
            checked: s.snapZone === z.zone,
            click: () => { deps.moveOverlayToZone(z.zone); rebuild(); },
          })),
          { type: 'separator' as const },
          { label: 'Bring to cursor', click: () => deps.bringOverlayToCursor() },
          { label: 'Reset to Bottom Right', click: () => { deps.resetOverlay(); rebuild(); } },
        ],
      },
      {
        label: 'Overlay opacity',
        submenu: OPACITIES.map((v) => ({
          label: `${Math.round(v * 100)}%`,
          type: 'radio' as const,
          checked: Math.abs(s.opacity - v) < 0.01,
          click: () => { deps.setOverlayOpacity(v); rebuild(); },
        })),
      },
      {
        label: 'Mouse passes through overlay',
        type: 'checkbox',
        checked: s.clickThrough,
        click: (item) => { deps.setOverlayClickThrough(item.checked); rebuild(); },
      },
      { type: 'separator' },
      { label: 'Quit', click: () => deps.quit() },
    ]);

    tray.setContextMenu(menu);
    tray.setTitle('🎴');
  };

  rebuild();
  return tray;
}
