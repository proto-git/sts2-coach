# STS2 Coach v0.1.3

Three small Windows polish fixes after first real install.

## What's fixed

### App icon (Patch 19f)
Windows showed a blank icon in the taskbar and Start menu. Now ships a real branded icon — dark indigo card with a bold "C" mark and an amber accent dot that visually echoes the in-app update pill.

- **Windows**: multi-resolution `icon.ico` (16/32/48/64/128/256) embedded in the .exe + installer.
- **macOS**: matching `icon.icns` for the app bundle, plus an updated monochrome menu-bar template.
- **Settings window**: explicit `BrowserWindow.icon` so the title-bar/taskbar entry is consistent.
- **Tray**: now picks the correct asset per OS — Mac uses the template (system-tinted), Windows uses the colored .ico, Linux uses the .png. Prevents the "invisible tray icon" bug Electron has when `setTemplateImage(true)` is called on Windows.

### Hotkey labels match your platform
Hotkey hints throughout the UI used Mac symbols (`⌥⇧S`) on every OS. Now they adapt:
- **macOS** users see `⌥⇧S` and `⌥⇧D`.
- **Windows / Linux** users see `Alt+Shift+S` and `Alt+Shift+D`.

Affected surfaces: tray menu items ("Advise now"), overlay tooltip + hint text, Settings hint ("Play a chime on…"), Diagnostics empty-state message.

### Settings UI escape sequences
Fixed literal `\u2014`, `\u2192`, `\u{1F441}` etc. that were leaking into the rendered HTML in the API Keys card and showing up as raw text instead of em-dashes, arrows, and the show/hide eye glyph.

## How to upgrade

The in-app update banner will surface this release within 30s of next launch on v0.1.1+. Click the amber "⬆︎ Update" pill → release page → grab the new installer.

## Downloads

- **macOS (Apple Silicon)** — `STS2 Coach-0.1.3-arm64.dmg`
- **Windows (x64)** — `STS2 Coach Setup 0.1.3.exe`

## Full changelog

- `feat(icons)`: branded multi-platform app icons + per-OS tray asset
- `fix(ui)`: per-platform hotkey labels (Mac vs. Windows/Linux)
- `fix(ui)`: render Unicode escapes correctly in Settings HTML
