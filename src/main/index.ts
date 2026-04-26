import { app, BrowserWindow, dialog, globalShortcut, ipcMain } from 'electron';
import * as dotenv from 'dotenv';
import * as fs from 'fs';

dotenv.config();

import { SaveWatcher, resolveSaveDir } from './save-watcher';
import { captureScreen } from './capture';
import { Coach } from './coach';
import { TTS } from './tts';
import { DB } from './db';
import { createTray } from './tray';
import { createOverlayWindow, OverlayHandle } from './overlay-window';
import { logger } from '@shared/logger';
import type { Advice, GameState } from '@shared/types';
import { planOnState, type PlanDecision } from './planner';
import { computeViewport, extractMap, inferSaveContext, renderAscii } from './map';
import { extractShopRelicPool } from './shop';
import { MODEL_OPTIONS } from '@shared/models';
import {
  configFilePath,
  effectiveConfig,
  invalidateConfigCache,
  isFirstRun,
  saveAppConfig,
  type AppConfig,
} from './config';
import { openSettingsWindow } from './settings-window';

let overlay: OverlayHandle | null = null;
let tray: Electron.Tray | null = null;
let watcher: SaveWatcher | null = null;
let coach: Coach | null = null;
let tts: TTS | null = null;
let db: DB | null = null;
let currentRunId: number | null = null; // TODO: infer from save changes
let lastState: GameState | null = null;
let lastPlan: PlanDecision | null = null;
let overlayLocked = true;
/** Tracks whether we've already auto-popped settings on a missing-key error. */
let autoOpenedSettingsForMissingKey = false;

function overlayWin(): BrowserWindow | null {
  return overlay?.win ?? null;
}

/** Build the Coach + TTS instances from the currently effective config. */
function buildCoachAndTTS(): { coach: Coach; tts: TTS } {
  const eff = effectiveConfig();
  const c = new Coach({
    apiKey: eff.openrouterApiKey || 'missing',
    model: eff.defaultModel,
  });
  // Coach uses 'system'|'openai'|'off'; TTS class historically also accepts 'say'.
  const t = new TTS({
    provider: eff.ttsProvider,
    openaiApiKey: eff.openaiApiKey || undefined,
    voice: eff.ttsVoice,
  });
  return { coach: c, tts: t };
}

async function doAdvise() {
  if (!coach) { logger.warn('No coach'); return; }
  const eff = effectiveConfig();
  if (!eff.openrouterApiKey) {
    logger.warn('No OpenRouter API key; opening settings.');
    if (!autoOpenedSettingsForMissingKey) {
      autoOpenedSettingsForMissingKey = true;
      openSettingsWindow({});
    }
    overlayWin()?.webContents.send('advice', {
      pick: 'Set your OpenRouter API key',
      reasoning: 'Open the Settings window from the tray menu and paste your key.',
      model: coach.getModel(),
      latencyMs: 0,
      createdAt: new Date().toISOString(),
    } satisfies Advice);
    overlayWin()?.show();
    return;
  }
  try {
    logger.info('Hotkey: advise');
    // Patch 17: instrument every leg of the pipeline so the Diagnostics tab
    // can show users where their latency is going.
    const tShot = Date.now();
    const shot = await captureScreen();
    const screenshotMs = Date.now() - tShot;
    logger.debug(`shot ${shot.width}x${shot.height} ${Math.round(shot.bytes / 1024)}KB (${screenshotMs}ms)`);

    // Build the save-context + plan block (Patch 06).
    const saveContext = lastState?.raw ? inferSaveContext(lastState.raw) : 'unknown';
    let planBlock: Parameters<typeof coach.advise>[0]['planBlock'] | undefined;
    if (lastState && lastPlan) {
      const map = extractMap(lastState.raw);
      // Full map goes to the model (it has the full picture for planning).
      const asciiFull = map ? renderAscii(map, lastPlan.plan.fullKeys) : '';
      // A cropped, compact version is what we render in the overlay.
      const asciiOverlay = map
        ? renderAscii(map, lastPlan.plan.fullKeys, { rowWindow: computeViewport(map, 8), legend: false })
        : '';
      planBlock = {
        summary: lastPlan.summary,
        ascii: asciiFull,
        asciiOverlay,
        currentKey: lastPlan.currentKey,
        nextChoices: (map?.nextChoices ?? []).map((n) => ({ key: n.key, type: n.type as string, col: n.col, row: n.row })),
        remaining: lastPlan.remaining,
        kind: lastPlan.kind,
        reasons: lastPlan.deviation?.reasons,
      };
    }

    // Patch 15: shop-context block — STS2 doesn't persist current shop
    // offerings to the save, but it does keep a per-run eligible relic pool.
    // Pass that + authoritative gold so the model knows the icon must be one
    // of these N relics, and so we can affordability-check post-hoc.
    let shopBlock: Parameters<typeof coach.advise>[0]['shopBlock'] | undefined;
    if (saveContext === 'shop' && lastState?.raw) {
      const pool = extractShopRelicPool(lastState.raw);
      shopBlock = {
        eligibleRelicNames: pool?.displayNames ?? [],
        gold: lastState.gold ?? null,
      };
    }

    const advice = await coach.advise({
      screenshotB64: shot.b64,
      mimeType: shot.mimeType,
      state: lastState,
      saveContext,
      planBlock,
      shopBlock,
      screenshotMs,
    });
    // Show overlay & persist BEFORE TTS — voice is fire-and-forget.
    overlayWin()?.webContents.send('advice', advice);
    overlayWin()?.show();

    // Patch 17: time the TTS leg and merge into advice.timings before
    // persisting. The overlay already saw the pre-TTS advice; we update
    // the DB row with the final timing once speak() resolves.
    const voiceLine = advice.runnerUp
      ? `${advice.pick}. ${advice.reasoning} Runner up: ${advice.runnerUp}.`
      : `${advice.pick}. ${advice.reasoning}`;
    const tTts = Date.now();
    tts?.speak(voiceLine)
      .then(() => {
        const ttsMs = Date.now() - tTts;
        if (advice.timings) advice.timings.ttsMs = ttsMs;
        db?.insertAdvice(advice, undefined, currentRunId);
      })
      .catch((e) => {
        logger.error('TTS error', e);
        if (advice.timings) advice.timings.ttsMs = Date.now() - tTts;
        db?.insertAdvice(advice, undefined, currentRunId);
      });
    // If TTS is disabled (provider 'off') speak() resolves immediately, but
    // still ensure we persist even when there's no tts at all:
    if (!tts) {
      db?.insertAdvice(advice, undefined, currentRunId);
    }
  } catch (err) {
    logger.error('Advise failed:', err);
    overlayWin()?.webContents.send('advice', {
      pick: 'Error',
      reasoning: String(err),
      model: coach?.getModel() ?? '',
      latencyMs: 0,
      createdAt: new Date().toISOString(),
    } satisfies Advice);
    overlayWin()?.show();
  }
}

