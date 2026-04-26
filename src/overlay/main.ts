export {};

declare global {
  interface Window {
    api: {
      onAdvice: (cb: (a: any) => void) => void;
      onState: (cb: (s: any) => void) => void;
      onLockChange: (cb: (locked: boolean) => void) => void;
      onPending: (cb: (info: { kind: 'advise' | 'deck-dump'; ding: boolean }) => void) => void;
      onError: (cb: (msg: string) => void) => void;
      onReadOnlyChange: (cb: (v: boolean) => void) => void;
      getState: () => Promise<any>;
      getModel: () => Promise<string>;
      getLocked: () => Promise<boolean>;
      getReadOnly: () => Promise<boolean>;
      setLocked: (v: boolean) => void;
      hideOverlay: () => void;
      resizeOverlay: (h: number) => void;
      dragOverlay: (dx: number, dy: number) => void;
      endDragOverlay: () => void;
    };
  }
}

const $ = (id: string) => document.getElementById(id)!;

let locked = true;

function reportSize() {
  const card = document.querySelector('.card') as HTMLElement | null;
  if (!card) return;
  const h = card.getBoundingClientRect().height + 24;
  window.api.resizeOverlay(h);
}

function applyLock(l: boolean) {
  locked = l;
  const card = $('card');
  card.classList.toggle('unlocked', !l);
  card.classList.toggle('locked', l);
  ($('pin') as HTMLButtonElement).title = l ? 'Unlock to move' : 'Click to lock';
  ($('pin') as HTMLButtonElement).textContent = l ? '📌' : '📍';
}

// ── Patch 16: "Thinking…" pending state + ding ────────────────────────────

/** Cached AudioContext — lazy-created on first ding. Resumed on each play. */
let audioCtx: AudioContext | null = null;

/**
 * Synthesize a quick two-note chime (E5 → A5) using Web Audio. Cheaper than
 * shipping a wav and avoids native deps. Total length ~140ms, peak gain 0.08
 * so it's a soft acknowledgement, not a notification.
 */
function playDing() {
  try {
    if (!audioCtx) audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)();
    if (audioCtx.state === 'suspended') void audioCtx.resume();
    const t0 = audioCtx.currentTime;
    const tones: Array<{ freq: number; start: number; dur: number }> = [
      { freq: 659.25, start: 0,    dur: 0.07 }, // E5
      { freq: 880.00, start: 0.06, dur: 0.10 }, // A5
    ];
    for (const tone of tones) {
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.type = 'sine';
      osc.frequency.value = tone.freq;
      const start = t0 + tone.start;
      const end   = start + tone.dur;
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(0.08, start + 0.012);
      gain.gain.exponentialRampToValueAtTime(0.0001, end);
      osc.connect(gain).connect(audioCtx.destination);
      osc.start(start);
      osc.stop(end + 0.02);
    }
  } catch {
    // Audio is best-effort — never block the UI on it.
  }
}

let pendingTimer: number | null = null;

function setPending(kind: 'advise' | 'deck-dump', ding: boolean) {
  const card = $('card');
  card.classList.add('pending');
  // Stash original copy so we can avoid replacing real advice if a stale
  // pending event ever arrives. We always overwrite though — the next
  // advice payload will replace these.
  $('ctx').textContent = kind === 'deck-dump' ? 'deck dump' : 'thinking';
  $('pick').textContent = kind === 'deck-dump' ? 'Reading save…' : 'Thinking…';
  $('reasoning').textContent = '';
  $('runner').textContent = '';
  $('long').textContent = '';
  $('plan-summary').textContent = '';
  $('ascii-map').textContent = '';
  if (ding) playDing();
  // Safety net: if advice never arrives (network hang), clear the pending
  // state after 30s so the UI doesn't lie forever.
  if (pendingTimer != null) window.clearTimeout(pendingTimer);
  pendingTimer = window.setTimeout(() => {
    if (card.classList.contains('pending')) {
      card.classList.remove('pending');
      $('pick').textContent = 'No response (timed out).';
      $('reasoning').textContent = 'The model didn\u2019t reply within 30s. Try again, or check Diagnostics.';
    }
  }, 30000);
  requestAnimationFrame(reportSize);
}

