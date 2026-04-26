/**
 * Settings window renderer. Talks to the main process via the preload API
 * defined in src/preload/index.ts (window.api.settings + window.api.diagnostics).
 */
export {}; // make this file a module so locally-declared types don't leak

interface SettingsApi {
  load: () => Promise<{
    config: AppConfigShape;
    sources: Record<string, 'config' | 'env' | 'default'>;
    isFirstRun: boolean;
    configFilePath: string;
  }>;
  save: (patch: Partial<AppConfigShape>) => Promise<{ ok: boolean; error?: string }>;
  detectSaveDir: () => Promise<{ path: string; exists: boolean }>;
  pickSaveDir: () => Promise<{ path: string | null }>;
  getModelOptions: () => Promise<Array<{ slug: string; label: string }>>;
  close: () => void;
}

interface DiagnosticsApi {
  get: (limit?: number) => Promise<DiagnosticRow[]>;
  clear: () => Promise<{ ok: boolean; deleted: number }>;
}

interface AppConfigShape {
  openrouterApiKey: string;
  openaiApiKey: string;
  defaultModel: string;
  saveDirOverride: string;
  ttsProvider: 'openai' | 'system' | 'off';
  ttsVoice: string;
  readOnlyMode: boolean;
  hotkeyDing: boolean;
}

/** Mirrors src/main/db.ts -> DiagnosticRow. */
interface DiagnosticRow {
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

// Use a typed accessor instead of redeclaring window.api globally — the
// overlay renderer also augments Window with a different api shape, and TS
// would conflict on the merge.
type WindowApi = { api: { settings: SettingsApi; diagnostics: DiagnosticsApi } };
const api:      SettingsApi    = (window as unknown as WindowApi).api.settings;
const diagApi:  DiagnosticsApi = (window as unknown as WindowApi).api.diagnostics;

const $ = <T extends HTMLElement = HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`#${id} not found`);
  return el as T;
};

const els = {
  subtitle:        $<HTMLParagraphElement>('subtitle'),
  openrouterKey:   $<HTMLInputElement>('openrouterKey'),
  openaiKey:       $<HTMLInputElement>('openaiKey'),
  model:           $<HTMLSelectElement>('model'),
  ttsProvider:     $<HTMLSelectElement>('ttsProvider'),
  ttsVoice:        $<HTMLSelectElement>('ttsVoice'),
  ttsVoiceField:   $<HTMLLabelElement>('ttsVoiceField'),
  readOnlyMode:    $<HTMLInputElement>('readOnlyMode'),
  hotkeyDing:      $<HTMLInputElement>('hotkeyDing'),
  saveDir:         $<HTMLInputElement>('saveDir'),
  saveDirStatus:   $<HTMLSpanElement>('saveDirStatus'),
  formStatus:      $<HTMLSpanElement>('formStatus'),
  saveBtn:         $<HTMLButtonElement>('saveBtn'),
  cancelBtn:       $<HTMLButtonElement>('cancelBtn'),
  detectBtn:       $<HTMLButtonElement>('detectBtn'),
  browseBtn:       $<HTMLButtonElement>('browseBtn'),
  actionsBar:      $<HTMLElement>('actionsBar'),
  // Diagnostics
  diagCount:       $<HTMLSpanElement>('diagCount'),
  diagEmpty:       $<HTMLParagraphElement>('diagEmpty'),
  diagSummary:     $<HTMLDivElement>('diagSummary'),
  diagBars:        $<HTMLDivElement>('diagBars'),
  diagTbody:       $<HTMLTableSectionElement>('diagTbody'),
  diagRefreshBtn:  $<HTMLButtonElement>('diagRefreshBtn'),
  diagClearBtn:    $<HTMLButtonElement>('diagClearBtn'),
  diagStatus:      $<HTMLSpanElement>('diagStatus'),
  speedSwitchModel: $<HTMLButtonElement>('speedSwitchModel'),
  speedSwitchModelSub: $<HTMLSpanElement>('speedSwitchModelSub'),
  speedDisableTts:  $<HTMLButtonElement>('speedDisableTts'),
  speedDisableTtsSub: $<HTMLSpanElement>('speedDisableTtsSub'),
  speedStatus:      $<HTMLSpanElement>('speedStatus'),
};

