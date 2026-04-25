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
  }
}
