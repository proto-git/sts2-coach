import type { GameState, Card, Relic } from '@shared/types';
import type { Database } from 'better-sqlite3';
import {
  extractMap, rankPaths, summarizePath, replanSlice,
  DEFAULT_PRIORITIES, type MapModel, type PathCandidate, type PathPriorities,
} from './map';
import { logger } from '@shared/logger';

/**
 * Adaptive map planner.
 *
 *   • On Act start (first GameState we see for an act), compute an initial
 *     priority-weighted path to the boss and save it.
 *   • After each room transition (current node changes), check for deviation
 *     triggers — HP, gold, deck, relics, path prunes. If any fire, re-plan.
 *   • Otherwise: confirm the existing plan (no LLM call).
 *
 * The saved plan is cached in SQLite keyed by (runId, actIndex, version). When
 * ⌥⇧S is pressed on the map, the coach reads the cached plan instead of
 * inventing new advice from a screenshot.
 */

export interface PlanRow {
  runId: string;
  actIndex: number;
  version: number;                  // bumps on each re-plan
  anchorKey: string;
  fullKeys: string[];               // full path keys
  steps: { key: string; type: string; col: number; row: number }[];
  counts: Record<string, number>;
  score: number;
  priorities: PathPriorities;
  reason: string;                   // why we built/rebuilt this plan
  snapshot: PlanSnapshot;           // state at plan time, for later deviation comparisons
  createdAt: string;
}

export interface PlanSnapshot {
  hpPct: number | null;             // current / max
  hp: { current: number; max: number } | null;
  gold: number | null;
  deckSize: number;
  relicIds: string[];
  curseCount: number;
  floor: number | null;
}

export type DeviationKind =
  | 'low_hp'
  | 'high_gold'
  | 'new_key_relic'
  | 'curse_acquired'
  | 'dead_card'
  | 'path_pruned'
  | 'off_path'
  | 'act_changed'
  | 'new_act';

export interface DeviationResult {
  deviated: boolean;
  reasons: DeviationKind[];
  details: string[];                // human-readable explanations
}

/** HP threshold — if we're below this, bias toward rests and avoid elites. */
const LOW_HP_PCT = 0.5;
/** Gold threshold — at/above this, bias toward shops. */
const HIGH_GOLD = 150;

/** A tiny hard-coded list of relics that should trigger re-planning when acquired.
 *  Keep short; the idea is "significant" ones that change your strategy. */
const KEY_RELICS = new Set([
  'RELIC.STRAWBERRY', 'RELIC.PEAR', 'RELIC.MANGO',          // max hp boosters
  'RELIC.ANCIENT_TEA_SET', 'RELIC.PRESERVED_INSECT',        // rest / elite helpers
  'RELIC.BAG_OF_PREPARATION', 'RELIC.PRECARIOUS_SHEARS',    // draw / deck
  'RELIC.CALIPERS', 'RELIC.BRONZE_SCALES',                  // core build
]);

/** Recognize curse/status cards by id prefix. */
function isCurse(c: Card): boolean {
  const id = (c.id || '').toUpperCase();
  return id.startsWith('CARD.CURSE_') || id.includes('.CURSE_') || id.includes('_CURSE');
}

/** Build a snapshot for later deviation comparisons. */
export function snapshotState(s: GameState): PlanSnapshot {
  const curseCount = s.deck.filter(isCurse).length;
  const hpPct = s.hp && s.hp.max > 0 ? s.hp.current / s.hp.max : null;
  return {
    hpPct,
    hp: s.hp,
    gold: s.gold,
    deckSize: s.deck.length,
    relicIds: s.relics.map((r) => r.id),
    curseCount,
    floor: s.floor,
  };
}

/** Priorities derived from current state. */
export function prioritiesFor(s: GameState, prev?: PlanSnapshot): PathPriorities {
  const p: PathPriorities = { ...DEFAULT_PRIORITIES };
  const snap = snapshotState(s);

  // Low HP → value rest higher, penalize elites.
  if (snap.hpPct != null && snap.hpPct < LOW_HP_PCT) {
    p.wantRest += 2;
    p.wantElite -= 2;
  }
  // High gold → value shop higher.
  if ((snap.gold ?? 0) >= HIGH_GOLD) {
    p.wantShop += 2;
  }
  // If a curse appeared since last plan, we want a shop (to remove).
  if (prev && snap.curseCount > prev.curseCount) {
    p.wantShop += 1;
  }
  return p;
}