let initialFirstRun = false;
let modelOptions: Array<{ slug: string; label: string }> = [];

// ─────────────────────────────────────────────────────────────────────────────
// Settings tab
// ─────────────────────────────────────────────────────────────────────────────

async function init() {
  // Populate model dropdown.
  modelOptions = await api.getModelOptions();
  for (const m of modelOptions) {
    const opt = document.createElement('option');
    opt.value = m.slug;
    opt.textContent = m.label;
    els.model.appendChild(opt);
  }

  // Load current config.
  const { config, sources, isFirstRun, configFilePath } = await api.load();
  initialFirstRun = isFirstRun;

  els.openrouterKey.value   = config.openrouterApiKey;
  els.openaiKey.value       = config.openaiApiKey;
  els.model.value           = config.defaultModel;
  els.ttsProvider.value     = config.ttsProvider;
  els.ttsVoice.value        = config.ttsVoice;
  els.saveDir.value         = config.saveDirOverride;
  els.readOnlyMode.checked  = !!config.readOnlyMode;
  els.hotkeyDing.checked    = !!config.hotkeyDing;

  if (isFirstRun) {
    els.subtitle.textContent =
      'Welcome \u2014 paste your OpenRouter API key below to get started. ' +
      'Other settings can stay on their defaults.';
  } else {
    const file = configFilePath.replace(/^.*[\\/]/, configFilePath.includes('/') ? '/\u2026/' : '\\\u2026\\');
    els.subtitle.title = `Saved to ${configFilePath}`;
    els.subtitle.textContent = `Stored at ${file}`;
  }

  // If the user already has env-var keys in dev (.env), show a small hint
  // rather than treating them as empty.
  annotateEnvSource('openrouterKey', sources.openrouterApiKey, config.openrouterApiKey.length > 0);
  annotateEnvSource('openaiKey',     sources.openaiApiKey,     config.openaiApiKey.length > 0);

  updateTtsVoiceVisibility();
  validate();

  // If the tray asked us to land on Diagnostics, honor #diagnostics.
  if (window.location.hash === '#diagnostics') switchTab('diagnostics');
}

function annotateEnvSource(inputId: string, source: string, hasConfigValue: boolean) {
  const input = document.getElementById(inputId) as HTMLInputElement | null;
  if (!input) return;
  if (source === 'env' && !hasConfigValue) {
    input.placeholder = '(using value from environment / .env)';
  }
}

function updateTtsVoiceVisibility() {
  els.ttsVoiceField.style.display = els.ttsProvider.value === 'openai' ? '' : 'none';
}

function setStatus(node: HTMLSpanElement, text: string, kind: 'ok' | 'err' | 'info' = 'info') {
  node.textContent = text;
  node.classList.remove('ok', 'err');
  if (kind === 'ok') node.classList.add('ok');
  if (kind === 'err') node.classList.add('err');
}

function validate(): boolean {
  const ork = els.openrouterKey.value.trim();
  const envFilling = els.openrouterKey.placeholder.includes('environment');
  const ok = ork.length > 0 || envFilling;
  els.saveBtn.disabled = !ok;
  if (!ok) {
    setStatus(els.formStatus, 'OpenRouter API key is required.', 'err');
  } else {
    setStatus(els.formStatus, '', 'info');
  }
  return ok;
}

// Reveal/hide password field
document.querySelectorAll<HTMLButtonElement>('button.reveal').forEach((btn) => {
  btn.addEventListener('click', () => {
    const target = btn.dataset.target;
    if (!target) return;
    const input = document.getElementById(target) as HTMLInputElement | null;
    if (!input) return;
    input.type = input.type === 'password' ? 'text' : 'password';
  });
});

els.ttsProvider.addEventListener('change', updateTtsVoiceVisibility);
els.openrouterKey.addEventListener('input', validate);

els.detectBtn.addEventListener('click', async () => {
  setStatus(els.saveDirStatus, 'Detecting\u2026', 'info');
  try {
    const result = await api.detectSaveDir();
    els.saveDir.value = result.exists ? result.path : '';
    if (result.exists) {
      setStatus(els.saveDirStatus, `Found: ${result.path}`, 'ok');
    } else {
      setStatus(els.saveDirStatus, `Not found at ${result.path} \u2014 launch STS2 once, or use Browse\u2026`, 'err');
    }
  } catch (err) {
    setStatus(els.saveDirStatus, `Error: ${(err as Error).message}`, 'err');
  }
});

