/**
 * Per-platform display strings for the global hotkeys.
 *
 * The Electron `globalShortcut.register('Alt+Shift+S', ...)` call works on
 * both macOS and Windows — Electron maps "Alt" to ⌥ on Mac and to Alt on
 * Windows. But when we show the hotkey to the user (in tooltips, menu
 * labels, hint text), we want the symbol they're used to seeing on their
 * own keyboard.
 *
 * macOS convention:  ⌥⇧S, ⌥⇧D
 * Windows convention: Alt+Shift+S, Alt+Shift+D
 *
 * Used by:
 *   - tray menu item labels (main process)
 *   - overlay tooltip + hint text (renderer)
 *   - settings UI hint text (renderer)
 */

/** True if the current process is running on macOS. */
function isMac(): boolean {
  // In Electron main process, process.platform is reliable.
  // In the renderer it's also exposed via process.platform when nodeIntegration
  // is off but contextBridge isn't required for this read — Electron exposes it.
  if (typeof process !== 'undefined' && process.platform) {
    return process.platform === 'darwin';
  }
  // Renderer fallback: sniff navigator.platform.
  if (typeof navigator !== 'undefined' && navigator.platform) {
    return /Mac|iPhone|iPad/i.test(navigator.platform);
  }
  return false;
}

export interface HotkeyLabels {
  /** "⌥⇧S" on macOS, "Alt+Shift+S" on Windows. */
  advise: string;
  /** "⌥⇧D" on macOS, "Alt+Shift+D" on Windows. */
  deck: string;
}

export function hotkeyLabels(): HotkeyLabels {
  if (isMac()) {
    return { advise: '\u2325\u21E7S', deck: '\u2325\u21E7D' };
  }
  return { advise: 'Alt+Shift+S', deck: 'Alt+Shift+D' };
}
