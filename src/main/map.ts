import type { GameState } from '@shared/types';

/**
 * Map extraction + path analysis for Slay the Spire 2.
 *
 * STS2 saves the act map under:
 *   raw.acts[current_act_index].saved_map = {
 *     width, height, start, boss,
 *     points: [ { coord:{col,row}, type, children:[{col,row},...], ... } ],
 *   }
 *
 * Plus:
 *   raw.visited_map_coords: [{col,row}, ...]   // breadcrumb; LAST = current
 *   raw.map_point_history[actIdx]: [ perRoomOutcome, ... ]
 *
 * Node types observed: monster, elite, rest_site, shop, treasure, unknown,
 * ancient (start), boss.
 */

export type MapNodeType =
  | 'monster'
  | 'elite'
  | 'rest_site'
  | 'shop'
  | 'treasure'
  | 'unknown'
  | 'ancient'
  | 'boss';

export interface MapCoord {
  col: number;
  row: number;
}

export interface MapNode {
  key: string;            // `${col},${row}`
  col: number;
  row: number;
  type: MapNodeType;
  children: string[];     // keys of child nodes
  /** Unique letters reachable downstream (fast reachability summary). */
  reachableTypes?: Set<MapNodeType>;
}

export interface MapModel {
  width: number;
  height: number;
  start: MapNode;
  boss: MapNode;
  nodes: Record<string, MapNode>;
  /** visited breadcrumb in order; last element is current position. */
  visited: string[];
  /** Current node key (=last visited). null if just at start / nothing visited. */
  current: string | null;
  /** Immediate next reachable nodes (children of current, or start's children if nothing visited). */
  nextChoices: MapNode[];
  /** Boss id e.g. ENCOUNTER.WATERFALL_GIANT_BOSS */
  bossId: string | null;
  /** Act index (0-based). */
  actIndex: number;
}

function coordKey(c: { col: number; row: number }): string {
  return `${c.col},${c.row}`;
}

/** Extract the current act's map from a raw save JSON. Returns null if unavailable. */
export function extractMap(raw: any): MapModel | null {
  if (!raw || typeof raw !== 'object') return null;
  const actIndex = typeof raw.current_act_index === 'number' ? raw.current_act_index : 0;
  const act = raw?.acts?.[actIndex];
  const sm = act?.saved_map;
  if (!sm || !Array.isArray(sm.points)) return null;

  const nodes: Record<string, MapNode> = {};

  const addNode = (p: any): MapNode | null => {
    const c = p?.coord;
    if (!c || typeof c.col !== 'number' || typeof c.row !== 'number') return null;
    const key = coordKey(c);
    const children: string[] = Array.isArray(p.children)
      ? p.children
          .filter((ch: any) => ch && typeof ch.col === 'number' && typeof ch.row === 'number')
          .map((ch: any) => coordKey(ch))
      : [];
    const node: MapNode = {
      key,
      col: c.col,
      row: c.row,
      type: (p.type || 'unknown') as MapNodeType,
      children,
    };
    nodes[key] = node;
    return node;
  };

  for (const p of sm.points) addNode(p);

  // Start/boss are separate from points[].
  let startNode = sm.start ? addNode(sm.start) : null;
  let bossNode = sm.boss ? addNode(sm.boss) : null;
  if (bossNode) bossNode.type = 'boss';
  if (startNode && startNode.type !== 'ancient') startNode.type = 'ancient';

  if (!startNode || !bossNode) return null;

  // Visited breadcrumb.
  const visitedRaw: any[] = Array.isArray(raw.visited_map_coords) ? raw.visited_map_coords : [];
  const visited: string[] = visitedRaw
    .filter((v) => v && typeof v.col === 'number' && typeof v.row === 'number')
    .map((v) => coordKey(v));

  const current = visited.length ? visited[visited.length - 1] : null;

  // Next choices: children of current node. If we haven't visited anything yet,
  // use start's children.
  const anchor = current ? nodes[current] : startNode;
  const nextChoices: MapNode[] = (anchor?.children ?? [])
    .map((k) => nodes[k])
    .filter(Boolean);

  // Compute reachableTypes for each node (downstream summary).
  computeReachability(nodes);

  return {
    width: typeof sm.width === 'number' ? sm.width : 7,
    height: typeof sm.height === 'number' ? sm.height : 16,
    start: startNode,
    boss: bossNode,
    nodes,
    visited,
    current,
    nextChoices,
    bossId: act?.rooms?.boss_id ?? null,
    actIndex,
  };
}

