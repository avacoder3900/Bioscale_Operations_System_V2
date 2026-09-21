# KB2-30 — The roadmap canvas: infinite-zoom dependency map

**Status:** approved 2026-08-20 (Jacob: "replace it, alright i like all your choices").
Replaces the KB2-29 swimlane timeline on `/kanban/roadmap` — one screenshot of live data
showed why: unstarted tasks all pile up at "today", labels collide, and a timeline cannot
show the *graph*, which is what the plan actually is. Countdown cards + must-start list
stay; the timeline section is retired.

## Intent (from Jacob)
"A flow bubble diagram/map that is actually on an infinite zoom-in and zoom-out
whiteboard" — Miro/FigJam feel: pan anywhere, zoom smoothly from overview to detail,
tasks as cards, dependency edges flowing left-to-right into milestone diamonds.

## Stack decision (research 2026-08-20, session report in git history)
- **`@xyflow/svelte` (Svelte Flow 1.x)** — the only mature, MIT, Svelte-5-native
  infinite-canvas flow library (ground-up runes rewrite by the xyflow team). Pan/zoom,
  minimap, controls, fit-view, background grid built in; nodes are ordinary Svelte
  components so the tron card styling transfers directly.
- **`@dagrejs/dagre`** for initial left-to-right layered layout (Sugiyama, `rankdir: LR`).
  Milliseconds at this scale (~30 nodes today, comfortable to 200+). Upgrade path to
  elk.js later for program-group frames + orthogonal edge routing — not in v1.
- Rejected: tldraw (React-only + watermark/commercial license), Excalidraw (React,
  editor-shaped), Svelvet (stale, pre-Svelte-5), Cytoscape (card nodes need HTML-overlay
  hackery), Sigma/Konva/Pixi (wrong scale), GoJS (cost).

## Design
- **Left-to-right flow into milestone sinks.** Milestone nodes render as distinct
  diamonds with date + buffer; tasks as cards colored by first tag.
- **Semantic zoom, 3 tiers** (threshold-swapped node renderers, with hysteresis):
  far = dots + milestone diamonds; mid = compact chips (title, status color,
  critical border); near = full cards (tracking#, slack, estimate + source, status,
  tags, late badge). Card dimensions constant across tiers so edges don't re-anchor.
- **Critical chain**: red animated edges + red-bordered nodes. `late` nodes get a red
  corner badge.
- **Done**: faded (40% opacity, desaturated); "hide done" toggle (default off) that
  filters them out (edges to done blockers simply drop — the map is about remaining
  work when hidden).
- **Focus mode**: click a node → BFS upstream+downstream over blocking edges stays lit,
  everything else dims to ~15%; click canvas / Esc clears. Click-through link to
  /kanban/task/[id] on the card.
- **Positions: auto-layout + pinning.** dagre lays out nodes with no stored position;
  a dragged node is pinned (stored). SHARED layout (one canonical arrangement, Miro
  model) — not per-user. "Re-layout" button clears all pins (audited).
- Wheel = zoom-to-cursor, drag = pan (Svelte Flow defaults), minimap bottom-right,
  fit-view on load.

## Data
- **Scheduler** (KB2-28 addendum): `ScheduledTask` rows grow `blockedBy: string[]` —
  ALL in-subgraph predecessors (the existing `blockedByOpen` keeps only not-done ones).
  Edges on the canvas are drawn from `blockedBy`, so chains through done work stay
  visible.
- **`kanban_canvas_layout` collection** (new): `_id` = task id, `{ x, y, pinnedBy,
  updatedAt }`. Presentation-only state, deliberately OUTSIDE task documents (no task
  audit noise, no schema creep). Per-drag saves are exempt from AuditLog (high-frequency
  presentation writes; `pinnedBy` keeps accountability) — documented exception to the
  every-mutation rule. `relayout` (clear-all-pins) IS audit-logged: it destroys a shared
  arrangement.
- Actions on /kanban/roadmap: `pinNode` (x, y), `relayout` (clear pins).
- Node de-dup across milestone subgraphs: a task appearing in both chains renders once
  (min-slack occurrence wins, same rule as the old timeline).

## Out of scope
- elk.js group frames / edge routing; JSON Canvas (.canvas) export; per-user viewports;
  Monte Carlo overlays. Mobile gestures beyond what Svelte Flow ships.

## Validation
- `npm run check` at baseline; canvas renders the live 2-milestone graph; drag → reload
  → position survives; re-layout clears; focus mode dims correctly; zoom tiers swap.