/** Detect deviations between two snapshots. */
export function detectDeviation(
  prev: PlanSnapshot,
  cur: PlanSnapshot,
  relics: Relic[],
  priorPath: string[],
  currentKey: string | null,
  prevActIndex: number,
  curActIndex: number,
): DeviationResult {
  const reasons: DeviationKind[] = [];
  const details: string[] = [];

  if (curActIndex !== prevActIndex) {
    reasons.push('act_changed');
    details.push(`act ${prevActIndex + 1} → ${curActIndex + 1}`);
  }

  if (cur.hpPct != null && cur.hpPct < LOW_HP_PCT &&
      (prev.hpPct == null || prev.hpPct >= LOW_HP_PCT)) {
    reasons.push('low_hp');
    details.push(`HP dropped below 50% (${cur.hp?.current}/${cur.hp?.max})`);
  }

  if ((cur.gold ?? 0) >= HIGH_GOLD && (prev.gold ?? 0) < HIGH_GOLD) {
    reasons.push('high_gold');
    details.push(`gold ≥ ${HIGH_GOLD} (${cur.gold})`);
  }

  const newRelics = cur.relicIds.filter((id) => !prev.relicIds.includes(id));
  for (const id of newRelics) {
    if (KEY_RELICS.has(id)) {
      reasons.push('new_key_relic');
      const r = relics.find((rr) => rr.id === id);
      details.push(`acquired key relic: ${r?.name ?? id}`);
    }
  }

  if (cur.curseCount > prev.curseCount) {
    reasons.push('curse_acquired');
    details.push(`+${cur.curseCount - prev.curseCount} curse/status card(s)`);
  }

  if (currentKey && priorPath.length && !priorPath.includes(currentKey)) {
    reasons.push('off_path');
    details.push(`moved to ${currentKey}, which isn't on the plan`);
  }

  return { deviated: reasons.length > 0, reasons, details };
}

// ---------------------------------------------------------------------------
// SQLite plans table
// ---------------------------------------------------------------------------

