import type { ModelOption } from './types';

// Curated 8-model slate shown in the tray menu. Every model below was picked
// against the four hard requirements for STS2 Coach:
//   1. Vision (reads screenshots of map / shop / combat)
//   2. Strict JSON output discipline
//   3. Sub-15s typical latency (the game pauses while waiting)
//   4. Prompt caching support on OpenRouter (Patch 18 savings)
//
// OpenRouter slugs verified April 2026. Ordering: default first, then
// roughly by speed/cost ascending within tier.
//
// Models we deliberately EXCLUDED and why:
//   - claude-opus-4.6 / 4.7        — $5/$25, too slow + expensive for a real-time coach
//   - gpt-5.4-high                 — reasoning latency too high for hotkey-driven UX
//   - grok-4.x                     — weaker vision, no OpenRouter caching
//   - minimax-m2.7                 — text-only on OpenRouter, would fail vision calls
//   - qwen3.5-max-preview          — caching support unclear, skip until confirmed
//   - gemini-3.1-flash-lite        — FACTS score 40% (vs 50% for 3 Flash); too lossy
//                                    on grounded tasks for a coach reading game state
export const MODEL_OPTIONS: ModelOption[] = [
  // === Default tier: best speed/quality/price for typical advise calls ===
  { slug: 'google/gemini-3-flash',             label: 'Gemini 3 Flash (default, fast+cheap)' },
  // === Reasoning tier: when you want deeper thought ===
  { slug: 'google/gemini-3.1-pro-preview',     label: 'Gemini 3.1 Pro (best reasoning)' },
  { slug: 'anthropic/claude-sonnet-4.6',       label: 'Claude Sonnet 4.6 (best JSON discipline)' },
  { slug: 'openai/gpt-5.4',                    label: 'GPT-5.4 (well-rounded)' },
  // === Budget tier: cheaper alternatives that still hit quality bar ===
  { slug: 'openai/gpt-5.2-chat-latest',        label: 'GPT-5.2 Chat (cheaper OpenAI)' },
  // === Open-weights tier: top open models with vision + caching ===
  { slug: 'z-ai/glm-5.1',                      label: 'GLM 5.1 (top open, MIT)' },
  { slug: 'moonshotai/kimi-k2.6',              label: 'Kimi K2.6 (open, native vision)' },
  { slug: 'deepseek/deepseek-v4-pro',          label: 'DeepSeek V4 Pro (cheapest, MIT)' },
];

/**
 * Default model if none set in .env / config. Gemini 3 Flash:
 *   - Highest OmniDoc score on the entire leaderboard (90.1%)
 *   - $0.50 / $3.00 per 1M tokens — cheapest of the quality tier
 *   - ~3x faster than Pro models, fits the hotkey-driven UX
 *   - Vision-native, JSON-disciplined, supports OpenRouter caching
 */
export const DEFAULT_MODEL = 'google/gemini-3-flash';
