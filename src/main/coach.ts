import OpenAI from 'openai';
import type { Advice, CoachRequest } from '@shared/types';
import { buildSystemPrompt } from '../../prompts/system';
import { logger } from '@shared/logger';
import {
  detectShopNamedItem,
  formatShopPoolForPrompt,
  shopAdvisoryBlock,
  sumGoldPrices,
  type ShopRelicPool,
} from './shop';
import { detectArchetype, formatArchetypeLine } from './archetype';
import { bossPriorLine } from './boss-matchups';
import { recordAdvice, recentAdviceFor, formatRecentAdviceBlock } from './advice-history';

/**
 * The coach engine.
 *
 * Uses OpenRouter as a single endpoint for every model (Claude, GPT, Gemini).
 * OpenRouter is OpenAI-wire-compatible, so we use the `openai` SDK with a
 * custom baseURL + API key.
 */

interface CoachOptions {
  apiKey: string;
  model: string;
}

export class Coach {
  private client: OpenAI;
  private model: string;

  constructor(opts: CoachOptions) {
    this.client = new OpenAI({
      apiKey: opts.apiKey,
      baseURL: 'https://openrouter.ai/api/v1',
      defaultHeaders: {
        'HTTP-Referer': 'https://github.com/local/sts2-coach',
        'X-Title': 'STS2 Coach',
      },
    });
    this.model = opts.model;
  }

  setModel(slug: string) {
    this.model = slug;
    logger.info(`Coach model → ${slug}`);
  }

  getModel() {
    return this.model;
  }