export function createPlansTable(db: Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS plans (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id        TEXT    NOT NULL,
      act_index     INTEGER NOT NULL,
      version       INTEGER NOT NULL,
      anchor_key    TEXT    NOT NULL,
      full_keys     TEXT    NOT NULL,    -- JSON
      steps         TEXT    NOT NULL,    -- JSON
      counts        TEXT    NOT NULL,    -- JSON
      score         REAL    NOT NULL,
      priorities    TEXT    NOT NULL,    -- JSON
      reason        TEXT    NOT NULL,
      snapshot      TEXT    NOT NULL,    -- JSON
      created_at    TEXT    NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_plans_run_act
      ON plans(run_id, act_index, version DESC);
  `);
}

export function insertPlan(db: Database, row: PlanRow) {
  db.prepare(`
    INSERT INTO plans
      (run_id, act_index, version, anchor_key, full_keys, steps, counts, score, priorities, reason, snapshot, created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    row.runId, row.actIndex, row.version, row.anchorKey,
    JSON.stringify(row.fullKeys), JSON.stringify(row.steps),
    JSON.stringify(row.counts), row.score,
    JSON.stringify(row.priorities), row.reason,
    JSON.stringify(row.snapshot), row.createdAt,
  );
}

export function getLatestPlan(db: Database, runId: string, actIndex: number): PlanRow | null {
  const row: any = db.prepare(`
    SELECT * FROM plans
    WHERE run_id = ? AND act_index = ?
    ORDER BY version DESC
    LIMIT 1
  `).get(runId, actIndex);
  if (!row) return null;
  return {
    runId: row.run_id,
    actIndex: row.act_index,
    version: row.version,
    anchorKey: row.anchor_key,
    fullKeys: JSON.parse(row.full_keys),
    steps: JSON.parse(row.steps),
    counts: JSON.parse(row.counts),
    score: row.score,
    priorities: JSON.parse(row.priorities),
    reason: row.reason,
    snapshot: JSON.parse(row.snapshot),
    createdAt: row.created_at,
  };
}

// ---------------------------------------------------------------------------
// Planner
// ---------------------------------------------------------------------------

export interface PlanDecision {
  plan: PlanRow;
  kind: 'initial' | 'replan' | 'confirmed';
  deviation?: DeviationResult;
  /** Current node key at decision time (may be null at act start). */
  currentKey: string | null;
  /** Remaining steps from current → boss (sliced from plan). */
  remaining: { key: string; type: string; col: number; row: number }[];
  /** A rendered ASCII map (for the overlay / prompt). */
  ascii?: string;
  /** One-line summary suitable for the prompt or log. */
  summary: string;
}

/** Build a run id from the save state — stable within one run. */
export function runIdFor(s: GameState): string {
  // STS2 doesn't expose a UUID but character + ascension + save_time at run-start
  // is effectively unique. We approximate: use character + start time if we have
  // it, else character + act.
  const ch = s.character ?? 'unknown';
  const t = s.saveTimeEpoch ?? 0;
  // Use the save time when the run was at act 0 floor 0 as a proxy — but we
  // don't track that cleanly. Good-enough: character + first-seen timestamp
  // bucket (run_time=0 floor=1).
  return `${ch}#${t - (s.runTimeSec ?? 0)}`;
}

/** Make a fresh plan at the current map anchor. */
export function buildFreshPlan(
  runId: string,
  s: GameState,
  map: MapModel,
  reason: string,
  prev?: PlanSnapshot,
): PlanRow {
  const priorities = prioritiesFor(s, prev);
  const ranked = rankPaths(map, priorities, map.current ?? map.start.key);
  const best: PathCandidate = ranked[0];
  const snap = snapshotState(s);
  return {
    runId,
    actIndex: map.actIndex,
    version: 1,
    anchorKey: best.anchorKey,
    fullKeys: best.fullKeys,
    steps: best.steps.map((st) => ({ key: st.key, type: st.type, col: st.col, row: st.row })),
    counts: best.counts,
    score: best.score,
    priorities,
    reason,
    snapshot: snap,
    createdAt: new Date().toISOString(),
  };
}

/**
 * The one entry point the save-watcher calls on every GameState.
 * Returns a decision and persists the plan when needed.
 */
export function planOnState(db: Database, s: GameState): PlanDecision | null {
  const map = extractMap(s.raw);
  if (!map) {
    logger.info('planner: no map in save, skipping');
    return null;
  }
  const runId = runIdFor(s);
  const existing = getLatestPlan(db, runId, map.actIndex);

  // Initial plan if none exists for this (run, act).
  if (!existing) {
    const fresh = buildFreshPlan(runId, s, map, 'initial-plan');
    insertPlan(db, fresh);
    return makeDecision(fresh, map, 'initial');
  }

  // Deviation check.
  const curSnap = snapshotState(s);
  const dev = detectDeviation(
    existing.snapshot, curSnap,
    s.relics,
    existing.fullKeys,
    map.current,
    existing.actIndex,
    map.actIndex,
  );

  if (!dev.deviated) {
    // Still on plan — confirm without writing a new row.
    return makeDecision(existing, map, 'confirmed');
  }

  // Re-plan.
  const fresh = buildFreshPlan(runId, s, map, dev.reasons.join(','), existing.snapshot);
  fresh.version = existing.version + 1;
  insertPlan(db, fresh);
  return makeDecision(fresh, map, 'replan', dev);
}

function makeDecision(
  plan: PlanRow,
  map: MapModel,
  kind: 'initial' | 'replan' | 'confirmed',
  deviation?: DeviationResult,
): PlanDecision {
  const currentKey = map.current;
  const sliced = replanSlice(plan.fullKeys, currentKey) ?? plan.fullKeys;
  const remaining = sliced
    .slice(currentKey && sliced[0] === currentKey ? 1 : 0) // drop current from remaining
    .map((k) => {
      const n = map.nodes[k];
      return n ? { key: k, type: n.type as string, col: n.col, row: n.row } : null;
    })
    .filter(Boolean) as { key: string; type: string; col: number; row: number }[];

  const pcSummary = summarizePath({
    anchorKey: plan.anchorKey,
    steps: plan.steps as any,
    fullKeys: plan.fullKeys,
    counts: plan.counts as any,
    score: plan.score,
  });
  let summary = `Plan v${plan.version} (${kind})  ${pcSummary}`;
  if (deviation) summary += `  — trigger: ${deviation.reasons.join(', ')}`;

  return {
    plan,
    kind,
    deviation,
    currentKey,
    remaining,
    summary,
  };
}