/** For each node, compute the set of node types reachable by descending children. */
function computeReachability(nodes: Record<string, MapNode>) {
  const memo = new Map<string, Set<MapNodeType>>();
  const visit = (key: string, stack: Set<string>): Set<MapNodeType> => {
    if (memo.has(key)) return memo.get(key)!;
    if (stack.has(key)) return new Set(); // cycle guard (shouldn't happen)
    stack.add(key);
    const n = nodes[key];
    const acc = new Set<MapNodeType>();
    if (n) {
      acc.add(n.type);
      for (const ch of n.children) {
        for (const t of visit(ch, stack)) acc.add(t);
      }
    }
    stack.delete(key);
    memo.set(key, acc);
    return acc;
  };
  for (const k of Object.keys(nodes)) {
    nodes[k].reachableTypes = visit(k, new Set());
  }
}

// ---------------------------------------------------------------------------
// Path planning
// ---------------------------------------------------------------------------

export interface PathStep {
  key: string;
  col: number;
  row: number;
  type: MapNodeType;
}

export interface PathCandidate {
  anchorKey: string;                    // node we planned from (inclusive)
  steps: PathStep[];                    // ordered nodes from anchor → boss (exclusive of anchor)
  fullKeys: string[];                   // [anchor, ...steps] — convenient for replanSlice
  counts: Record<MapNodeType, number>;  // tally by type along the path
  score: number;                        // higher = better per current priorities
}

/** Priorities used by the scoring function. Tweakable per-strategy. */
export interface PathPriorities {
  wantShop: number;     // +N for each shop
  wantRest: number;     // +N for each rest_site
  wantElite: number;    // +/- N per elite (negative if avoiding)
  wantTreasure: number; // +N per treasure (can't usually choose, but include)
  wantUnknown: number;  // +/- N per unknown
  /** Penalize paths longer than necessary (shouldn't matter with identical depth, but safety). */
  lengthPenalty: number;
}

export const DEFAULT_PRIORITIES: PathPriorities = {
  wantShop: 1.0,
  wantRest: 2.0,
  wantElite: 1.2,      // elites = card reward, generally worth it
  wantTreasure: 0.5,
  wantUnknown: 0.3,
  lengthPenalty: 0.0,
};

/** Enumerate all simple paths from `startKey` to boss. Caps results to avoid blowup. */
export function allPathsToBoss(
  map: MapModel,
  startKey: string,
  maxPaths = 500,
): string[][] {
  const bossKey = map.boss.key;
  const out: string[][] = [];
  const dfs = (cur: string, trail: string[]) => {
    if (out.length >= maxPaths) return;
    if (cur === bossKey) {
      out.push(trail.slice());
      return;
    }
    const n = map.nodes[cur];
    if (!n) return;
    for (const ch of n.children) {
      trail.push(ch);
      dfs(ch, trail);
      trail.pop();
      if (out.length >= maxPaths) return;
    }
  };
  dfs(startKey, [startKey]);
  return out;
}