function clearPending() {
  $('card').classList.remove('pending');
  if (pendingTimer != null) {
    window.clearTimeout(pendingTimer);
    pendingTimer = null;
  }
}

function setReadOnly(v: boolean) {
  $('card').classList.toggle('ro', v);
  requestAnimationFrame(reportSize);
}

function wireDrag() {
  const header = $('header');
  let dragging = false;
  let lastX = 0, lastY = 0;

  header.addEventListener('mousedown', (e) => {
    if (locked) return;
    if ((e.target as HTMLElement).closest('.icon-btn')) return; // don't drag when clicking buttons
    dragging = true;
    lastX = e.screenX;
    lastY = e.screenY;
    e.preventDefault();
  });

  window.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    const dx = e.screenX - lastX;
    const dy = e.screenY - lastY;
    lastX = e.screenX;
    lastY = e.screenY;
    window.api.dragOverlay(dx, dy);
  });

  window.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    window.api.endDragOverlay();
  });
}

async function init() {
  ($('close') as HTMLButtonElement).addEventListener('click', () => window.api.hideOverlay());
  ($('pin') as HTMLButtonElement).addEventListener('click', () => {
    window.api.setLocked(!locked);
  });

  window.api.onLockChange((l) => applyLock(l));
  applyLock(await window.api.getLocked());

  wireDrag();

  const long = document.querySelector('.long') as HTMLDetailsElement | null;
  long?.addEventListener('toggle', reportSize);

  const card = document.querySelector('.card') as HTMLElement | null;
  if (card && 'ResizeObserver' in window) {
    new ResizeObserver(reportSize).observe(card);
  }

  const model = await window.api.getModel();
  $('model').textContent = model ?? '';

  const state = await window.api.getState();
  renderState(state);

  window.api.onAdvice((a: any) => {
    clearPending();
    $('ctx').textContent = a.contextGuess ?? 'advice';
    $('pick').textContent = a.pick ?? '';
    $('reasoning').textContent = a.reasoning ?? '';
    $('runner').textContent = a.runnerUp ? `Runner-up: ${a.runnerUp}` : '';
    $('long').textContent = a.longForm ?? '';
    $('model').textContent = a.model ?? '';
    $('plan-summary').textContent = a.planSummary ? `plan → ${a.planSummary}` : '';
    $('ascii-map').textContent = a.mapAscii ?? '';
    const l = document.querySelector('.long') as HTMLDetailsElement | null;
    if (l) l.open = false;
    requestAnimationFrame(reportSize);
  });

  window.api.onState((s: any) => {
    renderState(s);
    requestAnimationFrame(reportSize);
  });

  // Patch 16: hotkey ack.
  window.api.onPending((info) => setPending(info.kind, info.ding));
  window.api.onError((msg) => {
    clearPending();
    $('ctx').textContent = 'error';
    $('pick').textContent = 'Error';
    $('reasoning').textContent = msg;
  });
  window.api.onReadOnlyChange((v) => setReadOnly(v));
  setReadOnly(await window.api.getReadOnly());

  requestAnimationFrame(reportSize);
}

function renderState(s: any) {
  if (!s) {
    $('deck-summary').textContent = 'No save data yet.';
    return;
  }
  if (s.summary) {
    $('deck-summary').textContent = s.summary;
    return;
  }
  const parts = [
    s.character ?? '?',
    `A${s.ascension ?? 0}`,
    `Fl${s.floor ?? '?'}`,
    s.hp ? `${s.hp.current}/${s.hp.max} hp` : '',
    s.gold != null ? `${s.gold}g` : '',
    `${s.deck?.length ?? 0} cards`,
    `${s.relics?.length ?? 0} relics`,
  ].filter(Boolean);
  $('deck-summary').textContent = parts.join(' · ');
}

init();
