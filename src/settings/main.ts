/**
 * Settings window renderer. Talks to the main process via the preload API
 * defined in src/preload/index.ts (window.api.settings).
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

interface AppConfigShape {
  openrouterApiKey: string;
  openaiApiKey: string;
  defaultModel: string;
  saveDirOverride: string;
  ttsProvider: 'openai' | 'system' | 'off';
  ttsVoice: string;
}

// Use a typed accessor instead of redeclaring window.api globally — the
// overlay renderer also augments Window with a different api shape, and TS
// would conflict on the merge.
const api: SettingsApi = (window as unknown as { api: { settings: SettingsApi } }).api.settings;

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
  saveDir:         $<HTMLInputElement>('saveDir'),
  saveDirStatus:   $<HTMLSpanElement>('saveDirStatus'),
  formStatus:      $<HTMLSpanElement>('formStatus'),
  saveBtn:         $<HTMLButtonElement>('saveBtn'),
  cancelBtn:       $<HTMLButtonElement>('cancelBtn'),
  detectBtn:       $<HTMLButtonElement>('detectBtn'),
  browseBtn:       $<HTMLButtonElement>('browseBtn'),
};

let initialFirstRun = false;

async function init() {
  // Populate model dropdown.
  const models = await api.getModelOptions();
  for (const m of models) {
    const opt = document.createElement('option');
    opt.value = m.slug;
    opt.textContent = m.label;
    els.model.appendChild(opt);
  }

  // Load current config.
  const { config, sources, isFirstRun, configFilePath } = await api.load();
  initialFirstRun = isFirstRun;

  els.openrouterKey.value = config.openrouterApiKey;
  els.openaiKey.value     = config.openaiApiKey;
  els.model.value         = config.defaultModel;
  els.ttsProvider.value   = config.ttsProvider;
  els.ttsVoice.value      = config.ttsVoice;
  els.saveDir.value       = config.saveDirOverride;

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
}

function annotateEnvSource(inputId: string, source: string, hasConfigValue: boolean) {
  // If the value is currently coming from the environment but NOT saved in
  // config, the input box renders blank. Show a placeholder hint so the user
  // knows a key is already active and they don't have to enter one.
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
  // Accept if the field has content, OR if env is filling it (placeholder hint shows).
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

els.cancelBtn.addEventListener('click', () => {
  // On first run, cancelling without a key is a soft-fail \u2014 the app starts
  // anyway and the advise hotkey will show an error pointing back here.
  api.close();
});

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

init().catch((err) => {
  setStatus(els.formStatus, `Failed to load: ${(err as Error).message}`, 'err');
});
