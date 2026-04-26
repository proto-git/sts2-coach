# Shop screen — recognition rules

The shop is the most error-prone screen for vision LLMs. This document encodes
the rules the coach applies when it sees `seen.context === "shop"`.

## What the shop screen contains

A typical shop has, left to right / top to bottom:

- **Card row** (5–7 cards): faces visible with NAME PRINTED on the card, energy
  cost in red orb, type (Attack/Skill/Power) printed on the bezel, gold price
  below. ONE card may have a yellow `%` corner badge — that's the daily sale
  (price already discounted). Cards are READABLE.
- **Relic row** (typically 3): tiny pixel-art icons on a green peg-board. NO
  TEXT, no name plate. Gold price below.
- **Potion row** (typically 3): same — small icon, no text, gold price below.
- **Card removal service**: a single large gold button with a rune on a coin.
  Price below it. Hover-tooltip says "Remove a card from your deck".
- Top status bar: HP, gold, deck-view, map button, settings.
- Bottom-left: red back-arrow to leave the shop.

The shopkeeper also wears the **Membership Card** as a permanent relic. Its
icon (gold rune coin) appears in the shop's relic for-sale row WHEN it is
actually being SOLD; otherwise the rune coin you see is the card-removal
service. Distinguishing the two is unreliable from the screenshot — they
share the same art. When in doubt, treat the rightmost rune coin in the
gold-priced lineup as card removal.

## Why icon recognition is unreliable

There are ~150 relics in STS2. The icons are 64×64 pixel art, often deliberately
ambiguous (two relics may share a colour scheme or a generic shape — disc, bottle,
charm, etc.). The model does NOT have a reference library of icon-to-name
mappings, and OpenRouter vision models are NOT trained as a STS2 icon classifier.

Empirical failure mode: the model recognises "I know the game has a relic called
Kunai (yellow knife)", sees a yellow disc on the screen, and answers "Buy Kunai
for 51g" — when the actual item is Paint Brush.

Therefore: **never name a specific relic or potion in a shop pick**.

## Slot-based vocabulary (use this instead)

When recommending a relic/potion:

- **Slot**: leftmost / second / middle / fourth / rightmost (or just "the 51g
  relic" — the price is unique within a row most of the time).
- **Color/shape**: "small red brush", "blue triangle", "yellow disc", "green
  key", "beige scroll", "gold rune coin".
- **Action**: "Buy", "Skip", "Hover to read tooltip".

Examples:

- ✓ "Buy the cheapest relic (51g, small red brush) — at that price it's worth
  the gamble."
- ✓ "Skip the relic row — 110g doesn't cover the 183g floor."
- ✓ "Buy the 25g Thunderclap (Attack, on sale) — Vulnerable AoE is a steal."
- ✗ "Buy Kunai for 51g."
- ✗ "Buy the Paint Brush." (might be Paint Brush, might not — never names.)

## Cards are exempt

Card names are PRINTED ON THE CARD on the shop screen. Always name them
verbatim in picks. The on-card text also tells you Attack vs Skill vs Power.
Card prices are below each card.

## Card removal

`Remove a card for ${N}g` is always safe to name because there's only one of
it and it's a fixed service.

## Affordability

Sum every `Ng` price token in the pick. The total MUST be ≤ player's current
gold. Coach.ts enforces this server-side.

## Per-run relic pool (when available)

The save file exposes `relic_grab_bag.relic_id_lists.shop` — the eligible draw
pool of relic IDs for THIS run (typically ~25). The coach passes these to the
model as candidate names so it knows the icon must be one of, e.g.:

```
LAVA LAMP, SCREAMING FLAGON, SLING OF COURAGE, THE ABACUS, MEMBERSHIP CARD,
PUNCH DAGGER, BRIMSTONE, MYSTIC LIGHTER, ORRERY, TOOLBOX, WING CHARM, ...
```

This narrows the search space from ~150 to ~25, but it does NOT tell us which
3 of those 25 the current shop is actually offering. STS2 computes the offerings
in-memory from RNG state and never persists them. Confirmed by inspecting an
in-shop save:

- `pre_finished_room` = null
- `acts[i].rooms.active` does not exist
- No `cards_for_sale` / `relics_for_sale` fields anywhere

So even with the candidate pool, the recognition rules above still apply.

## Shop priors (when scoring a buy)

Quick gut-check values for "is this purchase good?":

- **Card removal at 75g (early Act 1)**: almost always good. Drops to 100g/125g
  on later visits.
- **Energy relic** (Coffee Dripper, Cursed Key, Fusion Hammer, Slavers' Collar,
  Mark of Pain): if present and affordable, prioritise — energy is the highest-EV
  resource in STS.
- **Damage scaler** (Pen Nib, Kunai, Shuriken, Letter Opener, Ornamental Fan):
  good for attack-heavy decks (Ironclad, Watcher).
- **Relic at 250g+ early Act 1**: usually skip unless you have 350g+. Saving
  for the next shop's removal is often higher EV.
- **Cards on sale (% badge)**: read the discount carefully. A 50g card at 25g
  is ~50% off — common. A pricey rare card on sale is the highest-EV card buy.
- **Potions at 50–75g**: situationally good if you have an empty slot and a
  nearby elite/boss. At 100g+ usually skip.

These priors are SOFT — the deck context overrides them.
