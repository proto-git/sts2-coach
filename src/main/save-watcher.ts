import chokidar, { FSWatcher } from 'chokidar';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { EventEmitter } from 'events';
import type { GameState, Card, Relic, Potion } from '@shared/types';
import { logger } from '@shared/logger';

/**
 * Watches the Slay the Spire 2 save directory and emits GameState
 * whenever a save file changes.
 *
 * Save layout (STS2 v0.103.x, schema_version 16) is identical across OSes;
 * only the root directory differs:
 *   <root>/steam/<SteamID>/profile.save
 *   <root>/steam/<SteamID>/profile<N>/saves/current_run.save     ← the one we watch
 *   <root>/steam/<SteamID>/profile<N>/saves/progress.save        ← metaprogression
 *   <root>/steam/<SteamID>/profile<N>/saves/history/<epoch>.run  ← completed runs
 *   <root>/steam/<SteamID>/profile<N>/saves/prefs.save
 *
 * Per-platform <root> defaults:
 *   macOS:   ~/Library/Application Support/SlayTheSpire2
 *   Windows: %APPDATA%\SlayTheSpire2  (typically C:\Users\<you>\AppData\Roaming\SlayTheSpire2)
 *   Linux:   ~/.local/share/SlayTheSpire2  (or Proton: $STEAM_HOME/steamapps/compatdata/<id>/pfx/...)
 *
 * Override at runtime with the STS2_SAVE_DIR env var if your install is in an
 * unusual location.
 */

function macSaveDir(): string {
  return path.join(os.homedir(), 'Library', 'Application Support', 'SlayTheSpire2');
}

function windowsSaveDir(): string {
  // %APPDATA% — set by Windows; fall back to the canonical Roaming path.
  const appData =
    process.env.APPDATA ||
    path.join(os.homedir(), 'AppData', 'Roaming');
  return path.join(appData, 'SlayTheSpire2');
}

function linuxSaveDir(): string {
  // XDG_DATA_HOME or ~/.local/share. Steam Deck native build uses this path.
  const xdg = process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share');
  return path.join(xdg, 'SlayTheSpire2');
}

/** Ordered list of candidate roots to try; first existing one wins. */
function candidateSaveDirs(): string[] {
  const platform = process.platform;
  const overrides = process.env.STS2_SAVE_DIR ? [process.env.STS2_SAVE_DIR] : [];
  if (platform === 'darwin') return [...overrides, macSaveDir()];
  if (platform === 'win32')  return [...overrides, windowsSaveDir()];
  // linux / other
  return [...overrides, linuxSaveDir(), macSaveDir(), windowsSaveDir()];
}

export function resolveSaveDir(): string {
  const candidates = candidateSaveDirs();
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  // None exist yet; return the platform-default so the watcher can wait for it.
  return candidates[0];
}

export class SaveWatcher extends EventEmitter {
  private watcher: FSWatcher | null = null;
  private lastState: GameState | null = null;

  start() {
    const dir = resolveSaveDir();
    if (!fs.existsSync(dir)) {
      logger.warn(`Save dir not found: ${dir}. Watcher will wait for it to appear.`);
    }
    logger.info(`Watching save dir: ${dir}`);

    this.watcher = chokidar.watch(dir, {
      ignoreInitial: false,
      depth: 8,
      awaitWriteFinish: { stabilityThreshold: 150, pollInterval: 50 },
      persistent: true,
      // Godot writes atomically (tmp → rename), so we rely on the final add/change.
      ignored: (p) => {
        // Normalize Windows backslashes so a single rule works on every OS.
        const lower = p.toLowerCase().replace(/\\/g, '/');
        return lower.includes('shader_cache')
            || lower.includes('/logs/')
            || lower.endsWith('.ds_store')
            || lower.endsWith('.tmp');
      },
    });

    this.watcher
      .on('add',    (p) => this.handleFile(p))
      .on('change', (p) => this.handleFile(p))
      .on('error',  (err) => logger.error('Watcher error:', err));
  }

  stop() {
    this.watcher?.close();
    this.watcher = null;
  }

  getLastState(): GameState | null {
    return this.lastState;
  }

  private handleFile(filepath: string) {
    const base = path.basename(filepath);
    // Only current_run.save is live per-run state.
    // progress.save is metaprogression; .run files are completed runs.
    if (base !== 'current_run.save') return;

    try {
      const raw = fs.readFileSync(filepath, 'utf8');
      const parsed = safeJson(raw);
      if (!parsed) {
        logger.warn(`Could not parse JSON: ${filepath}`);
        return;
      }

      const state = parseGameState(parsed);
      this.lastState = state;
      logger.info(
        `Save updated: ${state.character} A${state.ascension} floor ${state.floor} — ` +
        `${state.deck.length} cards, ${state.relics.length} relics, ${state.hp?.current}/${state.hp?.max} hp, ${state.gold}g`,
      );
      this.emit('state', state);
    } catch (err) {
      logger.warn(`Failed reading ${filepath}:`, err);
    }
  }
}

function safeJson(text: string): any | null {
  try { return JSON.parse(text); } catch { return null; }
}

/**
 * Strips the prefix from Godot-style ids.
 *   "CARD.STRIKE_IRONCLAD"  -> "STRIKE_IRONCLAD"
 *   "RELIC.BURNING_BLOOD"   -> "BURNING_BLOOD"
 *   "CHARACTER.IRONCLAD"    -> "IRONCLAD"
 * Then lowercases and title-cases underscores.
 *   "BURNING_BLOOD" -> "Burning Blood"
 */
