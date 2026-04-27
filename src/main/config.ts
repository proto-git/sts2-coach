import { app } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { logger } from '@shared/logger';
import { DEFAULT_MODEL, MODEL_OPTIONS } from '@shared/models';

/**
 * App config stored on disk at:
 *   ~/Library/Application Support/STS2 Coach/config.json   (macOS)
 *   %APPDATA%/STS2 Coach/config.json                       (Windows)
 *   $XDG_CONFIG_HOME/STS2 Coach/config.json                (Linux)
 *
 * Holds the things a user might reasonably want to change after install:
 * API keys, model, save-file location, TTS settings.
 *
 * Plain JSON for inspectability \u2014 keys are NOT encrypted. They are protected
 * only by the OS user-account boundary on a typical single-user machine.
 * If you share a Mac/PC with someone else under the same login, treat this
 * file accordingly.
 *
 * Resolution order at runtime (highest priority first) is implemented in
 * `effectiveConfig()` in this file:
 *   1. Anything explicitly saved in config.json
 *   2. Process environment variable (.env file or shell)
 *   3. Hard-coded default
 *
 * So power users who like .env can keep using it; everyone else uses the
 * Settings window.
 */

export interface AppConfig {
  /** OpenRouter API key \u2014 required for advice. */
  openrouterApiKey: string;
  /** OpenAI API key \u2014 optional, enables HD TTS. Falls back to system TTS. */
  openaiApiKey: string;
  /** OpenRouter slug, e.g. "anthropic/claude-sonnet-4.6". */
  defaultModel: string;
  /** Manual save-dir override. Empty string = auto-detect. */
  saveDirOverride: string;
  /** TTS engine: 'openai' (HD), 'system' (free, OS native), or 'off'. */
  ttsProvider: 'openai' | 'system' | 'off';
  /** OpenAI TTS voice name (only used when ttsProvider='openai'). */
  ttsVoice: string;
  /**
   * Patch 16: read-only mode. When true, the coach behaves as an observer
   * only \u2014 no voice output, no hotkey ding. The overlay still updates.
   * Independent of ttsProvider so toggling on/off restores the user's
   * preferred voice setting.
   */
  readOnlyMode: boolean;
  /**
   * Patch 16: short audible "chime" played on \u2325\u21E7S so the user knows
   * the hotkey was caught even before the overlay updates. Default off to
   * avoid surprising new users; many will prefer the silent visual ack.
   */
  hotkeyDing: boolean;
  /**
   * Patch 19d: tag of the latest release the user explicitly dismissed via
   * the "don't bug me" button on the update banner. Empty string means
   * undismissed. Reset on every new release: when the polled latest tag
   * differs from this stored tag, the banner shows again.
   */
  updateDismissedVersion: string;
  /** Bumped on schema migrations \u2014 reserved for future use. */
  schemaVersion: number;
}

const SCHEMA_VERSION = 1;

const DEFAULTS: AppConfig = {
  openrouterApiKey: '',
  openaiApiKey: '',
  defaultModel: DEFAULT_MODEL,
  saveDirOverride: '',
  ttsProvider: 'system',
  ttsVoice: 'alloy',
  readOnlyMode: false,
  hotkeyDing: false,
  updateDismissedVersion: '',
  schemaVersion: SCHEMA_VERSION,
};

let cached: AppConfig | null = null;

function configFile(): string {
  const dir = app.getPath('userData');
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, 'config.json');
}

export function configFilePath(): string {
  return configFile();
}

/**
 * Returns true if a config.json exists on disk \u2014 used to decide whether to
 * open the first-run settings window.
 */
export function configFileExists(): boolean {
  try {
    return fs.existsSync(configFile());
  } catch {
    return false;
  }
}

/**
 * Load raw config from disk, merged with defaults. No env-var fallbacks here \u2014
 * use `effectiveConfig()` if you want the resolved/merged view.
 */
export function loadAppConfig(): AppConfig {
  if (cached) return cached;
  try {
    const raw = fs.readFileSync(configFile(), 'utf8');
    const parsed = JSON.parse(raw);
    cached = sanitize({ ...DEFAULTS, ...parsed });
    logger.debug('app config loaded', { ...cached, openrouterApiKey: redact(cached.openrouterApiKey), openaiApiKey: redact(cached.openaiApiKey) });
  } catch {
    cached = { ...DEFAULTS };
  }
  return cached!;
}

/**
 * Persist a partial update. Returns the merged result.
 */
export function saveAppConfig(patch: Partial<AppConfig>): AppConfig {
  const next = sanitize({ ...loadAppConfig(), ...patch, schemaVersion: SCHEMA_VERSION });
  cached = next;
  try {
    fs.writeFileSync(configFile(), JSON.stringify(next, null, 2));
    logger.info('app config saved');
  } catch (err) {
    logger.warn('failed to persist app config', err);
  }
  return next;
}

