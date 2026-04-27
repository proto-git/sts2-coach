# Backlog

History of pre-1.0 work and the v0.2.0 plan.

---

## ✅ Shipped in v0.1.0 (April 27, 2026)

- **Patch 16** — Read-only mode (TTS off toggle) + hotkey feedback (instant ack + optional chime) + pending state with 30s safety timer
- **Patch 17** — Latency debug panel: per-leg timing (screenshot / LLM / TTS), stacked bars, last-50 history, "Want it faster?" panel, Diagnostics tab
- **Patch 18** — Smarter context (archetype, upcoming room, boss matchup, recent advice history) + OpenRouter prompt caching for the ~5.6K-token system prompt
- **Patch 19a** — Hardened JSON parser (markdown fence stripping, balanced-brace walker) + raw-response logging on parse failure
- **Patch 19b** — Fix deck-dump pending-state bug that caused phantom 30s "No response" timeouts
- **Patch 19c** — Curated 8-model slate (Gemini 3 Flash default, Gemini 3.1 Pro, Sonnet 4.6, GPT-5.4, GPT-5.2 Chat, GLM 5.1, Kimi K2.6, DeepSeek V4 Pro)
- **Multi-monitor fix** — Drag overlay freely across displays, auto-rescue on display change, "Bring to cursor" tray entry

---

## 🚧 v0.2.0 plan

### Patch 20 — Text push-back / conversation mode
**Why**: User disagrees with a card pick and wants the model to defend or revise.

**Scope**:
- Advise overlay gains an input box (toggle with `i` key when overlay is focused)
- Submit a follow-up → next advise call gets:
  - The previous user-visible advice
  - The user's objection
  - The screenshot (re-captured) and current save state
  - System prompt addendum: "The user is questioning your previous advice. Either defend it with new reasoning OR revise if their point is valid. Be explicit about which."
- Last 3 turns of (advice, user-pushback, response) kept in memory for the current screen context. Cleared on context change.

**Acceptance**:
- User can type "but isn't there an elite next? wouldn't Shrug It Off be safer?" and get a reasoned response.
- Conversation state visible on overlay (chat-style stack).
- Context resets when the screen context changes.

---

### Patch 21 — Voice push-to-talk
**Why**: Push back on a recommendation in your own voice without breaking flow.

**Scope**:
- New hotkey: ⌥⇧A (or hold ⌥⇧S?) — while held, record mic via `navigator.mediaDevices.getUserMedia`.
- On release, send audio to OpenAI Whisper or Deepgram. (OpenRouter doesn't proxy STT.)
- Transcribed text feeds into Patch 20's conversation plumbing.
- Overlay shows transcript while recording so user can verify.
- Setting to choose STT provider.

**Acceptance**:
- Hold hotkey → red recording indicator on overlay.
- Release → transcript appears, advise call fires automatically.

---

### Patch 22 — System TTS + first-run onboarding
**System TTS**:
- macOS `say`, Windows SAPI via `powershell -c` as a zero-config zero-cost option.
- Document clearly in Settings: "System TTS is free but lower quality. OpenAI TTS sounds best but needs a key."
- (Defer ElevenLabs to post-1.0.)

**First-run onboarding**:
- Detect missing keys on launch → open Settings with a friendly "Welcome! Add an OpenRouter key to start." banner.
- Inline test buttons: "Test LLM" / "Test TTS" so users verify before ⌥⇧S.

---

## 🪦 Resolved questions

- **Q**: Can TTS use OpenRouter so users only manage one key?
  **A**: No. OpenRouter is text-only. TTS and STT both need separate providers. System TTS will be the zero-key fallback (Patch 22).

---

## Distribution

v0.1.0 ships unsigned macOS .dmg + Windows .exe via GitHub Releases. Friends right-click → Open on macOS, "Run anyway" on Windows. Code-signing deferred until there's enough demand to justify the certs ($99 Apple + ~$300 Windows EV per year).
