/**
 * Shop helper (Patch 15).
 *
 * STS2 does NOT write current shop offerings to the save file. We confirmed
 * this by inspecting an in-shop save: the only shop-related data is
 *   - relic_grab_bag.relic_id_lists.shop  (this run's eligible draw pool, ~25 IDs)
 *   - rng.counters.shops                  (visit counter)
 * Actual offerings (which 3 relics + 5-7 cards + 3 potions, and prices) are
 * computed in-memory from RNG state when the shop loads and never persisted.
 *
 * So we cannot ground the model in "the relic at slot 1 is Bag of Marbles
 * for 253g". What we CAN do, and what this module supports, is:
 *
 *   1. Surface the eligible RELIC POOL for THIS run. Instead of the model
 *      hallucinating "Kunai" from all ~150 relics, it sees a list of ~25
 *      that the screen icon must be one of. (Cards/potions don't have an
 *      equivalent per-run pool exposed in the save.)
 *
 *   2. Provide post-hoc guards in coach.ts:
 *      - In a shop context, the model must NOT name a relic/potion (icons
 *        are unreadable). Phrase by slot + price + icon color instead.
 *      - The total cost of any "Buy X for Yg and Z for Wg" pick must fit
 *        in the player's current gold.
 */

import type { Card, Relic, Potion } from '@shared/types';

export interface ShopRelicPool {
  /** This run's eligible relic IDs (e.g. ["RELIC.LAVA_LAMP", ...]). */
  ids: string[];
  /** Same list, humanised for prompt display. */
  displayNames: string[];
  /** Where in the save we read this from. */
  source: string;
}

/**
 * Read the eligible shop-relic pool for THIS run from the save.
 * Returns null if not found.
 *
 * The pool sits at one of:
 *   raw.players[0].relic_grab_bag.relic_id_lists.shop      (player-specific)
 *   raw.shared_relic_grab_bag.relic_id_lists.shop          (shared)
 * We prefer the player-specific list when present \u2014 it's the one the
 * upcoming shop will actually draw from on most runs.
 */
export function extractShopRelicPool(raw: any): ShopRelicPool | null {
  if (!raw) return null;
  const playerList: unknown = raw?.players?.[0]?.relic_grab_bag?.relic_id_lists?.shop;
  const sharedList: unknown = raw?.shared_relic_grab_bag?.relic_id_lists?.shop;
  const list =
    Array.isArray(playerList) && playerList.length > 0 ? { arr: playerList, src: 'players[0].relic_grab_bag.relic_id_lists.shop' } :
    Array.isArray(sharedList) && sharedList.length > 0 ? { arr: sharedList, src: 'shared_relic_grab_bag.relic_id_lists.shop' } :
    null;
  if (!list) return null;
  const ids = list.arr.filter((x): x is string => typeof x === 'string' && x.startsWith('RELIC.'));
  if (ids.length === 0) return null;
  return {
    ids,
    displayNames: ids.map(humanizeId),
    source: list.src,
  };
}

/**
 * Format the relic pool for the prompt. Compact, alphabetised so it diff's
 * cleanly across runs.
 */
export function formatShopPoolForPrompt(pool: ShopRelicPool | null): string {
  if (!pool) return '';
  const sorted = [...pool.displayNames].sort();
  return [
    '=== ELIGIBLE SHOP RELIC POOL (this run) ===',
    'Any relic icon you see in the shop is ONE OF these names. The shop draws ~3 of them.',
    'Use this as a candidate list \u2014 it does NOT tell you which specific 3 are offered today.',
    sorted.map((n) => `  \u2022 ${n}`).join('\n'),
    'You still cannot reliably identify a specific icon as a specific relic by sight alone.',
  ].join('\n');
}

/**
 * Standard shop-context prompt block. Always included when context=shop,
 * with or without a pool.
 */
export function shopAdvisoryBlock(): string {
  return [
    '=== SHOP \u2014 RECOGNITION RULES ===',
    'Cards: their NAMES ARE PRINTED on the card art. Read them and use them verbatim.',
    'Relics and potions: their icons are tiny pixel art with NO on-screen text labels.',
    '  \u2022 You CANNOT reliably identify a specific relic or potion by icon alone.',
    '  \u2022 Do NOT name a specific relic or potion in your pick. Use SLOT + PRICE + COLOR.',
    '  \u2022 Slot vocabulary: "leftmost / second / middle / fourth / rightmost" relic OR potion slot.',
    '  \u2022 Color/shape vocabulary: "yellow disc", "blue triangle", "green key", "red brush", "gold rune coin", etc.',
    '  \u2022 The user can hover the icon in-game to read its tooltip.',
    'Examples of GOOD picks for relics/potions:',
    '  \u2713 "Buy the cheapest relic (51g, small red brush) \u2014 it\'s likely a utility piece worth a flier."',
    '  \u2713 "Skip relic row this floor; 110g won\'t cover the 183g+ tier."',
    'Examples of BAD picks (DO NOT DO):',
    '  \u2717 "Buy Kunai for 51g."  (you cannot know it is Kunai from the icon)',
    '  \u2717 "Buy Bag of Marbles for 253g."  (icon-guessing)',
    'Cards are EXEMPT from this rule \u2014 always name them.',
    'Card removal is fixed-priced \u2014 if "Remove a card" is visible, you may name it.',
    '',
    'AFFORDABILITY: Sum the costs of every item in your pick. The total MUST be \u2264 the player\'s current gold.',
  ].join('\n');
}

