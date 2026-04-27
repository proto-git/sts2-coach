# STS2 Coach v0.1.1

A small follow-up to v0.1.0 that closes the loop on updates.

## What's new

### In-app update banner (Patch 19d)
The app now politely tells you when a new release is out.

- **Overlay** — a small amber "⬆︎ Update" pill appears in the header when a newer release is available. Click it to open the GitHub release page in your default browser.
- **Settings → About** — shows your current version, when we last checked, and gives you Check now / Download update / Dismiss buttons.
- **Cadence** — first check 30 seconds after launch (so we don't hammer GitHub at startup), then every 24 hours.
- **Dismiss is per-version** — hiding the v0.1.2 banner won't suppress v0.1.3.

No telemetry, no background downloads, no Gatekeeper drama. Just a polite nudge with a link.

### Why a banner and not a true auto-updater?
Electron's built-in auto-updater silently fails on unsigned macOS builds (Gatekeeper blocks it). Until we ship code-signing, this banner-driven flow is the most reliable cross-OS option — you stay in control of what gets installed and when.

## Heads-up

If you're upgrading **from v0.1.0**, this is the release where the banner code first lands. Future releases (v0.1.2+) will surface in the banner automatically. Your settings, API keys, and diagnostics history all carry over.

## Downloads

Pick the right binary for your machine on the [Releases page](https://github.com/proto-git/sts2-coach/releases/tag/v0.1.1):

- **macOS (Apple Silicon)** — `STS2 Coach-0.1.1-arm64.dmg`
- **Windows (x64)** — `STS2 Coach Setup 0.1.1.exe`

First launch on macOS: right-click the app → Open (Gatekeeper warning is expected on unsigned builds).

## Full changelog

- `feat(updater)`: in-app update banner — GitHub Releases polling, overlay pill, Settings About card, per-version dismiss state ([8435064](https://github.com/proto-git/sts2-coach/commit/8435064))
