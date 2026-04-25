import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import sharp from 'sharp';
import { desktopCapturer, screen, app } from 'electron';
import { logger } from '@shared/logger';

const execFileP = promisify(execFile);

// Anthropic caps images at 5MB, OpenAI at 20MB. Target ~3MB to stay well under
// the strictest limit regardless of the model chosen in the tray.
const TARGET_BYTES = 3 * 1024 * 1024;
const MAX_EDGE = 1920;
const JPEG_QUALITY = 82;

// desktopCapturer on macOS can intermittently return an empty NativeImage on
// repeat calls. Retry briefly before falling back to the shell-out path.
const CAPTURE_RETRY_ATTEMPTS = 3;
const CAPTURE_RETRY_DELAY_MS = 120;

export interface CaptureResult {
  /** Base64-encoded JPEG payload (no data-URL prefix). */
  b64: string;
  mimeType: 'image/jpeg';
  bytes: number;
  width: number;
  height: number;
}

/**
 * Captures the primary display, resizes + JPEG-encodes for vision-LLM upload.
 *
 * Cross-platform pipeline:
 *  - Try Electron's `desktopCapturer` (works on macOS, Windows, Linux).
 *  - If that returns an empty NativeImage (a known macOS quirk on repeat
 *    calls), retry a couple of times with a short delay.
 *  - On macOS, fall back to the `screencapture -x` CLI as a last resort.
 *
 * Permissions:
 *  - macOS: needs Screen Recording permission (System Settings → Privacy &
 *    Security → Screen Recording). After granting, RESTART the app — Electron
 *    caches the denied state on the main process until a fresh launch.
 *  - Windows: no prompt; works out of the box.
 *  - Linux/X11: works on most setups; Wayland may require pipewire portal.
 */
export async function captureScreen(): Promise<CaptureResult> {
  try {
    const primary = screen.getPrimaryDisplay();
    const { width: dispW, height: dispH } = primary.size;

    // Try desktopCapturer with retries — macOS sometimes returns an empty
    // thumbnail on subsequent calls in the same session.
    let pngBuffer: Buffer | null = null;
    let lastDiag = '';
    for (let attempt = 1; attempt <= CAPTURE_RETRY_ATTEMPTS; attempt++) {
      const result = await tryDesktopCapturer(dispW, dispH, primary.id);
      if (result.ok) {
        pngBuffer = result.buf;
        if (attempt > 1) {
          logger.warn(`captureScreen: desktopCapturer succeeded on attempt ${attempt}`);
        }
        break;
      }
      lastDiag = result.diag;
      logger.warn(`captureScreen: desktopCapturer attempt ${attempt} failed: ${result.diag}`);
      if (attempt < CAPTURE_RETRY_ATTEMPTS) {
        await sleep(CAPTURE_RETRY_DELAY_MS);
      }
    }

    // macOS fallback: screencapture is the same CLI the original implementation
    // used. It bypasses the desktopCapturer empty-thumbnail bug entirely.
    if (!pngBuffer && os.platform() === 'darwin') {
      logger.warn(`captureScreen: falling back to screencapture CLI (${lastDiag})`);
      pngBuffer = await macScreencaptureFallback();
    }

    if (!pngBuffer || pngBuffer.byteLength === 0) {
      throw new Error(
        `Could not capture screen. ${lastDiag} ` +
        `On macOS, ensure Screen Recording permission is granted in ` +
        `System Settings → Privacy & Security → Screen Recording, then ` +
        `RESTART the app.`,
      );
    }

    // Resize + JPEG-encode.
    const meta = await sharp(pngBuffer).metadata();
    const srcW = meta.width ?? dispW;
    const srcH = meta.height ?? dispH;
    const longEdge = Math.max(srcW, srcH);
    const scale = longEdge > MAX_EDGE ? MAX_EDGE / longEdge : 1;
    const targetW = Math.round(srcW * scale);
    const targetH = Math.round(srcH * scale);

    let quality = JPEG_QUALITY;
    let buf: Buffer;
    let qAttempt = 0;
    while (true) {
      buf = await sharp(pngBuffer)
        .resize({ width: targetW, height: targetH, fit: 'inside' })
        .jpeg({ quality, mozjpeg: true })
        .toBuffer();
      if (buf.byteLength <= TARGET_BYTES || quality <= 40) break;
      quality -= 10;
      qAttempt += 1;
    }

    logger.debug('capture', {
      platform: os.platform(),
      srcW, srcH,
      outW: targetW, outH: targetH,
      bytes: buf.byteLength,
      quality,
      qualityAttempts: qAttempt + 1,
    });

    return {
      b64: buf.toString('base64'),
      mimeType: 'image/jpeg',
      bytes: buf.byteLength,
      width: targetW,
      height: targetH,
    };
  } catch (err) {
    logger.error('captureScreen failed:', err);
    throw err;
  }
}

/**
 * Single attempt at desktopCapturer. Returns the PNG buffer on success or a
 * diagnostic string explaining why the attempt failed.
 */
async function tryDesktopCapturer(
  dispW: number,
  dispH: number,
  primaryId: number,
): Promise<{ ok: true; buf: Buffer } | { ok: false; diag: string }> {
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width: dispW, height: dispH },
    fetchWindowIcons: false,
  });

  if (!sources.length) {
    return { ok: false, diag: 'no sources returned (likely missing Screen Recording permission on macOS)' };
  }

  const primaryStr = String(primaryId);
  const source =
    sources.find((s) => s.display_id === primaryStr) ??
    sources[0];

  // Critical: NativeImage may be empty on macOS even when getSources succeeded.
  if (!source.thumbnail || source.thumbnail.isEmpty()) {
    return {
      ok: false,
      diag: `thumbnail empty for source "${source.name}" (sources=${sources.length})`,
    };
  }

  const png = source.thumbnail.toPNG();
  if (!png || png.byteLength === 0) {
    return {
      ok: false,
      diag: `toPNG() returned empty buffer for source "${source.name}"`,
    };
  }

  return { ok: true, buf: png };
}

/**
 * macOS-only fallback: shell out to the built-in `screencapture` CLI. We write
 * to a temp PNG, read it back, and unlink it. This is what the original
 * implementation used — it's slower (~120ms vs ~30ms) but rock-solid.
 */
async function macScreencaptureFallback(): Promise<Buffer> {
  const tmpDir = app.getPath('temp');
  const file = path.join(tmpDir, `sts2-coach-${process.pid}-${Date.now()}.png`);
  try {
    // -x = silent (no shutter sound); -t png = format; -C = capture cursor (off by default — leave it off)
    await execFileP('screencapture', ['-x', '-t', 'png', file], { timeout: 5000 });
    const buf = await fs.promises.readFile(file);
    return buf;
  } finally {
    fs.promises.unlink(file).catch(() => {/* best-effort cleanup */});
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Back-compat thin wrapper — returns just the base64 string. */
export async function captureScreenB64(): Promise<string> {
  const r = await captureScreen();
  return r.b64;
}
