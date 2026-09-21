# KB2-34 — Whole-board roadmap: parked tasks visible, everything gets a turn

**Status:** approved 2026-08-21 (Jacob: "all tasks should show up on the map if they
aren't wired correctly and then i can use the tool to wire them"). Amends KB2-28/30.

## Problem
The roadmap rendered ONLY ancestors of dated milestones, so the map could not
distinguish "not load-bearing" from "forgot to wire" — both were invisible. The bench-
validation limb went missing exactly this way (found 2026-08-21), and wiring it flipped
A4M from +17 wd to −18 wd: absence was hiding real load. Forcing everything to "block
A4M" to become visible would Goodhart the graph (KB2-28's anti-rot rule); the fix
belongs in the view and the queue, not in fake edges.

## Design
- **`parked[]`** in the roadmap result: every open task (captured/processed/ready/wip/
  waiting/blocked/review; not archived, not icebox/declined, not milestone) that is in
  NO dated milestone's subgraph. Same row shape as scheduled tasks (rank, tags,
  duration/effort + source, plannedStart/plannedFinish).
- **The planned queue schedules EVERYTHING.** The capacity-sequenced list scheduler
  (KB2-30 addendum) now runs over ALL open tasks: milestone-chain tasks first (latest-
  start pressure, rank tiebreak), parked tasks behind them (no latest-start → sorted by
  Tier 1 rank), blocking edges among parked tasks respected. Every task gets an honest
  "when does this get its turn" date; milestone clamp semantics unchanged (buffers state
  the chain-first-discipline plan; parked work visibly queues after it).
- **Canvas renders parked tasks ghosted** (dashed grey border, ~55% opacity, "unwired"
  in the tooltip): Timeline mode — in their tag lanes at plannedStart; Flow mode — a
  packed grid BELOW the dependency graph (dagre would otherwise dump the disconnected
  set into a giant first column — the original collapse, reborn). Clickable through to
  the task page, where the KB2-33 panel wires them in; on next load they graduate into
  the graph. Header shows the unwired count.

## Out of scope
Auto-suggested edges (LLM proposals could ride `proposals` someday — graph stays
human-approved). Icebox/declined/archived stay off the map.

## Validation
`npm run check` baseline; live compute shows parked count ≈ open-tasks − chain-tasks;
parked rows carry planned dates; canvas shows ghost cards in both modes; wiring a parked
task moves it into the graph on reload.
