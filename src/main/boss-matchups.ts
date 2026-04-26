// Patch 18 — Boss matchup priors.
//
// Tiny static lookup keyed on save-file `bossId`. Surfaces the 1–2 most
// important things to know about the upcoming boss as a single prompt line.
// Kept conservative — generic priors, not "play these specific cards" —
// because boss IDs across STS2 EA versions are still in flux.
//
// Source: in-game boss kits + community deep dives. When in doubt, prefer
// the "default" line over a wrong-specific hint.

interface BossPrior {
  /** ID substring(s) to match (case-insensitive). Any hit qualifies. */
  match: string[];
  /** Short prior line. Will be prefixed "Act boss prior:" by the formatter. */
  line: string;
}

const PRIORS: BossPrior[] = [
  // --- Act 1 candidates ---
  {
    match: ['waterfall_giant', 'hexaghost', 'sentries', 'gremlin_nob', 'guardian'],
    line:
      'Act 1 boss — front-load survival. Build block early, value AoE for ' +
      'multi-target fights, and keep a curse-removal/heal option open.',
  },
  // --- Act 2 candidates ---
  {
    match: ['champ', 'collector', 'automaton', 'bronze_automaton'],
    line:
      'Act 2 boss — scaling matters. Have at least one win-condition card ' +
      'or poison/exhaust engine online before this fight.',
  },
  {
    match: ['time_eater', 'time eater', 'awakened_one', 'donu_deca'],
    line:
      'Act 3-style boss — energy efficiency wins. Avoid spamming low-impact ' +
      'cards; one big Strength/Focus turn is better than many small ones.',
  },
  // --- Heart / final fight ---
  {
    match: ['heart', 'corrupt_heart'],
    line:
      'Heart fight — needs sustained scaling AND artifact-piercing debuffs ' +
      '(Apotheosis, smith fully upgraded). Block routinely, never skip turn 1 buff.',
  },
];

const DEFAULT_LINE =
  'Act boss unknown — keep the deck balanced (block + scaling + answer to ' +
  'multi-target turns). Don\'t over-specialize before knowing the matchup.';

/** One-line boss prior. Returns the default line when no specific match. */
export function bossPriorLine(bossId: string | null | undefined): string {
  if (!bossId) return `Act boss prior: ${DEFAULT_LINE}`;
  const lower = bossId.toLowerCase();
  for (const p of PRIORS) {
    if (p.match.some((m) => lower.includes(m.toLowerCase()))) {
      return `Act boss prior (${bossId}): ${p.line}`;
    }
  }
  return `Act boss prior (${bossId}): ${DEFAULT_LINE}`;
}