els.browseBtn.addEventListener('click', async () => {
  try {
    const result = await api.pickSaveDir();
    if (result.path) {
      els.saveDir.value = result.path;
      setStatus(els.saveDirStatus, `Selected: ${result.path}`, 'ok');
    }
  } catch (err) {
    setStatus(els.saveDirStatus, `Error: ${(err as Error).message}`, 'err');
  }
});

els.cancelBtn.addEventListener('click', () => api.close());

els.saveBtn.addEventListener('click', async () => {
  if (!validate()) return;
  els.saveBtn.disabled = true;
  setStatus(els.formStatus, 'Saving\u2026', 'info');
  try {
    const patch: Partial<AppConfigShape> = {
      openrouterApiKey: els.openrouterKey.value.trim(),
      openaiApiKey:     els.openaiKey.value.trim(),
      defaultModel:     els.model.value,
      ttsProvider:      els.ttsProvider.value as AppConfigShape['ttsProvider'],
      ttsVoice:         els.ttsVoice.value,
      saveDirOverride:  els.saveDir.value.trim(),
      readOnlyMode:     els.readOnlyMode.checked,
      hotkeyDing:       els.hotkeyDing.checked,
    };
    const result = await api.save(patch);
    if (!result.ok) {
      setStatus(els.formStatus, result.error ?? 'Save failed.', 'err');
      els.saveBtn.disabled = false;
      return;
    }
    setStatus(els.formStatus, 'Saved.', 'ok');
    setTimeout(() => api.close(), 350);
  } catch (err) {
    setStatus(els.formStatus, `Error: ${(err as Error).message}`, 'err');
    els.saveBtn.disabled = false;
  }
});