function scorePath(
  path: string[],
  map: MapModel,
  prio: PathPriorities,
): PathCandidate {
  const counts: Record<MapNodeType, number> = {
    monster: 0, elite: 0, rest_site: 0, shop: 0,
    treasure: 0, unknown: 0, ancient: 0, boss: 0,
  };
  const steps: PathStep[] = [];
  for (let i = 1; i < path.length; i++) {
    const n = map.nodes[path[i]];
    if (!n) continue;
    counts[n.type] = (counts[n.type] ?? 0) + 1;
    steps.push({ key: n.key, col: n.col, row: n.row, type: n.type });
  }
  const score =
    counts.shop * prio.wantShop +
    counts.rest_site * prio.wantRest +
    counts.elite * prio.wantElite +
    counts.treasure * prio.wantTreasure +
    counts.unknown * prio.wantUnknown -
    steps.length * prio.lengthPenalty;
  return { anchorKey: path[0], steps, fullKeys: path.slice(), counts, score };
}

/** Rank candidate paths from anchor to boss. anchor defaults to current (or start). */
export function rankPaths(
  map: MapModel,
  prio: PathPriorities = DEFAULT_PRIORITIES,
  anchorKey?: string,
): PathCandidate[] {
  const anchor = anchorKey ?? map.current ?? map.start.key;
  const paths = allPathsToBoss(map, anchor);
  const ranked = paths.map((p) => scorePath(p, map, prio)).sort((a, b) => b.score - a.score);
  return ranked;
}

/**
 * Given a "plan path" (list of node keys from some earlier anchor to boss), and
 * the current node, determine whether the plan is still valid (= current node is
 * on the path, or a child of a step in the path). Returns the remaining portion
 * of the path beginning at/after current.
 */
export function replanSlice(plan: string[], currentKey: string | null): string[] | null {
  if (!plan || plan.length === 0) return null;
  if (!currentKey) return plan.slice();
  const idx = plan.indexOf(currentKey);
  if (idx < 0) return null; // off-path — need re-plan
  return plan.slice(idx);
}

// ---------------------------------------------------------------------------
// ASCII renderer
// ---------------------------------------------------------------------------

export interface RenderAsciiOptions {
  /** Optional vertical viewport: only render rows in [minRow, maxRow]. */
  rowWindow?: { minRow: number; maxRow: number };
  /** Show legend lines under the grid (default true). */
  legend?: boolean;
}

/**
 * Render the map as a compact ASCII grid.
 *   .   empty
 *   m   monster   E   elite    R   rest    $   shop
 *   T   treasure  ?   unknown  A   ancient (start)  B   boss
 * Visited nodes are wrapped in [brackets]. Current position uses {curly}.
 * Planned path uses <angle> brackets.
 */
export function renderAscii(
  map: MapModel,
  planKeys?: string[],
  opts: RenderAsciiOptions = {},
): string {
  const TYPE_CHAR: Record<MapNodeType, string> = {
    monster: 'm',
    elite: 'E',
    rest_site: 'R',
    shop: '$',
    treasure: 'T',
    unknown: '?',
    ancient: 'A',
    boss: 'B',
  };
  const width = map.width;
  const totalMaxRow = Math.max(map.boss.row, ...Object.values(map.nodes).map((n) => n.row));
  const visitedSet = new Set(map.visited);
  const planSet = new Set(planKeys ?? []);
  const currentKey = map.current;

  const minRow = Math.max(0, opts.rowWindow?.minRow ?? 0);
  const maxRow = Math.min(totalMaxRow, opts.rowWindow?.maxRow ?? totalMaxRow);
  const truncatedTop = maxRow < totalMaxRow;
  const truncatedBottom = minRow > 0;

  const lines: string[] = [];
  if (truncatedTop) lines.push(`     ⋯ ${totalMaxRow - maxRow} row(s) toward boss ⋯`);
  // Print rows from boss → start so up is up
  for (let row = maxRow; row >= minRow; row--) {
    let line = '';
    for (let col = 0; col < width; col++) {
      const key = `${col},${row}`;
      const n = map.nodes[key];
      let cell: string;
      if (!n) {
        cell = ' . ';
      } else {
        const ch = TYPE_CHAR[n.type] ?? '?';
        if (key === currentKey) cell = `{${ch}}`;
        else if (visitedSet.has(key)) cell = `[${ch}]`;
        else if (planSet.has(key)) cell = `<${ch}>`;
        else cell = ` ${ch} `;
      }
      line += cell;
    }
    lines.push(`r${String(row).padStart(2, ' ')} ${line}`);
  }
  if (truncatedBottom) lines.push(`     ⋯ ${minRow} row(s) below ⋯`);
  lines.push('    ' + Array.from({ length: width }, (_, i) => ` ${i} `).join(''));
  if (opts.legend !== false) {
    lines.push('legend: A=start m=monster E=elite R=rest $=shop T=treasure ?=unknown B=boss');
    lines.push('        [ ]=visited  { }=current  < >=planned');
  }
  return lines.join('\n');
}

