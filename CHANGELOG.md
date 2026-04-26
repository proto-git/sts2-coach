# Changelog

All notable changes to STS2 Coach are documented here.
Format loosely based on [Keep a Changelog](https://keepachangelog.com/).

## [Unreleased]

### Added
- **Shop recognition guards** so the coach stops hallucinating relic and potion
  names from icons. STS2 doesn't print names for relics/potions in the shop,
  and the save file never persists which 3 are currently offered — only the
  per-run eligible relic pool. The coach now (a) feeds that pool to the model
  as "the icon must be one of these N relics", (b) hard-rules the prompt to
  describe shop relics/potions by slot + price + icon color instead of naming
  them, and (c) post-hoc rewrites picks that named a specific relic/potion
  into a verify-on-screen instruction. New `knowledge/30-shop.md` documents
  shop layout, slot vocabulary, and shop priors.
- Affordability check on shop picks: parses `$NNg` tokens out of the
  recommendation, sums them, and warns if the total exceeds current gold.
- **Settings window** for in-app configuration of API keys, model choice, TTS
  provider/voice, and save-folder override. No more editing `.env` files just to
  rotate a key. Opened from the tray menu (Settings…) and auto-popped on first
  run if no OpenRouter key is found.
- `config.json` stored under Electron's `userData` directory. Resolution order:
  config.json → environment variable → hard-coded default. Existing `.env`
  workflows keep working.
- Coach, TTS, and the save-watcher now rebuild in place when settings are saved
  — no app restart required.
- Save-folder Auto-detect / Browse buttons in the Settings window for users
  whose Slay the Spire 2 install lives somewhere unusual.
- TTS provider "off" option for muting the voice without disabling advice.

### Changed
- Renderer build is now multi-entry (`dist/renderer/{overlay,settings}/`)
  instead of single-bundle `dist/overlay/`. Transparent for users running
  release builds, but local clones must `npm run build` once after pulling.

## [0.1.0] — Initial public release

First public, cross-platform (macOS + Windows) build. Folds together Patches
01–10 of the original development thread:

### Added
- Save-file watcher with cross-platform path resolution (macOS Library, Windows AppData, Linux XDG).
- Hotkey-driven screenshot via Electron `desktopCapturer` + `sharp` resize.
- OpenRouter-backed advice (Claude Sonnet 4.6 default, plus Opus, Haiku, GPT-5.4 family, Gemini 3 Pro/Flash).
- Pinned transparent overlay: pick, reasoning, runner-up, full-reasoning details.
- Drag-to-move overlay, 9-zone tray submenu, opacity + click-through controls, multi-monitor aware.
- Adaptive Act map planner: enumerates paths, scores by shop/rest/elite/treasure priors, re-plans on low-HP / high-gold / new key relic / off-path.
- ASCII map renderer with a viewport crop so tall maps fit the overlay.
- Anti-hallucination guards: explicit "seen" enumeration, hand verification, screen-context lock, energy balance simulator with `energy_gain` field for refund cards.
- TTS: OpenAI HD voice with system fallback (`say` on macOS, PowerShell `SpeechSynthesizer` on Windows, `spd-say`/`espeak` on Linux).
- Cross-platform installers via electron-builder (`.dmg` / `.zip` on macOS, NSIS `.exe` / `.zip` on Windows).
- GitHub Actions: typecheck CI on push/PR, tag-driven release builds for both OSes.
