# STS2 Coach v0.1.2

A small but important fix to the model slate.

## What's fixed

### OpenRouter model ID corrections (Patch 19e)
Two model slugs in our curated 8-model lineup were stale and caused a `400 not a valid model ID` error on advise() calls:

| Before | After |
|---|---|
| `google/gemini-3-flash` | `google/gemini-3-flash-preview` |
| `openai/gpt-5.2-chat-latest` | `openai/gpt-5.2-chat` |

All eight slugs were re-verified against `https://openrouter.ai/api/v1/models` on 2026-04-27. The other six (Gemini 3.1 Pro, Claude Sonnet 4.6, GPT-5.4, GLM 5.1, Kimi K2.6, DeepSeek V4 Pro) were already correct.

### Auto-migration for existing users
If you installed v0.1.0 or v0.1.1 and your saved default was `google/gemini-3-flash`, the app now silently rewrites your config on first launch to the working slug — no settings dance required.

## How to upgrade

The in-app update banner from v0.1.1 will surface this release within ~30 seconds of your next launch. Click the amber "⬆︎ Update" pill in the overlay header → opens the release page → grab the new installer.

If you're still on v0.1.0 (no banner), download manually from the [Releases page](https://github.com/proto-git/sts2-coach/releases/tag/v0.1.2).

## Downloads

- **macOS (Apple Silicon)** — `STS2 Coach-0.1.2-arm64.dmg`
- **Windows (x64)** — `STS2 Coach Setup 0.1.2.exe`

## Full changelog

- `fix(models)`: correct stale OpenRouter slugs + add config migration ([7229fc0](https://github.com/proto-git/sts2-coach/commit/7229fc0))
