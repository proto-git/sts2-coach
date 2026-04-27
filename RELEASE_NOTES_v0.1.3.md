# STS2 Coach v0.1.3

Polish + two real fixes for Windows users running multi-monitor / OpenAI voice.

## What's fixed

### Multi-monitor screenshot capture (Patch 19g)
**Bug**: with the game on monitor #2, advise() would error with "take a picture of the game" — the model was looking at an empty desktop. The screenshot code was hard-coded to capture `screen.getPrimaryDisplay()`, which on most Windows setups is monitor #1.

**Fix**: capture the display under the user's mouse cursor at hotkey time. Since the game has focus when you press the hotkey, the cursor is on the game's monitor, so the capture naturally lands on the right screen — primary, secondary, even tertiary. The macOS `screencapture` fallback now also passes `-D <display>` so the same logic works there.

### OpenAI HD voice on Windows (Patch 19g)
**Bug**: with TTS provider set to OpenAI, Windows played silence — system voice worked fine but HD voice never came through.

**Root cause**: the MP3 playback used `WMPlayer.OCX` and polled `playState != 1`. WMP's enum is `1 = Stopped` (the *end* state), `3 = Playing`. So the loop exited immediately while the player was still in state 0/9 ("Undefined"/"Transitioning"), terminating the PowerShell script before audio came out.

**Fix**: switched to WPF's `System.Windows.Media.MediaPlayer` which exposes a real `MediaEnded` event — script now waits for actual playback completion (with a 60s safety ceiling).

## What's new from Patch 19f (rolled in)

### Branded app icon
Windows blank-icon-in-taskbar fixed. Ships a real `icon.ico` with a dark indigo card, bold "C" mark, and an amber accent dot that visually echoes the in-app update pill. Matching `icon.icns` for macOS, plus a fresh monochrome menu-bar template. The NSIS installer + uninstaller also pick up the icon now.

### Hotkey labels match your platform
- macOS: `⌥⇧S` and `⌥⇧D`
- Windows / Linux: `Alt+Shift+S` and `Alt+Shift+D`

Affects tray menu items, overlay tooltip + hint, the "Play a chime on…" toggle in Settings, and the diagnostics empty-state copy.

### Settings UI escape sequences
Fixed literal `\u2014`, `\u2192`, `\u{1F441}` etc. that were leaking into rendered HTML in the API Keys card. Now em-dashes, arrows, and the show/hide eye render correctly.

### Build infra
Added `@shared` path alias to the renderer Vite config so renderer-side imports of shared modules resolve at build time (not just at type-check time).

## How to upgrade

In-app update banner will surface this within 30s of next launch on v0.1.1+. Click the amber "⬆︎ Update" pill → release page → grab the new installer.

## Downloads

- **macOS (Apple Silicon)** — `STS2 Coach-0.1.3-arm64.dmg`
- **Windows (x64)** — `STS2 Coach Setup 0.1.3.exe`

## Full changelog

- `feat(icons)`: branded multi-platform app icons + per-OS tray asset
- `fix(ui)`: per-platform hotkey labels (Mac vs. Windows/Linux)
- `fix(ui)`: render Unicode escapes correctly in Settings HTML
- `fix(build)`: add @shared alias to renderer Vite config
- `fix(capture)`: screenshot the display under cursor, not always primary
- `fix(tts)`: replace WMPlayer.OCX with WPF MediaPlayer + MediaEnded event for reliable Windows MP3 playback
