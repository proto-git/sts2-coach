import { app, BrowserWindow, globalShortcut, ipcMain } from 'electron';
import * as dotenv from 'dotenv';

dotenv.config();

import { SaveWatcher } from './save-watcher';
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
import { DEFAULT_MODEL } from '@shared/models';

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

function overlayWin(): BrowserWindow | null {
  return overlay?.win ?? null;
}

async function doAdvise() {
  if (!coach) { logger.warn('No coach'); return; }
  try {
    logger.info('Hotkey: advise');
    const shot = await captureScreen();
    logger.debug(`shot ${shot.width}x${shot.height} ${Math.round(shot.bytes / 1024)}KB`);

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

    const advice = await coach.advise({
      screenshotB64: shot.b64,
      mimeType: shot.mimeType,
      state: lastState,
      saveContext,
      planBlock,
    });
    overlayWin()?.webContents.send('advice', advice);
    overlayWin()?.show();
    db?.insertAdvice(advice, undefined, currentRunId);
    const voiceLine = advice.runnerUp
      ? `${advice.pick}. ${advice.reasoning} Runner up: ${advice.runnerUp}.`
      : `${advice.pick}. ${advice.reasoning}`;
    tts?.speak(voiceLine).catch((e) => logger.error('TTS error', e));
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

app.on('ready', async () => {
  if (process.platform === 'darwin' && app.dock) app.dock.hide();

  const openrouterKey = process.env.OPENROUTER_API_KEY;
  const openaiKey     = process.env.OPENAI_API_KEY;
  const model         = process.env.DEFAULT_MODEL || DEFAULT_MODEL;
  const ttsProvider   = (process.env.TTS_PROVIDER as 'openai' | 'say') || 'say';

  if (!openrouterKey) {
    logger.warn('OPENROUTER_API_KEY missing — advise will fail until you set it in .env');
  }

  db    = new DB();
  coach = new Coach({ apiKey: openrouterKey || 'missing', model });
  tts   = new TTS({ provider: ttsProvider, openaiApiKey: openaiKey, voice: process.env.TTS_VOICE });

  watcher = new SaveWatcher();
  watcher.on('state', (s: GameState) => {
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
  });
  watcher.start();

  overlay = createOverlayWindow();
  overlay.win.on('closed', () => { overlay = null; });

  // Lock-state IPC
  ipcMain.handle('overlay-get-locked', () => overlayLocked);
  ipcMain.on('overlay-set-locked', (_e, v: boolean) => setOverlayLocked(v));

  tray = createTray({
    getCurrentModel:  () => coach!.getModel(),
    setModel:         (slug) => coach!.setModel(slug),
    triggerAdvise:    () => doAdvise(),
    triggerDeckDump:  () => doDeckDump(),
    showOverlay:      () => overlayWin()?.show(),
    hideOverlay:      () => overlayWin()?.hide(),
    moveOverlayToZone: (z) => overlay?.moveToZone(z),
    resetOverlay:     () => overlay?.resetPosition(),
    setOverlayOpacity: (v) => overlay?.setOpacity(v),
    setOverlayClickThrough: (v) => overlay?.setClickThrough(v),
    getOverlaySettings: () => overlay!.getSettings(),
    quit:             () => app.quit(),
  });

  const okAdvise = globalShortcut.register('Alt+Shift+S', () => doAdvise());
  const okDeck   = globalShortcut.register('Alt+Shift+D', () => doDeckDump());
  logger.info(`Hotkeys — advise(⌥⇧S): ${okAdvise}, deck(⌥⇧D): ${okDeck}`);

  ipcMain.handle('get-state', () => lastState);
  ipcMain.handle('get-model', () => coach?.getModel());
  ipcMain.on('hide-overlay',   () => overlayWin()?.hide());
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  watcher?.stop();
});

app.on('window-all-closed', () => {
  // Tray app — keep running even if the overlay is closed.
});