/**
 * Compute a sensible viewport for the overlay map render: a window of
 * `radius` rows above and below the current (or visited) position, expanded
 * to always include the boss and the start. Keeps the overlay compact.
 */
export function computeViewport(map: MapModel, radius = 8): { minRow: number; maxRow: number } {
  const focusRow = (() => {
    if (map.current && map.nodes[map.current]) return map.nodes[map.current].row;
    if (map.visited.length) {
      const last = map.nodes[map.visited[map.visited.length - 1]];
      if (last) return last.row;
    }
    return map.start.row;
  })();
  const totalMaxRow = Math.max(map.boss.row, ...Object.values(map.nodes).map((n) => n.row));
  // Default window: focus ± radius.
  let minRow = Math.max(0, focusRow - radius);
  let maxRow = Math.min(totalMaxRow, focusRow + radius);
  // If we're close enough to boss/start, just show that end fully.
  if (totalMaxRow - focusRow <= radius + 2) maxRow = totalMaxRow;
  if (focusRow <= radius + 2) minRow = 0;
  return { minRow, maxRow };
}

// ---------------------------------------------------------------------------
// Save → GameState bridge helpers
// ---------------------------------------------------------------------------

/**
 * Lightweight "where am I?" inference using save data only.
 * Returns 'map' if we're sitting on the map (no active combat), 'combat' if
 * the save shows an active encounter, or 'unknown'.
 *
 * We don't trust this blindly — the screenshot context can override — but it
 * gives us a strong prior.
 */
export function inferSaveContext(raw: any): 'map' | 'combat' | 'event' | 'shop' | 'rest' | 'unknown' {
  if (!raw) return 'unknown';
  // Active combat shows up as a populated `combat` / `active_room` block in the save.
  // We look for common shapes; if we can't tell, we say 'unknown'.
  const act = raw?.acts?.[raw?.current_act_index ?? 0];
  const activeRoom = act?.rooms?.active ?? raw?.active_room ?? null;
  if (activeRoom) {
    const t = String(activeRoom.type ?? activeRoom.room_type ?? '').toLowerCase();
    if (t.includes('combat') || t.includes('monster') || t.includes('elite') || t.includes('boss')) return 'combat';
    if (t.includes('event')) return 'event';
    if (t.includes('shop')) return 'shop';
    if (t.includes('rest') || t.includes('campfire')) return 'rest';
  }
  // Fallback: if the last visited node exists but has no active room, we're on the map.
  if (Array.isArray(raw.visited_map_coords) && raw.visited_map_coords.length > 0) return 'map';
  return 'unknown';
}

/** Small string summary of the current plan for prompts / overlay. */
export function summarizePath(p: PathCandidate | null): string {
  if (!p) return '(no plan)';
  const pieces = p.steps.map((s) => {
    switch (s.type) {
      case 'monster': return 'm';
      case 'elite': return 'E';
      case 'rest_site': return 'R';
      case 'shop': return '$';
      case 'treasure': return 'T';
      case 'unknown': return '?';
      case 'boss': return 'B';
      default: return s.type[0];
    }
  });
  const c = p.counts;
  return `${pieces.join('→')}   (${c.rest_site}R ${c.shop}$ ${c.elite}E ${c.monster}m ${c.treasure}T ${c.unknown}?)`;
}
