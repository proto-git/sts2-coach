import OpenAI from 'openai';
import { exec, spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { promisify } from 'util';
import { logger } from '@shared/logger';

const execAsync = promisify(exec);

/** Provider tag stored in .env / settings.
 *
 *  - "openai":  uses the OpenAI TTS API; cross-platform.
 *  - "system":  uses whichever native TTS exists on this OS:
 *                 macOS   → `say`
 *                 Windows → PowerShell System.Speech.SpeechSynthesizer
 *                 Linux   → tries `spd-say`, else `espeak`
 *
 *  Legacy alias: "say" is treated the same as "system" so older .env files
 *  that picked "say" before patch 09 still work on macOS *and* on Windows.
 */
export type TTSProvider = 'openai' | 'system' | 'say' | 'off';

interface TTSOptions {
  provider: TTSProvider;
  openaiApiKey?: string;
  voice?: string;
}

export class TTS {
  private opts: TTSOptions;
  private openai: OpenAI | null = null;
  private currentProc: ReturnType<typeof spawn> | null = null;

  constructor(opts: TTSOptions) {
    this.opts = opts;
    if (opts.provider === 'openai' && opts.openaiApiKey) {
      this.openai = new OpenAI({ apiKey: opts.openaiApiKey });
    }
  }

  async speak(text: string): Promise<void> {
    this.stop();
    if (!text.trim()) return;
    if (this.opts.provider === 'off') return; // muted

    if (this.opts.provider === 'openai' && this.openai) {
      return this.speakOpenAI(text);
    }
    return this.speakSystem(text);
  }

  stop() {
    if (this.currentProc && !this.currentProc.killed) {
      try { this.currentProc.kill(); } catch {}
    }
    this.currentProc = null;
  }

  private async speakOpenAI(text: string) {
    try {
      const mp3 = await this.openai!.audio.speech.create({
        model: 'tts-1',
        voice: (this.opts.voice as any) || 'onyx',
        input: text,
      });
      const buf = Buffer.from(await mp3.arrayBuffer());
      const tmp = path.join(os.tmpdir(), `sts2-tts-${Date.now()}.mp3`);
      await fs.promises.writeFile(tmp, buf);
      await this.playAudioFile(tmp);
      fs.promises.unlink(tmp).catch(() => {});
    } catch (err) {
      logger.error('OpenAI TTS failed, falling back to system voice:', err);
      await this.speakSystem(text);
    }
  }

  /** Cross-platform local TTS — picks the right native binary for the OS. */
  private async speakSystem(text: string) {
    const platform = process.platform;
    try {
      if (platform === 'darwin') {
        await execAsync(`say ${shellEscape(text)}`);
        return;
      }
      if (platform === 'win32') {
        // PowerShell with System.Speech is built into every Windows install
        // since Vista. -EncodedCommand avoids quoting hell with arbitrary text.
        const psScript = `
Add-Type -AssemblyName System.Speech;
$s = New-Object System.Speech.Synthesis.SpeechSynthesizer;
$s.Speak([Console]::In.ReadToEnd());
`;
        const encoded = Buffer.from(psScript, 'utf16le').toString('base64');
        await new Promise<void>((resolve, reject) => {
          this.currentProc = spawn(
            'powershell.exe',
            ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
            { stdio: ['pipe', 'ignore', 'ignore'] },
          );
          this.currentProc.on('exit', () => resolve());
          this.currentProc.on('error', reject);
          this.currentProc.stdin?.write(text);
          this.currentProc.stdin?.end();
        });
        return;
      }
      // linux / other
      try {
        await execAsync(`spd-say ${shellEscape(text)}`);
        return;
      } catch {
        await execAsync(`espeak ${shellEscape(text)}`);
        return;
      }
    } catch (err) {
      logger.error('System TTS failed:', err);
    }
  }

  /** Play a local audio file using the OS's default player binary. */
  private async playAudioFile(file: string): Promise<void> {
    const platform = process.platform;
    return new Promise<void>((resolve, reject) => {
      let cmd: string;
      let args: string[];
      if (platform === 'darwin') {
        cmd = 'afplay';
        args = [file];
      } else if (platform === 'win32') {
        // Patch 19g: the previous WMPlayer.OCX implementation polled
        // `playState -ne 1`, but Windows Media Player's playState enum has
        // 1 = Stopped (the END state), 3 = Playing, 9 = Transitioning, etc.
        // The poll loop exited immediately while the audio was still in state
        // 0 (Undefined) or 9, cutting playback off before any sound came out.
        //
        // Switch to WPF's MediaPlayer (System.Windows.Media.MediaPlayer) which
        // exposes a real MediaEnded event. We pump the dispatcher until it
        // fires, with a hard 60s ceiling as a safety net for short TTS clips
        // that would normally finish in <10s.
        const uri = 'file:///' + file.replace(/\\/g, '/').replace(/'/g, "''");
        const psScript = `
$ErrorActionPreference = 'Stop';
Add-Type -AssemblyName PresentationCore;
$p = New-Object System.Windows.Media.MediaPlayer;
$done = $false;
$p.add_MediaEnded({ $script:done = $true });
$p.add_MediaFailed({ param($s,$e) Write-Error $e.ErrorException; $script:done = $true });
$p.Open([Uri]'${uri}');
$p.Play();
$start = Get-Date;
while (-not $done -and ((Get-Date) - $start).TotalSeconds -lt 60) {
  [System.Windows.Threading.Dispatcher]::CurrentDispatcher.Invoke(
    [System.Windows.Threading.DispatcherPriority]::Background,
    [Action]{}
  );
  Start-Sleep -Milliseconds 50;
}
$p.Stop();
$p.Close();
`;
        const encoded = Buffer.from(psScript, 'utf16le').toString('base64');
        cmd = 'powershell.exe';
        args = ['-NoProfile', '-NonInteractive', '-STA', '-EncodedCommand', encoded];
      } else {
        // Linux: try ffplay (silent), fall back to mpg123/aplay if needed.
        cmd = 'ffplay';
        args = ['-nodisp', '-autoexit', '-loglevel', 'quiet', file];
      }
      this.currentProc = spawn(cmd, args, { stdio: 'ignore' });
      this.currentProc.on('exit', (code) => {
        if (code !== 0 && code !== null) {
          logger.warn(`TTS playback exited with code ${code} (cmd=${cmd})`);
        }
        resolve();
      });
      this.currentProc.on('error', (err) => {
        logger.error('TTS playback spawn error:', err);
        reject(err);
      });
    });
  }
}

/** Quote a string for safe inclusion in a POSIX shell command. */
function shellEscape(s: string): string {
  // Wrap in single quotes; escape any embedded single-quote with the
  // closing-quote / escaped-quote / opening-quote dance.
  return `'${s.replace(/'/g, `'\\''`)}'`;
}
