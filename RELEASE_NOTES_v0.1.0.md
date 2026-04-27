# STS2 Coach v0.1.0

First public release. A local voice + overlay coach for **Slay the Spire 2** that watches your save file, captures the screen on a hotkey, and asks a vision LLM for a concise pick — spoken aloud and shown in a pinned, transparent overlay.

## Highlights

- **Hybrid intel** — save-file watcher (deck / relics / HP / gold / map) plus on-demand screenshot for what's actually on screen
- **Voice + overlay** — TTS speaks the pick; pinned card shows pick, reasoning, runner-up, ASCII map, and current state
- **Adaptive map planner** — picks an Act path to the boss, re-plans on low HP / high gold / new key relic
- **Anti-hallucination guards** — the model must enumerate exactly what's on screen; energy is balance-checked against a card simulator
- **8 curated models** with prompt caching — Gemini 3 Flash (default), Gemini 3.1 Pro, Claude Sonnet 4.6, GPT-5.4, GPT-5.2 Chat, GLM 5.1, Kimi K2.6, DeepSeek V4 Pro
- **Diagnostics tab** — per-call latency breakdown (screenshot / LLM / TTS), cache-hit savings, "want it faster?" panel that highlights the slowest leg
- **Read-only mode** — single toggle silences TTS for late-night runs
- **Multi-monitor friendly** — drag the overlay freely across displays; auto-rescues if a monitor is unplugged

## Hotkeys

| Shortcut | Action |
|----------|--------|
| ⌥⇧S (Alt+Shift+S) | Capture screen + ask for advice |
| ⌥⇧D (Alt+Shift+D) | Speak a deck summary from the latest save |

## Install

Grab the installer for your OS from the assets below:

- **macOS** — `STS2-Coach-0.1.0-arm64.dmg` (Apple Silicon) or `-x64.dmg` (Intel)
- **Windows** — `STS2-Coach-0.1.0-x64.exe`

Builds are **unsigned**. On macOS: right-click the `.app` → **Open** the first time, then grant Screen Recording permission. On Windows: SmartScreen → "More info" → "Run anyway".

After install, open Settings from the tray menu and paste your **OpenRouter API key** (get one at [openrouter.ai/keys](https://openrouter.ai/keys), $5 minimum). OpenAI key is optional for HD voice — system TTS works without it.

## Known limitations

- Builds are unsigned (Gatekeeper / SmartScreen warnings on first launch)
- Save file is only written between rooms, so deck advice mid-combat falls back to the screenshot
- Vision models occasionally miscount enumerated cards on shop screens; the JSON validator catches most of these
- No first-run onboarding wizard yet (planned for v0.2.0)

## What's next (v0.2.0 plan)

- Text push-back / conversation mode (ask follow-ups without re-screenshotting)
- Voice push-to-talk
- System TTS polish + first-run onboarding wizard

## Thanks

Built with the help of Perplexity Computer over a couple of long weekends. MIT licensed — fork it, ship it, share it.
