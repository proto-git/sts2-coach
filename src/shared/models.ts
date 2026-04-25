import type { ModelOption } from './types';

// Curated list shown in the tray menu. Any OpenRouter vision-capable model
// works — add/remove as you like. Ordering inside each provider is roughly
// "flagship → mid → budget".
//
// OpenRouter slugs verified against openrouter.ai (April 2026).
export const MODEL_OPTIONS: ModelOption[] = [
  // Anthropic
  { slug: 'anthropic/claude-opus-4.7',         label: 'Claude Opus 4.7 (flagship, slow)' },
  { slug: 'anthropic/claude-sonnet-4.6',       label: 'Claude Sonnet 4.6 (recommended)' },
  { slug: 'anthropic/claude-haiku-4.5',        label: 'Claude Haiku 4.5 (fast/cheap)' },
  // OpenAI
  { slug: 'openai/gpt-5.4',                    label: 'GPT-5.4 (flagship)' },
  { slug: 'openai/gpt-5.4-mini',               label: 'GPT-5.4 mini (balanced)' },
  { slug: 'openai/gpt-5.4-nano',               label: 'GPT-5.4 nano (fastest)' },
  // Google
  { slug: 'google/gemini-3-pro-preview',       label: 'Gemini 3 Pro (flagship)' },
  { slug: 'google/gemini-3-flash-preview',     label: 'Gemini 3 Flash (fast/cheap)' },
];

/** Default model if none set in .env. Sonnet 4.6 is the sweet spot for vision + reasoning. */
export const DEFAULT_MODEL = 'anthropic/claude-sonnet-4.6';
