// Shared types between main process and overlay renderer.

export interface Card {
  id: string;
  name: string;
  upgrades: number;   // 0 = unupgraded, 1 = +, 2 = ++, etc.
  rarity?: string;
  type?: string;      // attack | skill | power | status | curse
}

export interface Relic {
  id: string;
  name: string;
  counter?: number | null;
}

export interface Potion {
  id: string;
  name: string;
}

export interface GameState {
  character: string | null;       // e.g. 'IRONCLAD'
  ascension: number | null;
  floor: number | null;           // derived from map_point_history length
  act: number | null;             // 1-indexed act
  actId: string | null;           // e.g. 'ACT.UNDERDOCKS'
  bossId: string | null;          // e.g. 'ENCOUNTER.WATERFALL_GIANT_BOSS'
  maxEnergy: number | null;
  hp: { current: number; max: number } | null;
  gold: number | null;
  deck: Card[];
  relics: Relic[];
  potions: Potion[];
  runTimeSec: number | null;      // total run duration so far
  saveTimeEpoch: number | null;   // from save_time field
  gameMode: string | null;
  /** Friendly summary line for the overlay footer. */
  summary?: string;
  // Raw save object — kept so the LLM can fall back to anything the parser missed.
  raw?: unknown;
  updatedAt: string; // ISO timestamp when we last parsed the file
}

export type AdviceContext =
  | 'card_reward'
  | 'relic_reward'
  | 'shop'
  | 'event'
  | 'combat'
  | 'boss'
  | 'map'
  | 'unknown';

export interface Advice {
  pick: string;              // primary recommendation, terse
  reasoning: string;         // one-sentence justification
  runnerUp?: string;         // alternative if primary is unavailable
  longForm?: string;         // full reasoning, shown on hover/expand
  contextGuess?: AdviceContext;
  model: string;
  latencyMs: number;
  createdAt: string;
  /** Rendered ASCII map (Patch 06), shown in overlay Full Reasoning. */
  mapAscii?: string;
  /** Short plan summary like "m→E→R→$→m→B (3R 1$ 1E …)". */
  planSummary?: string;
}

export interface CoachRequest {
  screenshotB64: string;     // base64, no data URL prefix
  mimeType?: string;         // defaults to 'image/jpeg'
  state: GameState | null;
  userNote?: string;         // optional extra context typed by user
  /** Save-derived context (Patch 06): tells the coach what the save thinks we're doing. */
  saveContext?: 'map' | 'combat' | 'event' | 'shop' | 'rest' | 'unknown';
  /** Optional shop block (Patch 15). Included when saveContext === 'shop'. */
  shopBlock?: {
    /** Eligible relic IDs for this run's shops, e.g. ["RELIC.LAVA_LAMP", ...]. */
    eligibleRelicNames: string[];
    /** Player's current gold (mirror of state.gold for guard convenience). */
    gold: number | null;
  };
  /** Optional current plan block — provided when saveContext === 'map'. */
  planBlock?: {
    summary: string;
    /** Full ASCII map (no row cropping) — sent to the model for planning. */
    ascii: string;
    /** Cropped ASCII map for the overlay UI (current ± ~8 rows). Falls back to `ascii`. */
    asciiOverlay?: string;
    currentKey: string | null;
    nextChoices: { key: string; type: string; col: number; row: number }[];
    remaining: { key: string; type: string; col: number; row: number }[];
    kind: 'initial' | 'replan' | 'confirmed';
    reasons?: string[];
  };
}

export interface ModelOption {
  slug: string;              // openrouter model id
  label: string;             // pretty name
}
