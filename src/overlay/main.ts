export {};

declare global {
  interface Window {
    api: {
      onAdvice: (cb: (a: any) => void) => void;
      onState: (cb: (s: any) => void) => void;
      onLockChange: (cb: (locked: boolean) => void) => void;
      getState: () => Promise<any>;
      getModel: () => Promise<string>;
      getLocked: () => Promise<boolean>;
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
