# KB2-35 — Roadmap readability: full-bleed canvas, floating axis, legible zoom

**Status:** approved 2026-08-21 (Jacob's browser review: "all the font and everything is
hard to read… no border… full screen kind of thing… dates need to float"). Amends KB2-30.

## Findings (live review, 2026-08-21)
1. The map starved for pixels: ~450px of chrome above a 72vh bordered card.
2. Text scaled linearly with zoom — at the default fit (~0.4) card titles rendered ~5px.
3. Date/lane labels lived in canvas space: pan away and you lose WHEN and WHAT LANE.
4. Long bezier sweeps into A4M crossed the whole map at full brightness.
5. Milestones floated in a dead band above the lanes.

## Design
- **Full-bleed + fullscreen.** Canvas breaks out of the card to viewport width; height
  ≈ 78vh. A ⛶ button expands to a fixed inset-0 overlay (Esc exits — after clearing
  focus mode). Countdown cards collapse to a one-line strip (◆ name · date · buffer
  badge, red when infeasible); must-start moves below the canvas.
- **Floating axis (screen-space, not canvas-space).** Month + week labels render in an
  HTML overlay pinned to the canvas top, tracking horizontal pan/zoom and ignoring
  vertical — chronology always visible. Lane labels pinned to the left edge the same
  way (track vertical only). Today marker carries a flag in the axis. Viewport state
  reaches the overlay via a ViewportReporter child (useSvelteFlow context) — canvas
  backdrop keeps only gridlines/bands.
- **Legible at every zoom.** Initial fitView clamps to zoom ≥ 0.55 (fit the near term,
  pan for the rest — a timeline need not fit four months in one screen). Semantic tiers
  retuned: dots < 0.45, chips (font 14) 0.45–0.8, full cards > 0.8. Milestone names
  counter-scale (`min(18, 12/zoom)px` → ~12px effective at any distance).
- **Edge quiet.** Non-critical edges at ~30% opacity by default (critical ~90%); focus
  mode unchanged (lit chain vs 8%).
- **Milestone strip.** Diamonds sit in a slim band directly above the top lane.

## Out of scope
Lane-level aggregate labels at far zoom; minimap redesign; print/export.

## Validation
`npm run check` baseline; browser pass: default view has readable chips + axis, fullscreen
toggle works, axis floats over vertical pan, Esc order (focus → fullscreen) correct.