/**
 * The "effective" config used by the rest of the app. Layers the saved config
 * over environment-variable fallbacks so dev mode keeps working with a .env
 * file even when no config.json exists.
 */
export interface EffectiveConfig extends AppConfig {
  /** Source of each setting \u2014 useful for diagnostics. */
  sources: {
    openrouterApiKey: 'config' | 'env' | 'default';
    openaiApiKey:     'config' | 'env' | 'default';
    defaultModel:     'config' | 'env' | 'default';
    saveDirOverride:  'config' | 'env' | 'default';
    ttsProvider:      'config' | 'env' | 'default';
    ttsVoice:         'config' | 'env' | 'default';
  };
}

export function effectiveConfig(): EffectiveConfig {
  const c = loadAppConfig();
  const pick = <T extends string>(
    fromConfig: T,
    envName: string,
    fallback: T,
  ): { value: T; source: 'config' | 'env' | 'default' } => {
    if (fromConfig && fromConfig.length > 0) return { value: fromConfig, source: 'config' };
    const e = process.env[envName];
    if (e && e.length > 0) return { value: e as T, source: 'env' };
    return { value: fallback, source: 'default' };
  };

  const ork    = pick(c.openrouterApiKey, 'OPENROUTER_API_KEY', '');
  const oai    = pick(c.openaiApiKey,     'OPENAI_API_KEY',     '');
  const model  = pick(c.defaultModel,     'DEFAULT_MODEL',      DEFAULT_MODEL);
  const sdir   = pick(c.saveDirOverride,  'STS2_SAVE_DIR',      '');
  const tts    = pick(c.ttsProvider,      'TTS_PROVIDER',       'system');
  const voice  = pick(c.ttsVoice,         'TTS_VOICE',          'alloy');

  return {
    openrouterApiKey: ork.value,
    openaiApiKey:     oai.value,
    defaultModel:     model.value,
    saveDirOverride:  sdir.value,
    // Normalize legacy 'say' alias (Patch 09 used 'say' for system TTS in .env).
    ttsProvider:      ((tts.value as string) === 'say' ? 'system' : tts.value) as AppConfig['ttsProvider'],
    ttsVoice:         voice.value,
    // Patch 16 \u2014 currently config-only. Env-var support can be added later
    // if anyone asks; the tray toggle covers the common case.
    readOnlyMode:     c.readOnlyMode,
    hotkeyDing:       c.hotkeyDing,
    updateDismissedVersion: c.updateDismissedVersion,
    schemaVersion:    c.schemaVersion,
    sources: {
      openrouterApiKey: ork.source,
      openaiApiKey:     oai.source,
      defaultModel:     model.source,
      saveDirOverride:  sdir.source,
      ttsProvider:      tts.source,
      ttsVoice:         voice.source,
    },
  };
}

/**
 * True if the user has *no* OpenRouter key from any source. The trigger for
 * showing the first-run settings window.
 */
export function isFirstRun(): boolean {
  const eff = effectiveConfig();
  return eff.openrouterApiKey.length === 0;
}

function sanitize(c: AppConfig): AppConfig {
  // Coerce / clamp obviously-bad values rather than crashing.
  const validModels = new Set(MODEL_OPTIONS.map((m) => m.slug));
  return {
    openrouterApiKey: typeof c.openrouterApiKey === 'string' ? c.openrouterApiKey.trim() : '',
    openaiApiKey:     typeof c.openaiApiKey === 'string' ? c.openaiApiKey.trim() : '',
    defaultModel:     validModels.has(c.defaultModel) ? c.defaultModel : DEFAULT_MODEL,
    saveDirOverride:  typeof c.saveDirOverride === 'string' ? c.saveDirOverride.trim() : '',
    ttsProvider:      ['openai', 'system', 'off'].includes(c.ttsProvider) ? c.ttsProvider : 'system',
    ttsVoice:         typeof c.ttsVoice === 'string' && c.ttsVoice.length > 0 ? c.ttsVoice : 'alloy',
    readOnlyMode:     typeof c.readOnlyMode === 'boolean' ? c.readOnlyMode : false,
    hotkeyDing:       typeof c.hotkeyDing === 'boolean' ? c.hotkeyDing : false,
    updateDismissedVersion: typeof c.updateDismissedVersion === 'string' ? c.updateDismissedVersion : '',
    schemaVersion:    SCHEMA_VERSION,
  };
}

function redact(s: string): string {
  if (!s) return '';
  if (s.length <= 8) return '***';
  return `${s.slice(0, 4)}\u2026${s.slice(-4)}`;
}

/**
 * Force a reload from disk on next access. Used after the settings window
 * writes new values, so the rest of the app picks them up immediately.
 */
export function invalidateConfigCache(): void {
  cached = null;
}
