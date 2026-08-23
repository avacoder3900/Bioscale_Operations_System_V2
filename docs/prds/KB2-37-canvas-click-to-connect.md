# KB2-37 — Click-to-connect: wire dependencies directly on the roadmap canvas

**Status:** approved 2026-08-23 (Jacob: "click to connect… the left and right corners
are the chronological sides… I just click one then go find the one I want to connect
to, and then drawing the new connections starts to rearrange the roadmap. Some of the
roadmap is built through Claude but then I go and clean it up."). Amends KB2-30/36.

## Design
- **Ports.** Every task card (and milestone) grows two small visible connection dots on
  its chronological sides: **left = "starts after…"** (the blocked side), **right =
  "must finish before…"** (the blocking side). Hidden at far/dot zoom tier (too small
  to hit), visible from chip tier up.
- **Interaction (two clicks, no dragging):**
  1. Click a dot → connect mode: the dot glows, a hint appears in the canvas header
     ("Connecting TASK-041 → now click the LEFT ○ of the task that comes after it ·
     Esc cancels"). Clicking the same dot, the pane, or Esc cancels.
  2. Click the **complementary** dot on another node → the edge is created:
     A-right → B-left ≡ B-left → A-right ≡ `A blocks B` (declared as `blocked_by` on
     B, consistent with existing wiring). Clicking a SAME-side dot on another node
     re-anchors the pending end to that node instead (forgiving, no error).
  3. Port clicks stopPropagation — they never trigger focus mode.
- **Same service, same guards.** The new `?/addEdge` action wraps the existing
  `addLink` service: existence, self-link, dupe, **blocking-cycle guard** (an illegal
  loop bounces with the cycle message shown inline), audit row + activity log —
  identical protections to the panel and MCP paths.
- **Live rearrange.** On success the page invalidates → `computeRoadmap` re-runs →
  chain bands, planned queue, slack, critical chain, and milestone buffers all
  reorganize immediately. Wiring an UNWIRED ghost visibly pulls it out of the backlog
  block into its chain's band — the cleanup loop Jacob described.
- **Removal stays where it is** (task-page Dependencies panel ✕) — canvas edge
  deletion is a possible follow-up, not in scope.
- Only scheduling edges are drawable (`blocks`/`blocked_by`); `relates_to` stays
  panel-only (soft associations as arrows would clutter the map with lines the
  scheduler ignores).

## Validation
`npm run check` baseline. Live: right-dot → left-dot creates the edge and the map
reorganizes; cycle attempt shows the cycle message; Esc/pane cancels; focus mode
unaffected by port clicks.
