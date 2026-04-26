// Patch 18 — Rolling buffer of recent advice.
//
// Keeps the last N advise outputs in memory so we can pass the most recent
// 1–2 to the next call as context. Helps the model:
//   - Avoid contradicting itself when the user re-presses ⌥⇧S in quick
//     succession because they didn't see/hear the first response.
//   - Stay consistent across a multi-turn combat (model knows what it
//     committed to last turn).
//
// Cleared on context change (combat → reward, etc.) so we don't bleed
// "play Strike" advice into a card-reward screen.

import type { Advice, AdviceContext } from '@shared/types';

interface HistoryEntry {
  context: AdviceContext;
  pick: string;
  reasoning: string;
  createdAt: string;
}

const MAX_ENTRIES = 4;

let buffer: HistoryEntry[] = [];

/** Append a new advice entry. Older entries roll off the front. */
export function recordAdvice(advice: Advice): void {
  buffer.push({
    context: advice.contextGuess ?? 'unknown',
    pick: String(advice.pick ?? '').slice(0, 200),
    reasoning: String(advice.reasoning ?? '').slice(0, 200),
    createdAt: advice.createdAt,
  });
  if (buffer.length > MAX_ENTRIES) {
    buffer = buffer.slice(-MAX_ENTRIES);
  }
}

/**
 * Return up to N recent entries that share the SAME context as `currentContext`,
 * most-recent-first. Cross-context entries are filtered so we don't show the
 * model "you said play Strike" on a card-reward screen.
 */
export function recentAdviceFor(
  currentContext: AdviceContext | undefined,
  n = 2,
): HistoryEntry[] {
  if (!currentContext || currentContext === 'unknown') return [];
  return buffer
    .filter((e) => e.context === currentContext)
    .slice(-n)
    .reverse();
}

/** Format recent entries as a small prompt block. Empty string when nothing relevant. */
export function formatRecentAdviceBlock(entries: HistoryEntry[]): string {
  if (!entries.length) return '';
  const lines = entries.map(
    (e, i) => `  ${i + 1}. [${e.context}] pick="${e.pick}" — "${e.reasoning}"`,
  );
  return [
    'RECENT ADVICE (your prior calls — stay consistent unless the situation changed):',
    ...lines,
  ].join('\n');
}

/** Clear the buffer. Useful for tests and on app restart. */
export function clearAdviceHistory(): void {
  buffer = [];
}
