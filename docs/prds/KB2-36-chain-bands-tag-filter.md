# KB2-36 — Chain bands + tag filter: tags become a lens, not an axis

**Status:** approved 2026-08-23 (Jacob: "is it weird to have tags as a y axis? …maybe
just a colored dot or outline… click to filter… lets go ahead and build A"). Amends
KB2-30/34/35.

## Problem
Tag lanes made the y-axis lie: 17 lanes in an order that means nothing, the A4M chain
zigzagging across 5–6 of them (the layout fought the flow), multi-tag tasks filed under
their first tag only, and near-dupe tags (`cartridge`/`Cartridge`) each got a lane.
Tags are good DATA, bad GEOMETRY.

## Design (option A from the 2026-08-23 discussion)
- **Timeline y = chain bands.** Connected components over the stored blocking edges
  (zero new data — links[] is the input, membership derived fresh per load, same
  doctrine as all scheduling):
  - Components with ≥2 tasks become horizontal bands — the A4M river reads as one
    contiguous braid, greedy-packed rows inside, alternating backgrounds. Band order:
    earliest planned activity first (hot chains on top).
  - Milestones stay in the top strip (their due-line verticals unchanged); they act as
    connectors for componenthood but aren't placed inside bands.
  - Singleton unwired tasks pack into one compact "unwired backlog" region at the
    bottom (by planned date) instead of 90+ one-row bands.
  - The tag lane rail dies; the floating date axis stays.
- **Tags on the card:** colored LEFT-EDGE STRIPE for the primary tag (all tiers; far
  tier keeps the colored dot) + up to 3 small dots for additional tags in the card
  footer — multi-tag tasks stop being lossy.
- **Tag chips toolbar** (both modes, Timeline AND Flow): every tag with its color +
  count, sorted by count. Click = toggle; multi-select = union; selected chips
  highlighted; "clear". Non-matching tasks DIM (not hide — the time-shape stays
  visible); milestones never dim; an edge dims if either endpoint is dimmed. Combines
  with focus-mode dimming (OR). Doubles as the color legend.
- **Filter persists in the URL** (`?tags=a,b` via history.replaceState) — bookmarkable
  "Validation view", survives reload, no nav.
- **Data chore:** dedupe obvious case-variant tags via the existing renameTag service
  (audited) so the chips row is clean.

## Out of scope
"Group by: milestone" toggle (option B — future); rank-y scatter (option C); hiding
(vs dimming) filtered tasks; renaming semantically distinct tags (human call).

## Validation
`npm run check` baseline; live: one big band for the A4M river + small bands + unwired
block; chips filter dims correctly in both modes; URL round-trips; multi-tag dots render.
