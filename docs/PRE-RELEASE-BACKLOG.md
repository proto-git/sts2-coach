# Pre-1.0 Backlog

Curated list of enhancements before tagging `v0.1.0` and distributing to friends.
Ordered roughly by user value × implementation effort.

---

## P0 — Ship-blockers / high-value polish

### 1. Read-only mode (TTS off toggle) + speed/cost reduction
**Why**: Biggest single lever for both latency and cost. Some users will prefer
silent overlay-only.

**Scope**:
- Add a top-level `tts.enabled` toggle in Settings (separate from provider).
- When disabled, skip the entire TTS request — no API call, no audio stream,
  no extra latency.
- Keep `provider: 'off'` working as today (already shipped in Patch 14) but
  surface it as a clean checkbox: "Speak advice aloud".
- Tray menu: "Mute coach" quick toggle.

**Acceptance**:
- Toggle off → no OpenAI TTS network call in logs, advise roundtrip drops by
  the TTS leg (~400–1200ms saved on perceived completion).
- State persists across restarts via `config.json`.

---

### 2. Hotkey feedback (instant ack) + optional system ding
**Why**: Right now ⌥⇧S has no acknowledgement until the LLM responds. Users
think it didn't fire and re-press, queueing duplicate calls.

**Scope**:
- On hotkey press, immediately:
  - Show overlay with a "Thinking…" pending state (spinner + the hotkey label).
  - Optionally play a short OS notification sound (macOS: `afplay
    /System/Library/Sounds/Pop.aiff`; Windows: `[console]::Beep` or PowerShell
    `Media.SoundPlayer`).
- Settings toggle: "Play sound on hotkey" (default on).
- Visual pending state should also show which hotkey was hit ("Advise" vs
  "Deck dump") so user knows what's coming.

**Acceptance**:
- Press ⌥⇧S → overlay appears within ~50ms with "Thinking… (Advise)".
- Configurable ding plays.
- Final advice replaces the pending state when ready.
- Re-pressing during pending shows "(already running)" instead of queueing.

---

### 3. Latency debug panel
**Why**: When the coach feels slow, users (and you) need to know *which leg*
to optimize. Right now it's a black box.

**Scope**:
- Instrument every advise call with timing spans:
  - `screenshot_ms`
  - `save_read_ms`
  - `prompt_build_ms`
  - `llm_request_ms` (network + inference)
  - `parse_ms`
  - `tts_request_ms`
  - `tts_first_audio_ms`
  - `total_ms`
- Stash the latest 50 in memory; expose via Settings → "Diagnostics" tab.
- Show a stacked bar per call so the bottleneck is visually obvious.
- Log every call to SQLite (extend existing `db.ts` advice table).
- Tray menu: "Open latency log".

**User-facing speed-up advice (surface in Diagnostics)**:
- "Want it faster?" panel with three switches:
  1. Switch to a smaller model (link opens model dropdown)
  2. Disable TTS (link toggles read-only mode)
  3. Reduce screenshot resolution (advanced)

**Acceptance**:
- Diagnostics tab shows a table + stacked bar of last 50 advise calls.
- Each row is clickable → shows full prompt/response/timing in detail.
- Median timings displayed at the top.

---

## P1 — Major UX wins

### 4. Push-to-talk follow-up question
**Why**: Single biggest UX upgrade. Lets the user push back on a
recommendation in their own voice without breaking flow.

**Scope**:
- New hotkey: ⌥⇧A (or hold ⌥⇧S?) — while held, record mic via
  `navigator.mediaDevices.getUserMedia`.
- On release, send audio to OpenAI Whisper (`audio/transcriptions`) or
  Deepgram. (OpenRouter does NOT proxy STT either — needs separate provider.)
- Transcribed text goes into `req.userNote` of the next advise call, along
  with the **previous advice** as context: "User pushed back on your last
  recommendation — they said: '<transcript>'. Reconsider with this context."
- Overlay shows transcript while recording so user can verify.
- Setting to choose STT provider (OpenAI Whisper / Deepgram / off).

**Acceptance**:
- Hold hotkey → red recording indicator on overlay.
- Release → transcript appears, advise call fires automatically.
- Model response addresses the user's specific point (handled by
  conversation-aware prompt).

---

