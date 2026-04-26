// Patch 18 — Deck archetype detection.
//
// Classifies the master deck into one of a small set of well-known STS2
// strategies based on which "scaling" or "shape" cards are present. The
// output is fed to the LLM as a single line so it knows what win condition
// the deck is heading toward — this dramatically improves card-pick advice
// (e.g. "you have Corruption + Dead Branch, prioritize exhausters" rather
// than "Strike+ is fine").
//
// Detection is intentionally conservative: a deck with no clear archetype
// is reported as "no clear archetype yet" rather than guessing.

import type { Card } from '@shared/types';

/** A named archetype with a one-line description of its win condition. */
export interface DeckArchetype {
  /** Short label, e.g. "Demon Form scaling". Used in prompts and overlays. */
  label: string;
  /** One-line description of how to play this archetype. Fed to the LLM. */
  description: string;
  /** Card IDs/names that triggered the detection — useful for debugging. */
  evidence: string[];
}

interface ArchetypeRule {
  label: string;
  description: string;
  /** Cards (lowercased substring match) that, if present, count toward this archetype. */
  signals: string[];
  /** Minimum number of signal hits required to fire. Defaults to 1. */
  minHits?: number;
}

// Order matters — earlier rules win when multiple fire on the same deck.
// Strongest, most specific archetypes go first.
const RULES: ArchetypeRule[] = [
  // -------------------- Ironclad --------------------
  {
    label: 'Demon Form scaling',
    description:
      'Stack Strength every turn via Demon Form / Inflame / Limit Break. ' +
      'Prioritize block, energy, and ways to play more attacks per turn.',
    signals: ['demon form', 'limit break', 'inflame'],
    minHits: 1,
  },
  {
    label: 'Corruption exhaust',
    description:
      'Skills cost 0 and exhaust via Corruption. Pair with Feel No Pain, ' +
      'Dark Embrace, or Sever Soul; treat exhausters as resources.',
    signals: ['corruption', 'dark embrace', 'feel no pain', 'sever soul'],
    minHits: 2,
  },
  {
    label: 'Barricade tank',
    description:
      'Block carries between turns via Barricade / Body Slam. Stack ' +
      'permanent block sources; avoid self-damage cards.',
    signals: ['barricade', 'body slam', 'entrench'],
    minHits: 1,
  },
  {
    label: 'Berserk / low-HP scaling',
    description:
      'Berserk + Rupture + Brutality = +energy/+strength while bleeding. ' +
      'Mind Blossoms and Combust are friends. Skip healing late-act.',
    signals: ['berserk', 'rupture', 'brutality', 'combust'],
    minHits: 2,
  },
  {
    label: 'Heavy Blade / Strength burst',
    description:
      'One big Heavy Blade turn ends fights. Stack Strength (Flex, Inflame) ' +
      'and energy (Bloodletting). Limit deck size to redraw the payoff.',
    signals: ['heavy blade', 'flex', 'spot weakness'],
    minHits: 1,
  },
  // -------------------- Silent --------------------
  {
    label: 'Poison',
    description:
      'Stack poison via Deadly Poison / Noxious Fumes / Catalyst. ' +
      'Survive early; finish with Catalyst+ or Bouncing Flask.',
    signals: ['deadly poison', 'noxious fumes', 'catalyst', 'bouncing flask', 'corpse explosion', 'crippling cloud'],
    minHits: 2,
  },
  {
    label: 'Shiv / discard',
    description:
      'Spam 0-cost shivs via Blade Dance / Storm of Steel / Cloak and Dagger. ' +
      'Accuracy and After Image scale the payoff turn.',
    signals: ['blade dance', 'storm of steel', 'cloak and dagger', 'accuracy', 'after image'],
    minHits: 2,
  },
  // -------------------- Defect --------------------
  {
    label: 'Frost / lock-down',
    description:
      'Apply Lock-On + frost orbs to neutralize attackers. Dualcast + ' +
      'Coolheaded snowballs block; close with Core Surge or Echo Form.',
    signals: ['cold snap', 'streamline', 'glacier', 'frost orb', 'coolheaded'],
    minHits: 2,
  },
  {
    label: 'Lightning / focus',
    description:
      'Focus + Defragment + Electrodynamics scales lightning ticks. ' +
      'Echo Form / Biased Cognition for the win turn.',
    signals: ['defragment', 'biased cognition', 'electrodynamics', 'lightning'],
    minHits: 2,
  },
  // -------------------- Watcher --------------------
  {
    label: 'Wrath stance',
    description:
      'Open with Wrath, drop big damage, then Calm before enemy turn. ' +
      'Foreign Influence and Wallop are key flex picks.',
    signals: ['wrath', 'rushdown', 'eruption', 'fasting'],
    minHits: 2,
  },
  {
    label: 'Mantra / Divinity',
    description:
      'Stack Mantra to enter Divinity; trade efficiency for the burst turn. ' +
      'Pray / Sanctity / Devotion accelerate the trigger.',
    signals: ['pray', 'sanctity', 'devotion', 'establishment'],
    minHits: 2,
  },
];

const STRIKE_ONLY_THRESHOLD = 7; // 5 Strike + 2 of anything: still a starter.

/**
 * Classify a deck into an archetype label + description. Returns null when
 * the deck is too small or too undifferentiated to commit to an archetype.
 */
export function detectArchetype(deck: Card[]): DeckArchetype | null {
  if (!deck || deck.length === 0) return null;
  const names = deck.map((c) => (c.name ?? c.id ?? '').toLowerCase());

  for (const rule of RULES) {
    const hits = rule.signals.filter((s) => names.some((n) => n.includes(s)));
    const need = rule.minHits ?? 1;
    if (hits.length >= need) {
      return {
        label: rule.label,
        description: rule.description,
        evidence: hits,
      };
    }
  }

  // Fallback: still on starter shell?
  const nonStarter = deck.filter((c) => {
    const n = (c.name ?? c.id ?? '').toLowerCase();
    return !n.includes('strike') && !n.includes('defend') && !n.includes('bash')
        && !n.includes('neutralize') && !n.includes('survivor')
        && !n.includes('zap') && !n.includes('dualcast')
        && !n.includes('eruption') && !n.includes('vigilance');
  });
  if (deck.length <= STRIKE_ONLY_THRESHOLD && nonStarter.length <= 2) {
    return {
      label: 'Starter shell — direction TBD',
      description:
        'Deck still mostly starters. Card picks should establish a win ' +
        'condition (scaling power, big payoff, or removal of starters).',
      evidence: ['deck size <= ' + STRIKE_ONLY_THRESHOLD, 'non-starters <= 2'],
    };
  }

  return {
    label: 'No clear archetype yet',
    description:
      'Mixed deck without a committed scaling plan. Look for cards that ' +
      'compound (Strength, focus, poison, exhaust synergy) and prune ' +
      'starters when offered card removal.',
    evidence: [],
  };
}

/** Format the archetype as a single line for inclusion in the user prompt. */
export function formatArchetypeLine(arc: DeckArchetype | null): string {
  if (!arc) return '';
  return `Deck archetype: ${arc.label} — ${arc.description}`;
}
