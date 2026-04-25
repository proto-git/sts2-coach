# Changelog

All notable changes to STS2 Coach are documented here.
Format loosely based on [Keep a Changelog](https://keepachangelog.com/).

## [Unreleased]

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