async function doDeckDump() {
  logger.info('Hotkey: deck dump');
  if (!lastState) {
    tts?.speak('No save data detected yet.').catch(() => {});
    overlayWin()?.webContents.send('advice', {
      pick: 'No save data yet',
      reasoning: 'Start a run and progress one floor so the game writes a save.',
      model: coach?.getModel() ?? '',
      latencyMs: 0,
      createdAt: new Date().toISOString(),
    } satisfies Advice);
    overlayWin()?.show();
    return;
  }
  const { deck, relics, hp, gold, floor, character, ascension, act } = lastState;
  const line = `${character ?? 'Unknown'} Ascension ${ascension ?? 0}. Act ${act ?? '?'}, Floor ${floor ?? '?'}. `
    + `HP ${hp?.current ?? '?'} of ${hp?.max ?? '?'}. ${gold ?? '?'} gold. `
    + `${deck.length} cards. ${relics.length} relics.`;
  overlayWin()?.webContents.send('state', lastState);
  overlayWin()?.show();
  tts?.speak(line).catch(() => {});
}

function setOverlayLocked(v: boolean) {
  overlayLocked = v;
  overlayWin()?.webContents.send('overlay-lock', v);
  if (!v) overlayWin()?.show(); // make sure it's visible while moving
}

/** Restart the SaveWatcher with the current config's saveDirOverride. */
function restartWatcher() {
  watcher?.stop();
  const eff = effectiveConfig();
  watcher = new SaveWatcher({ dirOverride: eff.saveDirOverride });
  watcher.on('state', onWatcherState);
  watcher.start();
}

function onWatcherState(s: GameState) {
  lastState = s;
  db?.insertSnapshot(s, currentRunId);
  overlayWin()?.webContents.send('state', s);
  // Patch 06: run the adaptive planner on every save update.
  try {
    if (db) {
      const decision = planOnState(db.raw(), s);
      if (decision) {
        lastPlan = decision;
        logger.info(`[planner] ${decision.summary}`);
        if (decision.kind === 'replan' && decision.deviation) {
          logger.info(`[planner] triggers: ${decision.deviation.details.join('; ')}`);
        }
      }
    }
  } catch (e) {
    logger.error('planner error:', e);
  }
}