window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') api.close();
  // Cmd/Ctrl-Enter to save
  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && !els.saveBtn.disabled) {
    els.saveBtn.click();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Tab switching
// ─────────────────────────────────────────────────────────────────────────────

function switchTab(name: 'settings' | 'diagnostics') {
  document.querySelectorAll<HTMLButtonElement>('.tab').forEach((b) => {
    b.classList.toggle('active', b.dataset.tab === name);
  });
  document.querySelectorAll<HTMLElement>('.tab-panel').forEach((p) => {
    p.classList.toggle('active', p.dataset.panel === name);
  });
  // Hide the Save/Cancel footer when on Diagnostics — it's read-only there.
  els.actionsBar.style.display = name === 'diagnostics' ? 'none' : '';
  if (name === 'diagnostics') {
    void renderDiagnostics();
  }
}

document.querySelectorAll<HTMLButtonElement>('.tab').forEach((b) => {
  b.addEventListener('click', () => {
    const t = b.dataset.tab as 'settings' | 'diagnostics' | undefined;
    if (t) switchTab(t);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Diagnostics tab (Patch 17)
// ─────────────────────────────────────────────────────────────────────────────

const SEGMENTS = [
  { key: 'screenshot_ms',   cls: 'seg-shot',  label: 'Screenshot' },
  { key: 'prompt_build_ms', cls: 'seg-build', label: 'Prompt build' },
  { key: 'llm_ms',          cls: 'seg-llm',   label: 'LLM' },
  { key: 'parse_ms',        cls: 'seg-parse', label: 'Parse' },
  { key: 'tts_ms',          cls: 'seg-tts',   label: 'TTS' },
] as const;

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? Math.round((sorted[mid - 1] + sorted[mid]) / 2) : sorted[mid];
}

function fmtMs(ms: number | null): string {
  if (ms == null) return '\u2014';
  if (ms < 1000) return `${ms}`;
  return `${(ms / 1000).toFixed(2)}s`;
}

function fmtCost(usd: number | null): string {
  if (usd == null) return '\u2014';
  if (usd < 0.001) return `<$0.001`;
  return `$${usd.toFixed(3)}`;
}

function fmtWhen(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  } catch {
    return iso;
  }
}

async function renderDiagnostics() {
  setStatus(els.diagStatus, 'Loading\u2026', 'info');
  let rows: DiagnosticRow[] = [];
  try {
    rows = await diagApi.get(50);
  } catch (e) {
    setStatus(els.diagStatus, `Error: ${(e as Error).message}`, 'err');
    return;
  }
  setStatus(els.diagStatus, '', 'info');
  els.diagCount.textContent = String(rows.length);

  if (rows.length === 0) {
    els.diagEmpty.style.display = '';
    els.diagSummary.innerHTML = '';
    els.diagBars.innerHTML = '';
    els.diagTbody.innerHTML = '';
    return;
  }
  els.diagEmpty.style.display = 'none';

  // ── Summary stats (medians) ────────────────────────────────────────────────
  const totals = rows.map((r) => r.total_ms ?? 0).filter((v) => v > 0);
  const segMedians = SEGMENTS.map((s) => ({
    label: s.label,
    cls: s.cls,
    median: median(rows.map((r) => (r as any)[s.key] as number | null).filter((v): v is number => typeof v === 'number')),
  }));
  const totalMedian = median(totals);
  const totalCost = rows.reduce((acc, r) => acc + (r.cost_usd ?? 0), 0);

  // Find slowest leg by median for "Want it faster?" hinting.
  const slowest = [...segMedians].sort((a, b) => b.median - a.median)[0];

  els.diagSummary.innerHTML = '';
  els.diagSummary.appendChild(statCard('Median total', fmtMs(totalMedian)));
  for (const s of segMedians) {
    els.diagSummary.appendChild(statCard(`Median ${s.label.toLowerCase()}`, fmtMs(s.median), s.median === 0));
  }
  els.diagSummary.appendChild(statCard('Total cost', `$${totalCost.toFixed(3)}`));

  // ── Stacked bar chart (one bar per row, oldest left → newest right) ────────
  const max = Math.max(1, ...totals);
  els.diagBars.innerHTML = '';
  // Add a small legend before the bars container? We reuse the stat cards
  // for that signal. For the bars we just fill them.
  const ordered = [...rows].reverse(); // oldest left, newest right
  for (const r of ordered) {
    const bar = document.createElement('div');
    bar.className = 'diag-bar';
    const total = r.total_ms ?? 0;
    bar.title =
      `${fmtWhen(r.created_at)}\n` +
      `${r.context ?? '?'} \u2022 ${shortModel(r.model)}\n` +
      SEGMENTS.map((s) => `${s.label}: ${fmtMs((r as any)[s.key])}`).join('\n') +
      `\nTotal: ${fmtMs(r.total_ms)}`;
    for (const s of SEGMENTS) {
      const v = (r as any)[s.key] as number | null;
      if (!v) continue;
      const seg = document.createElement('span');
      seg.className = s.cls;
      // Height as % of the tallest total so visual proportion matches reality.
      seg.style.height = `${(v / max) * 100}%`;
      bar.appendChild(seg);
    }
    // If the bar has no segments (everything null), give it a tiny placeholder.
    if (!bar.children.length && total > 0) {
      const seg = document.createElement('span');
      seg.className = 'seg-llm';
      seg.style.height = `${(total / max) * 100}%`;
      bar.appendChild(seg);
    }
    els.diagBars.appendChild(bar);
  }

  // ── Table ──────────────────────────────────────────────────────────────────
  els.diagTbody.innerHTML = '';
  for (const r of rows) {
    const tr = document.createElement('tr');
    tr.appendChild(td(fmtWhen(r.created_at)));
    tr.appendChild(td(r.context ?? '\u2014'));
    tr.appendChild(td(shortModel(r.model)));
    tr.appendChild(td(fmtMs(r.screenshot_ms),   true));
    tr.appendChild(td(fmtMs(r.prompt_build_ms), true));
    tr.appendChild(td(fmtMs(r.llm_ms),          true));
    tr.appendChild(td(fmtMs(r.parse_ms),        true));
    tr.appendChild(td(fmtMs(r.tts_ms),          true));
    const totalCell = td(fmtMs(r.total_ms));
    totalCell.classList.add('total');
    tr.appendChild(totalCell);
    tr.appendChild(td(fmtCost(r.cost_usd)));
    els.diagTbody.appendChild(tr);
  }

  // ── "Want it faster?" hints ────────────────────────────────────────────────
  updateSpeedHints(slowest);
}

function statCard(k: string, v: string, dim = false): HTMLDivElement {
  const wrap = document.createElement('div');
  wrap.className = 'diag-stat';
  const kEl = document.createElement('div');
  kEl.className = 'k';
  kEl.textContent = k;
  const vEl = document.createElement('div');
  vEl.className = dim ? 'v dim' : 'v';
  vEl.textContent = v;
  wrap.appendChild(kEl);
  wrap.appendChild(vEl);
  return wrap;
}

function td(text: string, dim = false): HTMLTableCellElement {
  const cell = document.createElement('td');
  cell.textContent = text;
  if (dim && text === '\u2014') cell.classList.add('ms-dim');
  return cell;
}

function shortModel(slug: string | null): string {
  if (!slug) return '\u2014';
  // Strip vendor prefix for a tighter table column.
  const idx = slug.indexOf('/');
  return idx >= 0 ? slug.slice(idx + 1) : slug;
}

function updateSpeedHints(slowest: { label: string; median: number } | undefined) {
  if (!slowest) return;
  // Tailor the model-switch suggestion based on the current selection.
  const currentSlug = els.model.value;
  const currentLabel = modelOptions.find((m) => m.slug === currentSlug)?.label ?? currentSlug;
  els.speedSwitchModelSub.textContent =
    `Currently: ${currentLabel}. LLM median ${fmtMs(slowest.label === 'LLM' ? slowest.median : null)}` +
    (slowest.label === 'LLM' ? ' \u2014 your slowest leg.' : '. Try a smaller model if LLM is your bottleneck.');

  els.speedDisableTtsSub.textContent =
    els.ttsProvider.value === 'off'
      ? 'Already disabled.'
      : `Currently: ${els.ttsProvider.value}. ` +
        (slowest.label === 'TTS' ? 'TTS is your slowest leg \u2014 disabling cuts it.' : 'Removes the TTS leg.');
}

els.diagRefreshBtn.addEventListener('click', () => { void renderDiagnostics(); });

els.diagClearBtn.addEventListener('click', async () => {
  setStatus(els.diagStatus, 'Clearing\u2026', 'info');
  try {
    const r = await diagApi.clear();
    setStatus(els.diagStatus, `Cleared ${r.deleted} rows.`, 'ok');
    await renderDiagnostics();
  } catch (e) {
    setStatus(els.diagStatus, `Error: ${(e as Error).message}`, 'err');
  }
});

// "Want it faster?" — switch to a lighter model: jump to Settings tab and
// focus the model dropdown. We don't auto-pick because every project has
// different price/quality tradeoffs.
els.speedSwitchModel.addEventListener('click', () => {
  switchTab('settings');
  els.model.focus();
  setStatus(els.speedStatus, 'Pick a smaller model in the dropdown, then Save.', 'info');
});

// Disable TTS in one click — write through immediately so the next advise()
// is faster without the user having to remember to hit Save.
els.speedDisableTts.addEventListener('click', async () => {
  if (els.ttsProvider.value === 'off') {
    setStatus(els.speedStatus, 'Voice is already off.', 'info');
    return;
  }
  setStatus(els.speedStatus, 'Disabling voice\u2026', 'info');
  try {
    const r = await api.save({ ttsProvider: 'off' });
    if (!r.ok) {
      setStatus(els.speedStatus, r.error ?? 'Save failed.', 'err');
      return;
    }
    els.ttsProvider.value = 'off';
    updateTtsVoiceVisibility();
    setStatus(els.speedStatus, 'Voice disabled. Hit \u2325\u21E7S to test the new speed.', 'ok');
    void renderDiagnostics();
  } catch (e) {
    setStatus(els.speedStatus, `Error: ${(e as Error).message}`, 'err');
  }
});

// Watch for hash changes (e.g. tray clicks "Diagnostics" while window is open).
window.addEventListener('hashchange', () => {
  if (window.location.hash === '#diagnostics') switchTab('diagnostics');
  else if (window.location.hash === '' || window.location.hash === '#settings') switchTab('settings');
});

init().catch((err) => {
  setStatus(els.formStatus, `Failed to load: ${(err as Error).message}`, 'err');
});
