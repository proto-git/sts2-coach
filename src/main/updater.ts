/**
 * In-app update banner (Patch 19d).
 *
 * Why this exists:
 *   electron-updater silently fails on unsigned macOS builds (Gatekeeper
 *   refuses to swap an unsigned bundle in place). Until we have an Apple
 *   Developer cert, the most honest UX is to *notice* a new release, *tell*
 *   the user about it, and *open the download page* on click. Cross-OS,
 *   no signing required.
 *
 * What it does:
 *   - On startup, after a 30s grace period, checks GitHub Releases for
 *     the latest tag.
 *   - Re-checks every 24h while the app is running.
 *   - Compares against `app.getVersion()` using a small semver comparator.
 *   - Caches the last result; exposes a getter for IPC + a 'check now' fn.
 *   - Persists "dismissed for this version" in config so users aren't
 *     pestered after they've seen the banner once.
 *
 * What it does NOT do:
 *   - No download. No install. The banner click opens the GitHub Release
 *     page in the user's default browser; they grab the .dmg / .exe like
 *     they did for v0.1.0.
 */

import { net, app } from 'electron';
import { logger } from '@shared/logger';
import { loadAppConfig, saveAppConfig } from './config';

const REPO = 'proto-git/sts2-coach';
const RELEASES_API = `https://api.github.com/repos/${REPO}/releases/latest`;
const RELEASE_PAGE = (tag: string) =>
  `https://github.com/${REPO}/releases/tag/${tag}`;

const STARTUP_GRACE_MS = 30_000;
const POLL_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24h
const REQUEST_TIMEOUT_MS = 10_000;

export interface UpdateStatus {
  /** Currently installed version (from package.json via app.getVersion). */
  currentVersion: string;
  /** Latest tag on GitHub, or null if we haven't checked / the call failed. */
  latestVersion: string | null;
  /** True iff latestVersion > currentVersion AND not dismissed for that version. */
  updateAvailable: boolean;
  /** URL to the GitHub Release page, suitable for shell.openExternal. */
  releaseUrl: string | null;
  /** Body of the latest release, for showing notes in Settings (optional). */
  releaseNotes: string | null;
  /** ms since epoch of the last successful check. */
  lastCheckedAt: number | null;
  /** Last error message, if any. Cleared on next success. */
  lastError: string | null;
}

let status: UpdateStatus = {
  currentVersion: '0.0.0',
  latestVersion: null,
  updateAvailable: false,
  releaseUrl: null,
  releaseNotes: null,
  lastCheckedAt: null,
  lastError: null,
};

let pollTimer: NodeJS.Timeout | null = null;
let onAvailableListeners: Array<(s: UpdateStatus) => void> = [];

/** Subscribe to "update became available" transitions. */
export function onUpdateAvailable(fn: (s: UpdateStatus) => void): () => void {
  onAvailableListeners.push(fn);
  return () => {
    onAvailableListeners = onAvailableListeners.filter((f) => f !== fn);
  };
}

/** Read-only snapshot for IPC. */
export function getUpdateStatus(): UpdateStatus {
  return { ...status };
}

/** Mark the current latestVersion as "don't bug me about this one". */
export function dismissCurrentUpdate(): UpdateStatus {
  if (!status.latestVersion) return getUpdateStatus();
  saveAppConfig({ updateDismissedVersion: status.latestVersion });
  status = { ...status, updateAvailable: false };
  logger.info(`updater: dismissed banner for ${status.latestVersion}`);
  return getUpdateStatus();
}

/** Force a check right now (used by the Settings 'Check now' button). */
export async function checkForUpdatesNow(): Promise<UpdateStatus> {
  await runCheck();
  return getUpdateStatus();
}

/** Boot the updater. Called once from main process startup. */
export function startUpdater(): void {
  status.currentVersion = app.getVersion();
  logger.info(`updater: started (current v${status.currentVersion})`);

  // Don't fire during the launch storm \u2014 give other startup work room.
  setTimeout(() => {
    runCheck().catch((e) => logger.warn(`updater: initial check threw: ${e}`));
    pollTimer = setInterval(() => {
      runCheck().catch((e) => logger.warn(`updater: poll threw: ${e}`));
    }, POLL_INTERVAL_MS);
  }, STARTUP_GRACE_MS);
}