  async advise(req: CoachRequest): Promise<Advice> {
    // Patch 17: per-leg timing instrumentation. Each leg is wall-time only —
    // there is no async parallelism inside advise(), so leg sum ≈ totalMs.
    const start = Date.now();
    const promptBuildStart = start;

    // Patch 18: the system prompt is now LARGE (~6K tokens — header + strict
    // procedure + JSON schema + all knowledge files) and STABLE across calls.
    // We mark it with cache_control so Anthropic models on OpenRouter cache
    // it and bill subsequent calls at ~10% input cost. Other providers
    // ignore the field — safe no-op.
    const system = buildSystemPrompt();

    const stateBlock = req.state
      ? [
          `Character: ${req.state.character ?? 'unknown'}`,
          `Ascension: ${req.state.ascension ?? 0}`,
          `Act ${req.state.act ?? '?'} (${req.state.actId ?? '?'}) — Floor ${req.state.floor ?? '?'}`,
          `Act boss: ${req.state.bossId ?? '?'}`,
          `HP: ${req.state.hp?.current ?? '?'}/${req.state.hp?.max ?? '?'}   Gold: ${req.state.gold ?? '?'}   Max energy: ${req.state.maxEnergy ?? '?'}`,
          `Master deck (${req.state.deck.length}): ${req.state.deck
            .map((c) => c.upgrades ? `${c.name}+${c.upgrades}` : c.name)
            .join(', ') || '(empty)'}`,
          `Relics (${req.state.relics.length}): ${req.state.relics.map((r) => r.name + (r.counter != null ? `[${r.counter}]` : '')).join(', ') || '(none)'}`,
          `Potions (${req.state.potions.length}): ${req.state.potions.map((p) => p.name).join(', ') || '(none/empty slots)'}`,
          `Save last written: ${req.state.updatedAt}`,
          'NOTE: The save file reflects the MASTER DECK between rooms. It is NOT your current hand in combat. Your hand, draw pile, discard pile, and energy must be read from the screenshot.',
        ].join('\n')
      : 'No save-file state available — rely on screenshot only.';

    const contextHint = req.saveContext && req.saveContext !== 'unknown'
      ? `SAVE-FILE SAYS: currently on the "${req.saveContext}" screen. The screenshot is the source of truth — but use this as a strong prior when the screenshot is ambiguous.`
      : 'SAVE-FILE CONTEXT: unavailable.';

    const planBlockText = buildPlanBlockText(req);

    // Patch 18: deck archetype + boss prior + recent-advice context.
    // All three are tiny (1–3 lines each) and per-call, so they live in the
    // user message rather than in the cached system prompt.
    const archetype = req.state ? detectArchetype(req.state.deck) : null;
    const archetypeLine = formatArchetypeLine(archetype);
    const bossLine = bossPriorLine(req.state?.bossId);
    const recentEntries = recentAdviceFor(req.saveContext as any, 2);
    const recentBlock = formatRecentAdviceBlock(recentEntries);

    // Patch 15: shop-context guidance + per-run relic pool. Only included
    // when the save says we're on a shop screen so we don't waste tokens.
    const shopBlockText = req.saveContext === 'shop'
      ? [
          shopAdvisoryBlock(),
          req.shopBlock?.eligibleRelicNames?.length
            ? formatShopPoolForPrompt({
                ids: [],
                displayNames: req.shopBlock.eligibleRelicNames,
                source: '(passed in)',
              } satisfies ShopRelicPool)
            : '',
          req.shopBlock?.gold != null ? `Player gold (authoritative): ${req.shopBlock.gold}` : '',
        ].filter(Boolean).join('\n\n')
      : '';
    const savedMaxEnergy = req.state?.maxEnergy ?? null;
    const energyRule = [
      'ENERGY (read carefully):',
      savedMaxEnergy != null
        ? `  • Save file says baseline max energy = ${savedMaxEnergy}. This already accounts for permanent energy relics (Coffee Dripper, Cursed Key, Fusion Hammer, Slavers' Collar, etc).`
        : '  • Save file max energy is unknown.',
      '  • The AUTHORITATIVE cap for THIS TURN is the energy orb shown on the combat screen. Read it and report as seen.energy = "current/max".',
      '  • The orb max may exceed the save baseline when this-turn bonuses are active, e.g.:',
      '      - Mark of Pain (Ironclad) — +1 max energy per combat (but +2 starting curses in hand).',
      '      - Runic Dome — +1 max energy per turn (at a cost).',
      '      - Philosopher\'s Stone — +1 max energy per combat.',
      '      - Energy Potion — +2 energy for the current turn.',
      '  • Some CARDS grant energy when played ("energy_gain" > 0), effectively refunding their cost:',
      '      - Seek the Source, Through Violence, Flash of Steel (in some forms), Bloodletting, Reaper of Light, etc.',
      '  • Rule: sum of card costs across the turn, MINUS the sum of energy_gain from played cards, MUST be ≤ orb max.',
      '  • If the orb is unreadable or context is not combat, fall back to the save baseline; if both are unknown, assume 3.',
    ].join('\n');

    // Patch 18: per-call user message is now ONLY the dynamic state.
    // The procedure + JSON schema live in the cached system prompt, so we
    // don't pay to send them on every call.
    const userText = [
      'CURRENT RUN STATE (between-room truth from the save file):',
      stateBlock,
      '',
      contextHint,
      '',
      archetypeLine,
      bossLine,
      '',
      planBlockText,
      shopBlockText ? '\n' + shopBlockText : '',
      '',
      energyRule,
      '',
      recentBlock,
      req.userNote ? `\nExtra context from user: ${req.userNote}` : '',
    ].filter(Boolean).join('\n');

    logger.debug('Coach request', { model: this.model, hasState: !!req.state });
    const promptBuildMs = Date.now() - promptBuildStart;
    const llmStart = Date.now();

    // Patch 18: cache_control on the (large, stable) system prompt and
    // the (large, stable) user-text procedure leftover. OpenRouter passes
    // this through to Anthropic models for prompt caching. Non-Anthropic
    // providers silently drop the unknown field.
    //
    // We use the OpenAI SDK with `as any` because the SDK's strict types
    // don't yet include cache_control on content parts. The wire format
    // is what matters — OpenRouter accepts it.
    const response = await this.client.chat.completions.create({
      model: this.model,
      messages: [
        {
          role: 'system',
          content: [
            {
              type: 'text',
              text: system,
              cache_control: { type: 'ephemeral' },
            } as any,
          ] as any,
        },
        {
          role: 'user',
          content: [
            { type: 'text', text: userText },
            {
              type: 'image_url',
              image_url: { url: `data:${req.mimeType ?? 'image/jpeg'};base64,${req.screenshotB64}` },
            },
          ],
        },
      ],
      max_tokens: 1200,
      temperature: 0.2,
      // Tell OpenRouter we want usage details back (tokens + cache).
      ...({ usage: { include: true } } as any),
    });

    const llmMs = Date.now() - llmStart;
    const parseStart = Date.now();

    const text = response.choices[0]?.message?.content ?? '';
    const parsed = extractJson(text);

    // Patch 18: extract usage. OpenRouter shapes vary by provider; we read
    // both the standard OpenAI fields and Anthropic's cache extensions.
    const usage = extractUsage(response);

    // Post-hoc checks: we don't block — we annotate so you can see it on the overlay.
    const seen = parsed.seen ?? {};
    const hand: string[] = Array.isArray(seen.hand) ? seen.hand : [];
    const pickText: string = String(parsed.pick ?? '');
    const warnings: string[] = [];

    // 1) Hand-mismatch check (existing, from patch 04).
    const handWarn = detectHandMismatch(pickText, hand, seen.context);
    if (handWarn) warnings.push(handWarn);

    // 2) Context vs save-file mismatch — log only, don't warn overlay by default.
    //    (The screenshot is authoritative; we just want to *see* misses in the logs.)
    if (req.saveContext && req.saveContext !== 'unknown' && seen.context && seen.context !== 'unknown') {
      const equivalent = saveAndScreenContextsAgree(req.saveContext, seen.context);
      if (!equivalent) {
        logger.info(
          `context mismatch: save="${req.saveContext}" screen="${seen.context}" ` +
          `evidence="${seen.context_evidence ?? 'n/a'}"`,
        );
      }
    }

    // 3) Energy cap check + truncation (Patch 08: dynamic orb-based cap).
    //    Priority:  screenshot energy orb (seen.energy "x/y") → save baseline → 3.
    const savedMax = req.state?.maxEnergy ?? null;
    const orbCap = parseOrbMax(seen.energy);
    const energyCap = orbCap ?? savedMax ?? 3;
    const energyCapSource = orbCap != null ? 'orb' : (savedMax != null ? 'save' : 'default');

    const planCards: Array<{ name: string; cost: number; target?: string; energy_gain?: number }> =
      Array.isArray(parsed.plan_cards) ? parsed.plan_cards : [];
    let truncatedPick: string | null = null;
    if (seen.context === 'combat' && planCards.length > 0) {
      const result = enforceEnergyCap(planCards, energyCap);
      if (result.overBudget) {
        warnings.push(
          `Planned ${result.netCost} energy (cost ${result.grossCost} − gain ${result.totalGain}) ` +
          `but cap is ${energyCap} (from ${energyCapSource}). ` +
          `Truncated to: ${result.keptCards.map((c) => c.name).join(', ') || '(none fits)'}`,
        );
        truncatedPick = result.keptCards.length
          ? `Play ${result.keptCards.map((c) => c.target ? `${c.name} → ${c.target}` : c.name).join(', then ')}.`
          : null;
      }
    }

    // 4) Map-context sanity: pick must not start with "Take" etc.
    if (seen.context === 'map') {
      const badPrefix = /^(take|use|play|cast|buy|smith|rest|skip)\b/i.test(pickText.trim());
      if (badPrefix) {
        warnings.push(`Pick "${pickText.slice(0, 60)}" doesn't look like a map choice — should be "Go to <node>".`);
      }
    }

    // 5) Friendly-target check (Patch 13): never let an attack target an ally.
    //    The model can mis-identify the Necrobinder's Osty (and similar summons)
    //    as enemies. We catch any plan_cards.target that matches an ally name,
    //    surface it loudly, and rewrite the pick if possible.
    const allies: Array<{ name?: string }> = Array.isArray(seen.allies) ? seen.allies : [];
    const allyNames = new Set(
      allies
        .map((a) => (typeof a?.name === 'string' ? a.name.trim().toLowerCase() : ''))
        .filter(Boolean),
    );
    // Always also block well-known specific summon names even if the model
    // didn't list them.
    for (const known of KNOWN_FRIENDLY_SUMMONS) allyNames.add(known);

    const friendlyTargetHits: string[] = [];
    // Whole-word patterns indicating "my own minion" — these slip into target
    // text as words like "minion", "pet", "summon", or as model-written
    // composites like "Skeleton/Minion".
    const friendlyWordRe = /\b(?:minion|summon|pet|ally|skeleton)\b/i;
    // Real STS2 enemies whose names contain those words — don't false-positive.
    // Add to this list if you encounter an enemy that the detector misfires on.
    const enemyExceptions: ReadonlyArray<RegExp> = [
      // (none known yet — left as an extension point)
    ];
    const isFriendlyTargetText = (target: string): boolean => {
      if (!target) return false;
      const t = target.trim().toLowerCase();
      // Exact match against model-provided ally names or generic terms.
      if (allyNames.has(t)) return true;
      if (GENERIC_FRIENDLY_TERMS.includes(t)) return true;
      // Substring match for specific named summons (low false-positive risk).
      for (const named of KNOWN_FRIENDLY_SUMMONS) {
        if (t.includes(named)) return true;
      }
      // Substring match for model-provided ally names not already covered.
      for (const ally of allyNames) {
        if (KNOWN_FRIENDLY_SUMMONS.includes(ally)) continue;
        if (ally.length >= 4 && t.includes(ally)) return true;
      }
      // Whole-word "minion / summon / pet / ally / skeleton" appearing in the
      // target slot is almost always the model referring to its own summon.
      // Real enemies have proper names (Jaw Worm, Knowledge Demon, etc.).
      if (friendlyWordRe.test(t)) {
        if (!enemyExceptions.some((re) => re.test(t))) return true;
      }
      return false;
    };

    if (seen.context === 'combat' && (allyNames.size > 0 || GENERIC_FRIENDLY_TERMS.length > 0)) {
      for (const card of planCards) {
        const target = card.target ?? '';
        if (!target) continue;
        if (isFriendlyTargetText(target) && isAttackCardName(card.name)) {
          friendlyTargetHits.push(`${card.name} → ${card.target}`);
        }
      }
      // Also scan the free-text pick for "→ <ally>" patterns.
      const pickLower = pickText.toLowerCase();
      const arrowMatches = [...pickLower.matchAll(/(?:→|->)\s*([^,;.→]+)/g)];
      for (const m of arrowMatches) {
        const targetText = m[1].trim();
        if (isFriendlyTargetText(targetText)) {
          friendlyTargetHits.push(`pick text targets "${targetText}"`);
        }
      }
    }
    let friendlyOverridePick: string | null = null;
    if (friendlyTargetHits.length) {
      warnings.push(
        `Targeting error: attack(s) aimed at friendly summon — ${friendlyTargetHits.join('; ')}. ` +
        `Re-target enemies on the right side of the board.`,
      );
      logger.warn(`Friendly-target violation: ${friendlyTargetHits.join('; ')}`);
      // Try to redirect to the highest-HP enemy (usually the boss) automatically.
      const enemies: Array<{ name?: string; hp?: string }> = Array.isArray(seen.enemies) ? seen.enemies : [];
      const target = pickPrimaryEnemy(enemies);
      if (target) {
        friendlyOverridePick = `Re-target enemies (suggest ${target}). The previous plan attacked your own summon — verify before playing.`;
      }
    }

    // 6) Shop guards (Patch 15).
    //    a) Recognition: in a shop, the model must NOT name a relic/potion.
    //       If it does, append a warning and rewrite the pick to slot/price
    //       phrasing.
    //    b) Affordability: sum every Ng in the pick — it must fit in the
    //       player's gold. If not, warn loudly.
    let shopOverridePick: string | null = null;
    if (seen.context === 'shop') {
      const named = detectShopNamedItem(pickText);
      if (named.length > 0) {
        const namesList = [...new Set(named.map((n) => `${n.name} (${n.kind})`))].join(', ');
        warnings.push(
          `Shop recognition error: pick named ${namesList}. ` +
          `Relic/potion icons are unreadable — use slot+price+color instead.`,
        );
        logger.warn(`Shop named-item violation: ${namesList} in pick "${pickText.slice(0, 80)}"`);
        shopOverridePick =
          'Verify on screen: hover the icon to confirm. The model named a specific ' +
          `${named[0].kind} from its art (${named[0].name}), which is unreliable. ` +
          'Use slot + price to identify, or skip.';
      }

      const gold = req.shopBlock?.gold ?? req.state?.gold ?? null;
      const sumPrice = sumGoldPrices(pickText);
      if (sumPrice != null && gold != null && sumPrice > gold) {
        warnings.push(
          `Affordability: pick totals ${sumPrice}g but you only have ${gold}g. ` +
          `Drop the most expensive item or skip.`,
        );
        logger.warn(`Shop affordability violation: ${sumPrice}g > ${gold}g`);
        // Don't override the pick text — the warning is enough; the user
        // can read it on the overlay and decide. Overriding would lose the
        // model's reasoning entirely.
      }
    }

    const finalPick = shopOverridePick ?? friendlyOverridePick ?? truncatedPick ?? (parsed.pick ?? 'Unable to parse recommendation.');

    const parseMs = Date.now() - parseStart;
    const latencyMs = Date.now() - start;

    const timings: NonNullable<Advice['timings']> = {
      screenshotMs: req.screenshotMs,
      promptBuildMs,
      llmMs,
      parseMs,
      // ttsMs is populated by the caller (doAdvise) after speak() resolves.
      totalMs: latencyMs,
    };

    const advice: Advice = {
      pick:        finalPick,
      reasoning:   parsed.reasoning ?? text.slice(0, 200),
      runnerUp:    parsed.runner_up ?? parsed.runnerUp ?? undefined,
      longForm:    buildLongForm(parsed, warnings, req.planBlock, planCards, energyCap, truncatedPick, archetype, usage),
      contextGuess: seen.context ?? parsed.context ?? 'unknown',
      model:       this.model,
      latencyMs,
      createdAt:   new Date().toISOString(),
      mapAscii:    req.planBlock?.asciiOverlay ?? req.planBlock?.ascii,
      planSummary: req.planBlock?.summary,
      usage,
      timings,
    };

    // Patch 18: roll into recent-advice buffer for next call's prompt.
    recordAdvice(advice);

    const cacheTag = usage?.cachedReadTokens
      ? ` cache_read=${usage.cachedReadTokens}`
      : (usage?.cachedWriteTokens ? ` cache_write=${usage.cachedWriteTokens}` : '');
    logger.info(
      `Advice (${latencyMs}ms) [${advice.contextGuess}]${cacheTag}: ${advice.pick}` +
      (warnings.length ? ` ⚠ ${warnings.join(' | ')}` : ''),
    );
    return advice;
  }
}

