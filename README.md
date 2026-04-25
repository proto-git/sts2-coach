# STS2 Coach

A local voice + overlay coach for **Slay the Spire 2**. Watches your save file
for ground-truth deck/relic/HP state, captures the screen on a hotkey, and asks
a vision LLM (Claude / GPT / Gemini via OpenRouter) for a concise pick. Advice
is spoken aloud and shown in a pinned, click-through, transparent overlay.

Runs natively on **macOS** and **Windows**.

![overlay demo placeholder](assets/screenshot.png)

## Features

- **Hybrid intel** — save-file watcher (deck, relics, HP, gold, map) + on-demand screenshot for what's actually on screen.
- **Voice + overlay** — TTS speaks the pick; pinned card shows pick, reasoning, runner-up, and an ASCII map.
- **Adaptive map planner** — picks an Act path to the boss, re-plans on low HP / high gold / new key relic.
- **Anti-hallucination guards** — the model must enumerate exactly what's on screen; energy is balance-checked against a card simulator.
- **Multi-model** — switch between Claude Sonnet/Opus/Haiku, GPT-5.4 family, and Gemini 3 Pro/Flash from the tray.
- **Cross-platform** — Electron app, identical UX on macOS and Windows.

## Requirements

- **Node.js 20+**
- Steam-installed Slay the Spire 2 (Early Access)
- **OpenRouter** API key — https://openrouter.ai/keys
- **OpenAI** API key (optional, for higher-quality TTS) — falls back to system TTS (`say` on macOS, PowerShell SpeechSynthesizer on Windows)

## Install

### From a release (recommended for friends)

Grab the latest installer from the [Releases page](../../releases):

- macOS — `STS2-Coach-x.y.z-arm64.dmg` (Apple Silicon) or `-x64.dmg` (Intel)
- Windows — `STS2-Coach-x.y.z-x64.exe`

> **macOS first launch:** the build is unsigned, so right-click the `.app` →
> **Open** the first time. macOS will ask for **Screen Recording** permission —
> grant it in *System Settings → Privacy & Security → Screen Recording* and
> restart the app.

After install, drop your API keys in the settings file (location shown in the
tray menu → "Open config folder").

### From source

```bash
git clone https://github.com/<your-user>/sts2-coach.git
cd sts2-coach
cp .env.example .env       # paste OPENROUTER_API_KEY (and OPENAI_API_KEY if using)
npm install
npm run rebuild            # rebuild better-sqlite3 against Electron's Node ABI
npm run dev
```

No dock/taskbar icon — look for the 🎴 in the system tray / menu bar.

## Hotkeys

| Shortcut | Action |
|----------|--------|
| ⌥⇧S (Alt+Shift+S) | Capture screen + ask for advice (voice + overlay) |
| ⌥⇧D (Alt+Shift+D) | Speak a quick deck summary from the latest save |

Click the tray icon to switch models, snap the overlay to a screen zone, toggle
click-through, or hide/show the overlay.

## How it works

```
┌─ Save watcher (chokidar) ────────────────────────────┐
│  macOS: ~/Library/Application Support/SlayTheSpire2/ │
│  Windows: %APPDATA%/SlayTheSpire2/                   │
│  → parses current_run.save → updates GameState       │
└──────────────────────────────────────────────────────┘
                    │
                    ▼
     ┌────────────────────────────────┐
     │  In-memory state + SQLite      │
     │  (runs, snapshots, advice,     │
     │   map plans)                   │
     └────────────────────────────────┘
                    │
┌─ Hotkey ⌥⇧S ──────┴──────────────────────────────────┐
│  Electron desktopCapturer → sharp resize → JPEG b64  │
│  → OpenRouter chat completion (vision)               │
│     system prompt = knowledge/*.md (live-reloaded)   │
│     user msg     = state + plan + screenshot         │
│  → JSON advice → overlay + TTS                       │
└──────────────────────────────────────────────────────┘
```

## Save file location

The watcher tries these paths in order, falling through to the next if the
previous doesn't exist:

| Platform | Path |
|----------|------|
| macOS    | `~/Library/Application Support/SlayTheSpire2` |
| Windows  | `%APPDATA%\SlayTheSpire2` |
| Linux    | `$XDG_DATA_HOME/SlayTheSpire2` or `~/.local/share/SlayTheSpire2` |

Override with `STS2_SAVE_DIR` in `.env`.

Helpers to locate the dir:
- macOS / Linux: `bash scripts/find-save.sh`
- Windows: `powershell -ExecutionPolicy Bypass -File scripts\find-save.ps1`

## Knowledge base

`knowledge/*.md` is the coach's brain. The system prompt re-reads these files
on every advice call, so you can edit them live — no restart needed. Files
cover character strategy, relic ratings, boss prep, shop theory, and the
anti-hallucination procedure.

## Releasing

Tag-driven. Push a `v*` tag and GitHub Actions builds the Mac and Windows
installers in parallel and attaches them to a Release:

```bash
npm version patch        # bumps version + creates tag
git push --follow-tags
```

The workflow lives in `.github/workflows/release.yml`.

## Project structure

```
src/
├── main/                Electron main process
│   ├── index.ts           entry — wires everything up
│   ├── save-watcher.ts    chokidar + JSON parser (cross-platform paths)
│   ├── capture.ts         Electron desktopCapturer + sharp
│   ├── coach.ts           OpenRouter client + prompt builder
│   ├── tts.ts             OpenAI TTS + system fallback (say / PowerShell)
│   ├── db.ts              better-sqlite3 schema + inserts
│   ├── tray.ts            menu-bar / system-tray UI
│   ├── overlay-window.ts  pinned transparent window + IPC
│   ├── map.ts             map extraction, path scoring, ASCII renderer
│   └── planner.ts         initial plan + deviation triggers
├── preload/             contextBridge API exposed to overlay
├── overlay/             renderer (HTML / CSS / TS)
└── shared/              types, model list, logger
knowledge/               markdown — compiled into system prompt
prompts/system.ts        composes the system prompt at runtime
scripts/                 find-save.{sh,ps1} helpers
.github/workflows/       CI typecheck + tag-triggered release builds
data/                    SQLite DB lives here (gitignored)
```

## Troubleshooting

- **`advise` returns auth error** — check `OPENROUTER_API_KEY` in `.env`.
- **No voice** — system fallback should always work. If using OpenAI TTS, verify `OPENAI_API_KEY`.
- **Hotkey doesn't fire** — another app may have grabbed it. Edit the chord in `src/main/index.ts`.
- **better-sqlite3 ABI mismatch** — `npm run rebuild`.
- **Black/empty screenshot on macOS** — Screen Recording permission. *Settings → Privacy & Security → Screen Recording* → toggle on, restart.
- **Save not detected** — run the `find-save` helper for your OS, or set `STS2_SAVE_DIR` in `.env`.

## License

[MIT](LICENSE) — fork it, ship it, share it with your friends.