/** Stop the poll timer (used on app quit). */
export function stopUpdater(): void {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

// ── internals ──────────────────────────────────────────────────────────────

async function runCheck(): Promise<void> {
  const wasAvailable = status.updateAvailable;

  try {
    const release = await fetchLatestRelease();
    const latest = stripV(release.tag_name);
    const current = stripV(status.currentVersion);

    const dismissedVersion = (loadAppConfig().updateDismissedVersion ?? '').trim();
    const isNewer = compareSemver(latest, current) > 0;
    const isDismissed = dismissedVersion === latest;

    status = {
      currentVersion: status.currentVersion,
      latestVersion: latest,
      updateAvailable: isNewer && !isDismissed,
      releaseUrl: RELEASE_PAGE(release.tag_name),
      releaseNotes: release.body ?? null,
      lastCheckedAt: Date.now(),
      lastError: null,
    };

    if (isNewer) {
      logger.info(
        `updater: latest=${latest} current=${current} ${
          isDismissed ? '(dismissed)' : '(available)'
        }`,
      );
    } else {
      logger.debug(`updater: up to date (${current})`);
    }

    if (status.updateAvailable && !wasAvailable) {
      for (const fn of onAvailableListeners) {
        try { fn(getUpdateStatus()); } catch (e) { logger.warn(`updater: listener threw: ${e}`); }
      }
    }
  } catch (e: any) {
    status = { ...status, lastError: String(e?.message ?? e), lastCheckedAt: Date.now() };
    logger.warn(`updater: check failed: ${status.lastError}`);
  }
}

interface GithubRelease {
  tag_name: string;
  body?: string;
  draft?: boolean;
  prerelease?: boolean;
  assets?: Array<{ name: string; browser_download_url: string }>;
}

/**
 * Fetch the latest release using Electron's `net` module so we don't need
 * to bundle node-fetch / undici concerns. Times out at REQUEST_TIMEOUT_MS.
 */
function fetchLatestRelease(): Promise<GithubRelease> {
  return new Promise((resolve, reject) => {
    const req = net.request({
      method: 'GET',
      url: RELEASES_API,
      redirect: 'follow',
    });
    req.setHeader('Accept', 'application/vnd.github+json');
    req.setHeader('User-Agent', `sts2-coach/${app.getVersion()}`);
    req.setHeader('X-GitHub-Api-Version', '2022-11-28');

    const timer = setTimeout(() => {
      try { req.abort(); } catch { /* noop */ }
      reject(new Error(`timeout after ${REQUEST_TIMEOUT_MS}ms`));
    }, REQUEST_TIMEOUT_MS);

    req.on('response', (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c as Buffer));
      res.on('end', () => {
        clearTimeout(timer);
        if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
          try {
            const body = Buffer.concat(chunks).toString('utf8');
            const parsed = JSON.parse(body) as GithubRelease;
            if (!parsed.tag_name) {
              reject(new Error('release JSON missing tag_name'));
              return;
            }
            // Skip drafts; treat prereleases as candidates only if they
            // sort newer (the user explicitly opted in by tagging vX.Y.Z-rc).
            if (parsed.draft) {
              reject(new Error('latest is a draft'));
              return;
            }
            resolve(parsed);
          } catch (e: any) {
            reject(new Error(`parse error: ${e?.message ?? e}`));
          }
        } else {
          reject(new Error(`HTTP ${res.statusCode}`));
        }
      });
      res.on('error', (e) => { clearTimeout(timer); reject(e); });
    });
    req.on('error', (e) => { clearTimeout(timer); reject(e); });
    req.end();
  });
}

function stripV(v: string): string {
  return v.replace(/^v/i, '').trim();
}

/**
 * Tiny semver comparator. Returns positive if a > b, negative if a < b, 0 if
 * equal. Handles `1.2.3`, `1.2.3-rc.1`, etc. Pre-release sorts BELOW the
 * matching release per semver spec (1.2.3-rc.1 < 1.2.3).
 */
export function compareSemver(a: string, b: string): number {
  const [aMain, aPre] = a.split('-', 2);
  const [bMain, bPre] = b.split('-', 2);
  const aParts = aMain.split('.').map((n) => parseInt(n, 10) || 0);
  const bParts = bMain.split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    const diff = (aParts[i] ?? 0) - (bParts[i] ?? 0);
    if (diff !== 0) return diff;
  }
  // Same major.minor.patch \u2014 compare pre-release tags.
  if (!aPre && !bPre) return 0;
  if (!aPre) return 1;   // 1.2.3 > 1.2.3-rc.1
  if (!bPre) return -1;
  // String compare for pre-release; good enough for our tagging scheme.
  if (aPre > bPre) return 1;
  if (aPre < bPre) return -1;
  return 0;
}