// ── post-hoc guards ───────────────────────────────────────────────────────

/**
 * Real STS2 relic-name tokens (loose, lower-cased). Used to detect when the
 * model has named a specific relic in a shop pick. Pulled from training-data
 * memory; this is intentionally loose \u2014 the goal is high recall on the
 * "model named a specific relic" pattern, not a definitive game DB.
 *
 * If the model names something here in a shop pick, that's a violation.
 */
const COMMON_RELIC_NAME_TOKENS: ReadonlySet<string> = new Set([
  // STS1 carryovers + STS2 confirmed
  'kunai', 'shuriken', 'pen nib', 'akabeko', 'lantern', 'anchor', 'bag of marbles',
  'bag of preparation', 'blood vial', 'bronze scales', 'centennial puzzle', 'happy flower',
  'juzu bracelet', 'meat on the bone', 'nunchaku', 'oddly smooth stone', 'orichalcum',
  'pen pal', 'preserved insect', 'regal pillow', 'strawberry', 'tiny chest', 'tough bandages',
  'war paint', 'whetstone', 'mark of pain', 'medical kit', 'paper phrog', 'gremlin horn',
  'mercury hourglass', 'eternal feather', 'gold coin', 'ginger', 'fossilized helix',
  'horn cleat', 'kusarigama', 'letter opener', 'magic flower', 'mango', 'pear',
  'old coin', 'omelette', 'pantograph', 'paint brush', 'philosopher\u2019s stone', 'philosophers stone',
  'self-forming clay', 'sundial', 'symbiotic virus', 'turnip', 'cloak clasp',
  // STS2-specific shop pool (pulled from confirmed save)
  'lava lamp', 'screaming flagon', 'sling of courage', 'the abacus', 'membership card',
  'punch dagger', 'brimstone', 'mystic lighter', 'orrery', 'toolbox', 'wing charm',
  'chemical x', 'miniature tent', 'dingy rug', 'bread', 'royal stamp', 'cauldron',
  'belt buckle', 'dragon fruit', 'gnarled hammer', 'ringing triangle', 'ghost seed',
  'kifuda', 'dolly\u2019s mirror', 'dollys mirror', 'lee\u2019s waffle', 'lees waffle',
  'burning sticks',
]);

/** Common potion name tokens. Same purpose. */
const COMMON_POTION_NAME_TOKENS: ReadonlySet<string> = new Set([
  'fire potion', 'block potion', 'energy potion', 'skill potion', 'attack potion',
  'power potion', 'strength potion', 'dexterity potion', 'cultist potion',
  'gambler\u2019s brew', 'gamblers brew', 'liquid bronze', 'flex potion', 'speed potion',
  'fairy in a bottle', 'distilled chaos', 'essence of darkness', 'essence of steel',
  'fruit juice', 'ghost in a jar', 'liquid memories', 'regen potion', 'snecko oil',
  'smoke bomb', 'swift potion', 'cunning potion', 'heart of iron',
  'phial', 'phial of', 'ambrosia', 'ancient potion', 'common phial',
]);

/**
 * Returns matched tokens if the text looks like it names a specific relic
 * or potion. Lower-cased substring match, so "Buy Kunai for 51g" trips
 * "kunai".
 */
export function detectShopNamedItem(text: string): { kind: 'relic' | 'potion'; name: string }[] {
  const t = text.toLowerCase();
  const hits: { kind: 'relic' | 'potion'; name: string }[] = [];
  for (const name of COMMON_RELIC_NAME_TOKENS) {
    // Whole-token match \u2014 don't match "ginger" inside "gingerbread", etc.
    const re = new RegExp(`\\b${escapeRegex(name)}\\b`);
    if (re.test(t)) hits.push({ kind: 'relic', name });
  }
  for (const name of COMMON_POTION_NAME_TOKENS) {
    const re = new RegExp(`\\b${escapeRegex(name)}\\b`);
    if (re.test(t)) hits.push({ kind: 'potion', name });
  }
  return hits;
}

/**
 * Sum every "<digits>g" price token in a free-text pick.
 * "Buy Kunai for 51g and Thunderclap for 25g" \u2192 76
 * Returns null if no price tokens found.
 */
export function sumGoldPrices(text: string): number | null {
  const matches = [...text.matchAll(/(\d+)\s*g\b/gi)];
  if (matches.length === 0) return null;
  return matches.reduce((s, m) => s + Number(m[1]), 0);
}

// ── helpers ───────────────────────────────────────────────────────────────

function humanizeId(id: string): string {
  // RELIC.PAINT_BRUSH \u2192 "Paint Brush"
  const cleaned = id.replace(/^[A-Z]+\./, '').replace(/_/g, ' ').toLowerCase();
  return cleaned.replace(/\b\w/g, (c) => c.toUpperCase());
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Keep these imports referenced so unused-import linters don't strip them
// when the file evolves.
export type _Card = Card;
export type _Relic = Relic;
export type _Potion = Potion;