### 5. Push-back / conversation mode (text + voice)
**Why**: Tightly related to #4 but also useful with typed input. User
disagrees with a card pick and wants the model to defend or revise.

**Scope**:
- The advise overlay gains an input box (toggle with `i` key when overlay is
  focused).
- Submit a follow-up → next advise call gets:
  - The previous user-visible advice
  - The user's objection
  - The screenshot (re-captured) and current save state
  - System prompt addendum: "The user is questioning your previous advice.
    Either defend it with new reasoning OR revise if their point is valid.
    Be explicit about which."
- Last 3 turns of (advice, user-pushback, response) kept in memory for the
  current screen context. Cleared on context change (combat → reward, shop
  → map, etc.).

**Acceptance**:
- User can type "but isn't there an elite next? wouldn't Shrug It Off be
  safer?" and get a reasoned response that either holds or revises.
- Conversation state visible on overlay (chat-style stack).
- Context resets when the screen context changes.

---

### 6. Better LLM context (the "up the cinder context" item)
**Why**: Right now we send the master deck, relics, potions, gold, HP, act,
floor, plan block, shop block. Plenty good but could be smarter:

**Things to add to context**:
- **Current run plan** — `planner.ts` already has this; make sure it's
  always in the prompt with the current step highlighted.
- **Deck archetype detection** — pre-classify the deck (e.g. "Demon Form
  scaling", "Barricade tank", "Corruption exhaust", "no clear archetype yet")
  and feed as a single line. This helps card picks immensely.
- **Upcoming room** — `map.ts` knows the next 1–2 rooms. Critical for "do I
  need block now?" decisions.
- **Boss matchup** — act boss is in state but not weighted; add "vs <boss>:
  <quick advice>" line from a small static lookup.
- **Recent advice history** — last 2 advise outputs as background so the
  model doesn't contradict itself across rapid hits.

**Cost-conscious additions**:
- **Prompt caching** — OpenRouter supports Anthropic prompt caching for
  long stable system prompts. Move the static system prompt + knowledge
  files into a cached prefix. Should cut input token cost ~80% on cached
  hits.
- Knowledge files already auto-loaded — verify they're stable enough to
  cache (no per-call interpolation in them).
- Per-call diff: only send changed deck/relics if the previous call was
  recent (<60s ago) — skip the full state block, send a delta. (Risky;
  evaluate after caching is in.)

**Acceptance**:
- Prompt size measured before/after — cached prefix marked as cacheable.
- Token usage in Diagnostics (#3) shows cached vs uncached input split.
- Archetype detection visible in the prompt and in advice reasoning.

---

## P2 — Polish before tagging v0.1.0

### 7. TTS provider expansion
- Add **System TTS** (macOS `say`, Windows SAPI via `powershell -c`) as a
  zero-config zero-cost option.
- Document clearly in Settings: "System TTS is free but lower quality.
  OpenAI TTS sounds best but needs a key."
- (Out of scope) ElevenLabs — defer to post-1.0.

### 8. First-run onboarding
- Detect missing keys on launch → open Settings with a friendly "Welcome!
  Add an OpenRouter key to start." banner.
- Inline test buttons: "Test LLM" / "Test TTS" so users verify before
  alt+shift+S.

---

## Resolved questions

- **Q**: Can TTS use OpenRouter so users only manage one key?
  **A**: No. OpenRouter is text-only (LLM completions). TTS and STT both
  need separate providers (OpenAI, Deepgram, ElevenLabs, etc.). To minimize
  user setup, ship System TTS as the zero-key fallback (#7).

---

## Suggested patch sequence

- **Patch 16**: #1 (read-only mode) + #2 (hotkey feedback) — small, ships
  perceived speed + responsiveness in one go.
- **Patch 17**: #3 (latency debug panel) — depends on existing IPC
  infrastructure from Patch 14 settings window.
- **Patch 18**: #6 (context + caching) — biggest ROI on cost and quality.
- **Patch 19**: #5 (text push-back / conversation mode) — establishes
  conversation state plumbing.
- **Patch 20**: #4 (voice push-to-talk) — builds on #5's plumbing.
- **Patch 21**: #7 (System TTS) + #8 (onboarding) — pre-release polish.
- **v0.1.0 tag** + GitHub Releases distribution.
