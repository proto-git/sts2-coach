import Database from 'better-sqlite3';
import * as path from 'path';
import * as fs from 'fs';
import { app } from 'electron';
import type { Advice, GameState } from '@shared/types';
import { logger } from '@shared/logger';
import { createPlansTable } from './planner';

/**
 * Lightweight local persistence. Tracks:
 *  - runs:     one row per started run (character, ascension, start time, outcome)
 *  - snapshots: point-in-time GameState captures (for replay + future learning layer)
 *  - advice:    every LLM response + user context + timing
 */
export class DB {
  private db: Database.Database;

  constructor() {
    const dir = path.join(app.getPath('userData'), 'data');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'sts2-coach.db');
    this.db = new Database(file);
    this.db.pragma('journal_mode = WAL');
    logger.info(`DB: ${file}`);
    this.migrate();
  }

  private migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        started_at TEXT NOT NULL,
        ended_at TEXT,
        character TEXT,
        ascension INTEGER,
        outcome TEXT,
        final_floor INTEGER
      );

      CREATE TABLE IF NOT EXISTS snapshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id INTEGER,
        captured_at TEXT NOT NULL,
        floor INTEGER,
        hp_current INTEGER,
        hp_max INTEGER,
        gold INTEGER,
        deck_json TEXT,
        relics_json TEXT,
        raw_json TEXT,
        FOREIGN KEY(run_id) REFERENCES runs(id)
      );

      CREATE TABLE IF NOT EXISTS advice (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id INTEGER,
        created_at TEXT NOT NULL,
        model TEXT,
        context TEXT,
        pick TEXT,
        reasoning TEXT,
        runner_up TEXT,
        long_form TEXT,
        latency_ms INTEGER,
        user_note TEXT,
        FOREIGN KEY(run_id) REFERENCES runs(id)
      );

      -- long_form contains the parsed seen block appended to reasoning.

      CREATE INDEX IF NOT EXISTS idx_snapshots_run ON snapshots(run_id);
      CREATE INDEX IF NOT EXISTS idx_advice_run ON advice(run_id);
    `);
    // Patch 17: per-call diagnostics (timings + token usage). Stored in a
    // sibling table so it can be added without disturbing the existing
    // advice schema (and to keep the advice row small enough for fast
    // history queries).
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS diagnostics (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        created_at TEXT NOT NULL,
        model TEXT,
        context TEXT,
        screenshot_ms INTEGER,
        prompt_build_ms INTEGER,
        llm_ms INTEGER,
        parse_ms INTEGER,
        tts_ms INTEGER,
        total_ms INTEGER,
        input_tokens INTEGER,
        output_tokens INTEGER,
        cached_read_tokens INTEGER,
        cached_write_tokens INTEGER,
        cost_usd REAL,
        pick TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_diagnostics_created ON diagnostics(created_at DESC);
    `);
    // Plans table (Patch 06 — adaptive map planner).
    createPlansTable(this.db);
  }

  /** Raw better-sqlite3 handle for modules that own their own queries. */
  raw(): Database.Database {
    return this.db;
  }

  insertSnapshot(state: GameState, runId: number | null) {
    this.db.prepare(`
      INSERT INTO snapshots (run_id, captured_at, floor, hp_current, hp_max, gold, deck_json, relics_json, raw_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      runId,
      state.updatedAt,
      state.floor,
      state.hp?.current ?? null,
      state.hp?.max ?? null,
      state.gold,
      JSON.stringify(state.deck),
      JSON.stringify(state.relics),
      JSON.stringify(state.raw ?? null),
    );
  }

  insertAdvice(advice: Advice, userNote: string | undefined, runId: number | null) {
    this.db.prepare(`
      INSERT INTO advice (run_id, created_at, model, context, pick, reasoning, runner_up, long_form, latency_ms, user_note)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      runId,
      advice.createdAt,
      advice.model,
      advice.contextGuess ?? null,
      advice.pick,
      advice.reasoning,
      advice.runnerUp ?? null,
      advice.longForm ?? null,
      advice.latencyMs,
      userNote ?? null,
    );
    // Patch 17: also persist the diagnostics row.
    if (advice.timings || advice.usage) {
      const t = advice.timings ?? {};
      const u = advice.usage ?? {};
      this.db.prepare(`
        INSERT INTO diagnostics (
          created_at, model, context,
          screenshot_ms, prompt_build_ms, llm_ms, parse_ms, tts_ms, total_ms,
          input_tokens, output_tokens, cached_read_tokens, cached_write_tokens,
          cost_usd, pick
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        advice.createdAt,
        advice.model,
        advice.contextGuess ?? null,
        t.screenshotMs ?? null,
        t.promptBuildMs ?? null,
        t.llmMs ?? null,
        t.parseMs ?? null,
        t.ttsMs ?? null,
        t.totalMs ?? advice.latencyMs ?? null,
        u.inputTokens ?? null,
        u.outputTokens ?? null,
        u.cachedReadTokens ?? null,
        u.cachedWriteTokens ?? null,
        u.costUsd ?? null,
        advice.pick,
      );
    }
  }

  /** Patch 17: fetch the most recent N diagnostic rows for the renderer. */
  recentDiagnostics(limit = 50): DiagnosticRow[] {
    const rows = this.db.prepare(`
      SELECT * FROM diagnostics
      ORDER BY id DESC
      LIMIT ?
    `).all(limit) as DiagnosticRow[];
    return rows;
  }

  /** Patch 17: clear diagnostics (e.g. "reset stats" button). */
  clearDiagnostics(): number {
    const r = this.db.prepare('DELETE FROM diagnostics').run();
    return r.changes;
  }
}

/** Shape returned by recentDiagnostics(). Mirrors the diagnostics table. */
export interface DiagnosticRow {
  id: number;
  created_at: string;
  model: string | null;
  context: string | null;
  screenshot_ms: number | null;
  prompt_build_ms: number | null;
  llm_ms: number | null;
  parse_ms: number | null;
  tts_ms: number | null;
  total_ms: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cached_read_tokens: number | null;
  cached_write_tokens: number | null;
  cost_usd: number | null;
  pick: string | null;
}