app.on('ready', async () => {
  if (process.platform === 'darwin' && app.dock) app.dock.hide();

  const eff = effectiveConfig();
  logger.info(`config sources: ork=${eff.sources.openrouterApiKey} oai=${eff.sources.openaiApiKey} model=${eff.sources.defaultModel} saveDir=${eff.sources.saveDirOverride} tts=${eff.sources.ttsProvider}`);

  if (!eff.openrouterApiKey) {
    logger.warn('OPENROUTER_API_KEY missing — Settings window will open on first run.');
  }

  db    = new DB();
  const built = buildCoachAndTTS();
  coach = built.coach;
  tts   = built.tts;

  watcher = new SaveWatcher({ dirOverride: eff.saveDirOverride });
  watcher.on('state', onWatcherState);
  watcher.start();

  overlay = createOverlayWindow();
  overlay.win.on('closed', () => { overlay = null; });

  // Lock-state IPC
  ipcMain.handle('overlay-get-locked', () => overlayLocked);
  ipcMain.on('overlay-set-locked', (_e, v: boolean) => setOverlayLocked(v));

  // ── Settings window IPC ────────────────────────────────────────────────
  ipcMain.handle('settings:load', () => {
    // Returns the shape the renderer expects: the raw config plus a
    // sources-by-field map plus first-run / config-path metadata.
    const eff = effectiveConfig();
    const { sources, ...rest } = eff;
    return {
      config: rest,
      sources,
      isFirstRun: isFirstRun(),
      configFilePath: configFilePath(),
    };
  });

  ipcMain.handle('settings:save', (_e, patch: Partial<AppConfig>) => {
    try {
      saveAppConfig(patch);
      invalidateConfigCache(); // pick up the just-written values immediately
      autoOpenedSettingsForMissingKey = false;

      // Rebuild long-lived consumers so changes take effect without a restart.
      const rebuilt = buildCoachAndTTS();
      coach = rebuilt.coach;
      tts   = rebuilt.tts;

      // Save dir may have moved — restart the watcher.
      restartWatcher();

      logger.info('Settings saved; coach/tts/watcher rebuilt.');
      return { ok: true };
    } catch (err) {
      logger.error('settings:save failed', err);
      return { ok: false, error: (err as Error).message };
    }
  });

  ipcMain.handle('settings:detect-save-dir', () => {
    // Re-run platform detection ignoring any override the user has set.
    const dir = resolveSaveDir();
    return { path: dir, exists: fs.existsSync(dir) };
  });

  ipcMain.handle('settings:pick-save-dir', async () => {
    const result = await dialog.showOpenDialog({
      title: 'Pick your Slay the Spire 2 save folder',
      properties: ['openDirectory'],
    });
    if (result.canceled || result.filePaths.length === 0) return { path: null };
    return { path: result.filePaths[0] };
  });

  ipcMain.handle('settings:get-models', () => MODEL_OPTIONS);

  // ── Diagnostics IPC (Patch 17) ─────────────────────────────────────────
  ipcMain.handle('diagnostics:get', (_e, limit?: number) => {
    if (!db) return [];
    const n = typeof limit === 'number' && limit > 0 && limit <= 500 ? limit : 50;
    return db.recentDiagnostics(n);
  });

  ipcMain.handle('diagnostics:clear', () => {
    if (!db) return { ok: false, deleted: 0 };
    const deleted = db.clearDiagnostics();
    logger.info(`diagnostics cleared (${deleted} rows)`);
    return { ok: true, deleted };
  });

  ipcMain.on('settings:close', () => {
    BrowserWindow.getAllWindows()
      .filter((w) => w.getTitle().includes('Settings'))
      .forEach((w) => { try { w.close(); } catch { /* ignore */ } });
  });

  tray = createTray({
    getCurrentModel:  () => coach!.getModel(),
    setModel:         (slug) => {
      coach!.setModel(slug);
      // Persist the choice so it survives a restart.
      saveAppConfig({ defaultModel: slug });
    },
    triggerAdvise:    () => doAdvise(),
    triggerDeckDump:  () => doDeckDump(),
    showOverlay:      () => overlayWin()?.show(),
    hideOverlay:      () => overlayWin()?.hide(),
    moveOverlayToZone: (z) => overlay?.moveToZone(z),
    resetOverlay:     () => overlay?.resetPosition(),
    setOverlayOpacity: (v) => overlay?.setOpacity(v),
    setOverlayClickThrough: (v) => overlay?.setClickThrough(v),
    getOverlaySettings: () => overlay!.getSettings(),
    openSettings:     () => openSettingsWindow(),
    openDiagnostics:  () => openSettingsWindow({ hash: 'diagnostics' }),
    quit:             () => app.quit(),
  });

  const okAdvise = globalShortcut.register('Alt+Shift+S', () => doAdvise());
  const okDeck   = globalShortcut.register('Alt+Shift+D', () => doDeckDump());
  logger.info(`Hotkeys — advise(⌥⇧S): ${okAdvise}, deck(⌥⇧D): ${okDeck}`);

  ipcMain.handle('get-state', () => lastState);
  ipcMain.handle('get-model', () => coach?.getModel());
  ipcMain.on('hide-overlay',   () => overlayWin()?.hide());

  // First-run: pop settings if no API key is configured anywhere.
  if (isFirstRun()) {
    logger.info('First run / missing key — opening Settings.');
    openSettingsWindow();
  }
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  watcher?.stop();
});

app.on('window-all-closed', () => {
  // Tray app — keep running even if the overlay is closed.
});