// Character suffixes on starter cards — the coach doesn't need to see
// "Strike Ironclad" repeated 5 times; "Strike" is clearer.
const CHARACTER_SUFFIXES = ['IRONCLAD', 'SILENT', 'DEFECT', 'WATCHER'];

function prettifyId(id: string): string {
  const tail = id.includes('.') ? id.split('.').slice(1).join('.') : id;
  // Some cards use _PLUS or _UPGRADED suffixes once upgraded — preserve that info.
  let upgrades = 0;
  let name = tail;
  const plusMatch = tail.match(/_PLUS(\d*)$/i) || tail.match(/_UPGRADED(\d*)$/i);
  if (plusMatch) {
    upgrades = plusMatch[1] ? parseInt(plusMatch[1], 10) : 1;
    name = tail.replace(/_(?:PLUS|UPGRADED)\d*$/i, '');
  }
  // Trim trailing character suffix ("STRIKE_IRONCLAD" → "STRIKE") but keep it
  // when the id IS the character ("CHARACTER.IRONCLAD" → "Ironclad").
  for (const suf of CHARACTER_SUFFIXES) {
    if (name.endsWith('_' + suf)) {
      name = name.slice(0, -(suf.length + 1));
      break;
    }
  }
  const human = name
    .split('_')
    .map((w) => w.charAt(0) + w.slice(1).toLowerCase())
    .join(' ');
  return upgrades > 0 ? `${human}+${upgrades}` : human;
}

function parseCardId(id: string): { name: string; upgrades: number } {
  const pretty = prettifyId(id);
  const m = pretty.match(/^(.*?)\+(\d+)$/);
  if (m) return { name: m[1], upgrades: parseInt(m[2], 10) };
  return { name: pretty, upgrades: 0 };
}

/**
 * Turn the raw current_run.save JSON into our GameState.
 * Written against STS2 v0.103.x schema_version 16.
 */
export function parseGameState(raw: any): GameState {
  const player = raw?.players?.[0] ?? {};
  const actIdx = typeof raw?.current_act_index === 'number' ? raw.current_act_index : null;
  const currentAct = actIdx != null ? raw?.acts?.[actIdx] : null;

  // Floor = total rooms entered so far across every act. map_point_history is
  // an array of arrays (one per act), each element a visited room.
  const mph: any[][] = Array.isArray(raw?.map_point_history) ? raw.map_point_history : [];
  const floor = mph.reduce((sum, arr) => sum + (Array.isArray(arr) ? arr.length : 0), 0);

  const character = player.character_id
    ? prettifyId(player.character_id)
    : null;

  const deck: Card[] = Array.isArray(player.deck)
    ? player.deck.map((c: any) => {
        const { name, upgrades } = parseCardId(c.id ?? '');
        return {
          id: c.id ?? name,
          name,
          upgrades,
        };
      })
    : [];

  const relics: Relic[] = Array.isArray(player.relics)
    ? player.relics.map((r: any) => ({
        id: r.id ?? '',
        name: prettifyId(r.id ?? ''),
        counter: typeof r.counter === 'number' ? r.counter : null,
      }))
    : [];

  // Potions: STS2 keeps potion slots under player; I haven't seen populated
  // slots in this sample (empty run start). Try common field names.
  const potionsRaw: any[] =
    (Array.isArray(player.potions) && player.potions) ||
    (Array.isArray(player.potion_slots) && player.potion_slots) ||
    [];
  const potions: Potion[] = potionsRaw
    .filter((p) => p && (p.id || p.name))
    .map((p) => ({
      id: p.id ?? p.name,
      name: prettifyId(p.id ?? p.name),
    }));

  const hp = typeof player.current_hp === 'number' && typeof player.max_hp === 'number'
    ? { current: player.current_hp, max: player.max_hp }
    : null;

  const state: GameState = {
    character,
    ascension: typeof raw.ascension === 'number' ? raw.ascension : null,
    floor: floor || null,
    act: actIdx != null ? actIdx + 1 : null,
    actId: currentAct?.id ?? null,
    bossId: currentAct?.rooms?.boss_id ?? null,
    maxEnergy: typeof player.max_energy === 'number' ? player.max_energy : null,
    hp,
    gold: typeof player.gold === 'number' ? player.gold : null,
    deck,
    relics,
    potions,
    runTimeSec: typeof raw.run_time === 'number' ? raw.run_time : null,
    saveTimeEpoch: typeof raw.save_time === 'number' ? raw.save_time : null,
    gameMode: raw.game_mode ?? null,
    summary: buildSummary(character, actIdx, floor, hp, player.gold, deck.length, relics.length),
    raw,
    updatedAt: new Date().toISOString(),
  };

  return state;
}

function buildSummary(
  character: string | null,
  actIdx: number | null,
  floor: number,
  hp: { current: number; max: number } | null,
  gold: number | undefined,
  deckSize: number,
  relicCount: number,
): string {
  const act = actIdx != null ? `Act ${actIdx + 1}` : 'Act ?';
  const fl = floor ? `Fl ${floor}` : 'Fl ?';
  const hpStr = hp ? `${hp.current}/${hp.max}` : '?';
  const g = gold != null ? `${gold}g` : '?';
  return `${character ?? '?'} · ${act} ${fl} · ${hpStr}hp · ${g} · ${deckSize} cards · ${relicCount} relics`;
}