/**
 * Patch 18: extract usage from an OpenAI/OpenRouter chat completion response.
 * Handles both the standard `prompt_tokens`/`completion_tokens` shape and
 * Anthropic's cache extensions (`cache_creation_input_tokens`,
 * `cache_read_input_tokens`).
 */
function extractUsage(response: any): Advice['usage'] | undefined {
  const u = response?.usage;
  if (!u || typeof u !== 'object') return undefined;
  const out: NonNullable<Advice['usage']> = {};
  if (typeof u.prompt_tokens === 'number') out.inputTokens = u.prompt_tokens;
  if (typeof u.completion_tokens === 'number') out.outputTokens = u.completion_tokens;
  // Anthropic-via-OpenRouter exposes these on the usage object; OpenRouter
  // also surfaces them under prompt_tokens_details on some providers.
  const cacheRead =
    u.cache_read_input_tokens ?? u.prompt_tokens_details?.cached_tokens ?? null;
  const cacheWrite = u.cache_creation_input_tokens ?? null;
  if (typeof cacheRead === 'number') out.cachedReadTokens = cacheRead;
  if (typeof cacheWrite === 'number') out.cachedWriteTokens = cacheWrite;
  // OpenRouter sometimes returns total cost under cost or usage.cost (USD).
  const cost = response?.cost ?? u.cost ?? null;
  if (typeof cost === 'number') out.costUsd = cost;
  return Object.keys(out).length ? out : undefined;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Specific named friendly summons. Safe to substring-match because none of
 * these names overlap with STS2 enemies. Add new entries when new characters
 * or summons appear.
 */
const KNOWN_FRIENDLY_SUMMONS: ReadonlyArray<string> = [
  // Necrobinder
  'osty',
  'skeleton hand',
  'skeletal hand',
  // Regent
  'sovereign blade',
];

/**
 * Generic words that indicate "my own minion" — only match as exact target,
 * never as substrings (otherwise enemies like "Demonic Minion" would trip).
 */
const GENERIC_FRIENDLY_TERMS: ReadonlyArray<string> = [
  'my minion', 'my pet', 'my ally', 'my summon',
  'own minion', 'own pet', 'own ally', 'own summon',
  'friendly minion', 'friendly summon',
];

/**
 * Heuristic: does this card name suggest an ATTACK card (i.e. one whose
 * target must be an enemy)? We err on the side of treating ambiguous cards
 * as attacks so we don't miss real targeting errors.
 */
function isAttackCardName(name: string | undefined): boolean {
  if (!name) return false;
  const lower = name.toLowerCase();
  // Known Osty-buff/heal cards — these LEGITIMATELY target the friendly summon.
  const friendlyTargetingCards = [
    'bodyguard', 'reanimate', 'spur', 'necro mastery',
    'friendship', 'shared fate', 'unleash', 'protector', 'rattle',
    'fetch', 'flatten', 'right hand hand', "sic 'em", 'sic em',
    'afterlife', 'dirge', 'capture spirit', 'borrowed time',
  ];
  if (friendlyTargetingCards.some((c) => lower.includes(c))) return false;
  // Most cards with these substrings are direct attacks on enemies.
  const attackHints = [
    'strike', 'scourge', 'putrefy', 'sow', 'bash', 'slash',
    'cleave', 'thunderclap', 'pommel', 'iron wave', 'reaper',
    'feed', 'rampage', 'whirlwind', 'sword boomerang', 'heavy blade',
    'twin strike', 'bludgeon', 'searing blow',
  ];
  if (attackHints.some((h) => lower.includes(h))) return true;
  // Default: assume any card with an explicit `target` is an attack unless we
  // recognized it as a friendly-targeting card above. The caller only invokes
  // this when target is non-empty, so this is the right default.
  return true;
}

/**
 * Pick a sensible enemy to suggest re-targeting to: prefer the one with the
 * highest visible HP (usually the boss), falling back to the first enemy.
 */
function pickPrimaryEnemy(enemies: Array<{ name?: string; hp?: string }>): string | null {
  if (!enemies.length) return null;
  let best: { name: string; hp: number } | null = null;
  for (const e of enemies) {
    if (!e?.name) continue;
    const hp = parseHpMax(e.hp);
    if (best == null || hp > best.hp) best = { name: e.name, hp };
  }
  return best?.name ?? enemies[0]?.name ?? null;
}

function parseHpMax(hp: string | undefined): number {
  if (!hp) return 0;
  const m = /\d+\s*\/\s*(\d+)/.exec(hp);
  return m ? parseInt(m[1], 10) : 0;
}

/** Treats save-context and screenshot-context as equivalent even when they use
 *  overlapping names (e.g. save calls it "combat", screenshot might say "boss_reward"
 *  right after the fight ends). We only assert agreement on clearly disjoint pairs. */
function saveAndScreenContextsAgree(saveCtx: string, screenCtx: string): boolean {
  if (saveCtx === screenCtx) return true;
  // A few known near-equivalents:
  if (saveCtx === 'combat' && (screenCtx === 'card_reward' || screenCtx === 'relic_reward' || screenCtx === 'boss_reward')) return true;
  if (saveCtx === 'rest' && screenCtx === 'rest_site') return true;
  if (saveCtx === 'event' && (screenCtx === 'shop' || screenCtx === 'event')) return true;
  if (saveCtx === 'unknown' || screenCtx === 'unknown') return true;
  return false;
}

/** Parse seen.energy strings like "3/3", "2/4", "5", " 1 / 3 ". Returns max (the y),
 *  or null if we can't parse. */
export function parseOrbMax(s: unknown): number | null {
  if (typeof s !== 'string') return null;
  const trimmed = s.trim();
  if (!trimmed || trimmed.toLowerCase() === 'null') return null;
  // "x/y" form
  const m = trimmed.match(/^\s*(\d+)\s*\/\s*(\d+)\s*$/);
  if (m) {
    const y = parseInt(m[2], 10);
    return Number.isFinite(y) && y > 0 ? y : null;
  }
  // Bare number — interpret as both current and max.
  const bare = parseInt(trimmed, 10);
  return Number.isFinite(bare) && bare > 0 ? bare : null;
}

/**
 *  Simulate playing the plan left-to-right against a running energy balance.
 *  Start at `cap` energy. Each card subtracts its cost, then adds its energy_gain.
 *  We keep a card iff, at the moment we play it, the running balance is ≥ its cost.
 *
 *  Example with cap=3:
 *    [Bash(2), SeekTheSource(0, gain=1), Strike(1), Strike(1)]
 *       balance 3 → play Bash (−2)  → 1
 *       balance 1 → play Seek  (−0, +1) → 2
 *       balance 2 → play Strike (−1) → 1
 *       balance 1 → play Strike (−1) → 0   → full plan fits
 *    grossCost=4, totalGain=1, netCost=3, cap=3 → not over-budget.
 */
export function enforceEnergyCap(
  planCards: Array<{ name: string; cost: number; target?: string; energy_gain?: number }>,
  cap: number,
): {
  grossCost: number;
  totalGain: number;
  netCost: number;
  keptCards: typeof planCards;
  overBudget: boolean;
} {
  let balance = cap;
  let grossCost = 0;
  let totalGain = 0;
  const kept: typeof planCards = [];
  let locked = false;
  for (const c of planCards) {
    const cost = Math.max(0, Math.floor(Number(c.cost) || 0));
    const gain = Math.max(0, Math.floor(Number(c.energy_gain) || 0));
    grossCost += cost;
    totalGain += gain;
    if (!locked && balance >= cost) {
      balance = balance - cost + gain;
      kept.push({ ...c, cost, ...(gain ? { energy_gain: gain } : {}) });
    } else {
      locked = true;
    }
  }
  const netCost = grossCost - totalGain;
  return { grossCost, totalGain, netCost, keptCards: kept, overBudget: netCost > cap };
}

function extractJson(text: string): any {
  try { return JSON.parse(text); } catch {}
  const m = text.match(/\{[\s\S]*\}/);
  if (m) { try { return JSON.parse(m[0]); } catch {} }
  return {};
}

/**
 * If the pick says "Use Bash" but `Bash` isn't in the enumerated hand (and
 * we're in combat), surface a warning. This is a belt-and-suspenders check
 * on top of the prompt instruction — models sometimes still slip.
 */
function detectHandMismatch(pick: string, hand: string[], context: string): string | null {
  if (context !== 'combat') return null;
  if (!hand.length) return null;
  // Extract probable card name: take leading words before "to" / "." / ","
  const m = pick.match(/^(?:use|play|cast)\s+([A-Z][\w+ '-]*?)(?=\s+(?:to|on|into|for|against|,|\.|$))/i)
         || pick.match(/^([A-Z][\w+ '-]{2,}?)(?=\s+(?:to|on|,|\.|$))/);
  if (!m) return null;
  const cardName = m[1].trim().toLowerCase();
  const normalized = hand.map((h) => h.toLowerCase());
  const hit = normalized.some((h) => h.includes(cardName) || cardName.includes(h.replace(/\+\d*$/, '').trim()));
  if (!hit) {
    return `"${m[1].trim()}" not found in enumerated hand [${hand.join(', ')}] — possible misread.`;
  }
  return null;
}

function buildLongForm(
  parsed: any,
  warnings: string[],
  planBlock: CoachRequest['planBlock'] | undefined,
  planCards: Array<{ name: string; cost: number; target?: string }>,
  energyCap: number | null,
  truncatedPick: string | null,
  archetype: { label: string; description: string } | null,
  usage: Advice['usage'] | undefined,
): string | undefined {
  const lf = parsed.long_form ?? parsed.longForm;
  const seen = parsed.seen;
  const parts: string[] = [];
  if (warnings.length) parts.push(warnings.map((w) => `⚠ ${w}`).join('\n'));
  if (truncatedPick) {
    parts.push('(Pick above is the energy-capped truncation of the model\'s plan.)');
  }
  if (planCards.length && energyCap != null) {
    const gross = planCards.reduce((a, c) => a + (Number(c.cost) || 0), 0);
    const gain = planCards.reduce((a, c) => a + (Number((c as any).energy_gain) || 0), 0);
    const net = gross - gain;
    const badge = net > energyCap ? `⚠ OVER by ${net - energyCap}` : 'OK';
    const capTag = `cap ${energyCap}`;
    const gainTag = gain > 0 ? ` (gross ${gross} − gain ${gain} = net ${net})` : '';
    parts.push(
      `— Combat plan — ${net}/${energyCap} energy · ${capTag} · ${badge}${gainTag}\n` +
      planCards.map((c, i) => {
        const g = Number((c as any).energy_gain) || 0;
        const costTag = g > 0 ? `${c.cost}e −${g}e back` : `${c.cost}e`;
        return `  ${i + 1}. ${c.name} (${costTag})${c.target ? ` → ${c.target}` : ''}`;
      }).join('\n'),
    );
  }
  if (lf) parts.push(String(lf));
  if (seen) {
    const bits: string[] = [];
    if (Array.isArray(seen.hand) && seen.hand.length) bits.push(`Hand: ${seen.hand.join(', ')}`);
    if (seen.energy) bits.push(`Energy: ${seen.energy}`);
    if (Array.isArray(seen.enemies) && seen.enemies.length) {
      bits.push('Enemies: ' + seen.enemies.map((e: any) => `${e.name ?? '?'} ${e.hp ?? ''} (${e.intent ?? '?'})`).join('; '));
    }
    if (Array.isArray(seen.offered) && seen.offered.length) bits.push(`Offered: ${seen.offered.join(', ')}`);
    if (bits.length) parts.push('— Seen —\n' + bits.join('\n'));
  }
  if (planBlock) {
    const remain = planBlock.remaining.slice(0, 12)
      .map((r) => `${shortType(r.type)}(${r.col},${r.row})`).join(' → ');
    const pieces: string[] = [];
    pieces.push(`Plan (${planBlock.kind}): ${planBlock.summary}`);
    if (remain) pieces.push(`Remaining: ${remain}`);
    if (planBlock.reasons?.length) pieces.push(`Trigger: ${planBlock.reasons.join(', ')}`);
    // NB: do NOT include the ASCII grid here — the overlay shows it in its own
    // dedicated map block. Including it again would duplicate the render and
    // also tempt the model to echo the full grid back into its reasoning text.
    parts.push('— Map plan —\n' + pieces.join('\n'));
  }
  if (seen?.context_evidence) parts.push(`Context evidence: ${seen.context_evidence}`);
  if (parsed.confidence) parts.push(`Confidence: ${parsed.confidence}`);
  if (archetype) parts.push(`Archetype read: ${archetype.label}`);
  if (usage && (usage.inputTokens || usage.cachedReadTokens)) {
    const cacheBits: string[] = [];
    if (usage.cachedReadTokens) cacheBits.push(`${usage.cachedReadTokens} cache hit`);
    if (usage.cachedWriteTokens) cacheBits.push(`${usage.cachedWriteTokens} cache write`);
    const cacheStr = cacheBits.length ? ` (${cacheBits.join(', ')})` : '';
    parts.push(
      `Tokens: in ${usage.inputTokens ?? '?'}, out ${usage.outputTokens ?? '?'}${cacheStr}`,
    );
  }
  return parts.length ? parts.join('\n\n') : undefined;
}

function shortType(t: string): string {
  switch (t) {
    case 'monster': return 'm';
    case 'elite': return 'E';
    case 'rest_site': return 'R';
    case 'shop': return '$';
    case 'treasure': return 'T';
    case 'unknown': return '?';
    case 'boss': return 'B';
    case 'ancient': return 'A';
    default: return t[0] ?? '?';
  }
}

function buildPlanBlockText(req: CoachRequest): string {
  if (!req.planBlock) return 'MAP PLAN: (no active plan — first map advice of run, or the save hasn\'t been written yet)';
  const pb = req.planBlock;
  const nextChoices = pb.nextChoices.map((n) => `${shortType(n.type)} @ col ${n.col}, row ${n.row} (key ${n.key})`).join(' | ');
  const remaining = pb.remaining.slice(0, 16).map((r) => `${shortType(r.type)}(${r.col},${r.row})`).join(' → ');
  return [
    `MAP PLAN (${pb.kind}):`,
    `  Summary: ${pb.summary}`,
    `  Current node: ${pb.currentKey ?? '(act start)'}`,
    `  Next choices (THE USER CAN ONLY PICK ONE OF THESE IF ON MAP): ${nextChoices || '(none — path complete)'}`,
    `  Planner wants path: ${remaining || '(plan exhausted)'}`,
    pb.reasons?.length ? `  Re-plan triggers: ${pb.reasons.join(', ')}` : '',
  ].filter(Boolean).join('\n');
}
