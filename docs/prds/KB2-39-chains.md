# KB2-39 — Chains: the unit of processing

**Status:** approved 2026-09-01 (Jacob: "make chains a core concept… blockers and blocking are
what make the chain… a chain can have branches… only the immediate work belongs in chains
because chains are kind of a part of processing… go review the plans"). Amends KB2-03
(processing), KB2-27 (plans/milestones), KB2-28/30/36 (roadmap bands), KB2-06 (Tier 1 view),
KB2-09/18 (MCP snapshot).

## What the plans showed

The three filed plans (Fall roadmap v4, M1 20-SPUs, M2 robot-arm) are each a workshop over a
whole milestone: split, merge, retitle, defer, decline, add spikes, sequence tracks, wire
blocks/relates, make scope calls, record risks, "estimate pass pending". That is processing —
and its unit is the chain, not the task. The per-task Process modal (size, class, DoR) is only
the last mile. Live board on 2026-09-01: all four milestone chains are wired, yet 56 of 71
chain tasks are still status `captured`; M1 has 2 of 13 tasks with real estimates. The plans
M1/M2 show 0 spawned tasks because nothing links a plan to its milestone. So the system holds
two disagreeing meanings of "processed" (structurally shaped vs. sized) and three overlapping
objects (plan, milestone, chain) that are the same thing at different moments.

## Definition

- **A chain is a milestone's dependency DAG**: the milestone task plus every task that
  transitively blocks it, via `blocks`/`blocked_by` links. Branches are normal (parallel tracks
  merging at the milestone). Named by the milestone; dated by its `dueDate`.
- **Derived, never stored** — recomputed per load from `links[]`, like every scheduler
  output (KB2-28 doctrine). Adding an edge moves a task into a chain instantly.
- **Order** = topological order over the chain's edges, rank as tiebreak. Siblings on parallel
  branches simply sit next to each other.
- **Primary chain** when a task blocks several milestones: earliest `dueDate` (undated last),
  fewer tasks as tiebreak. The task shows "also in" the others.
- **Unanchored chains**: connected tasks with no milestone downstream. Named by their terminal
  task ("→ Title"). They exist so wiring without a milestone is still visible, not encouraged.
- **Unwired** tasks (no blocking edges at all) are the inbox — captured work that has not
  been processed structurally. Not a chain.
- **Next up** = a chain task that is not done and whose blockers are all done. "Behind N" =
  N open tasks must finish before it.
- **Plan ↔ chain**: a `PlanningDocument` carries `milestoneId`. The chain header links to
  its plan; the plan page shows its chain's live progress. Plan, milestone and chain collapse
  into one object seen at three moments (rationale, anchor, live DAG).

## Two levels of processing, made explicit

1. **Chain-level** (the workshop, through Claude + MCP): wire the DAG, split/merge, scope,
   spikes, file the plan with its `milestoneId`. Output: a chain whose tasks may still be
   `captured`.
2. **Task-level** (the Process modal): size, class, DoR, estimate. **"Process this chain"**
   walks a chain's captured tasks in dependency order through the existing modal, one after
   another — M1's eleven sizings in one sitting. Estimate days joins the Tier 1 modal (it was
   only on the task page).

## Surfaces

- `src/lib/server/kanban/chains.ts` — `deriveChains()` → `{ chains[], byTask{} }`. One source
  for every surface below.
- **Tier 1** (`/kanban/inventory`): chain badge on every wired row from the moment it is
  wired (even while captured): "M1 · next up" / "M1 · behind 3" / "+1 chain". Chain filter
  chips (like tag chips). **View toggle "By rank | By chain"**: grouped list, chain headers
  (name, due, done/total, "n here", plan link, **Process chain** button), tasks in chain
  order, then an **Unwired** group in rank order. Rank is untouched; the chain view is a lens.
  `?chain=<id>` opens the chain view filtered; `&process=1` starts the walk.
- **Roadmap**: timeline bands become chains (primary membership), sorted by due date, each
  with a label rail: name · due · buffer (from the scheduler) · done/total · "Tier 1 ›" (opens
  the chain view) · plan link. Unanchored chains follow; the UNWIRED block stays.
- **Task page**: Task Info gains Chain (link), position "3 of 13", next up / behind N,
  "also in".
- **Plans**: list + detail show the linked milestone and live chain progress (done/total,
  next up) instead of relying on `sourceRef` alone. `kanban_file_plan` accepts `milestoneId`;
  agent API `POST /plans` validates it is a milestone task.
- **MCP** (3.5.0): every task in `kanban_board_snapshot` carries
  `chain: { id, name, position, total, nextUp, behind, also[] } | null`.
- **Backfill**: `scripts/backfill-plan-milestones.ts` parses "**Milestone:** TASK-NNN" from
  each plan's content and sets `milestoneId` (dry-run default, `APPLY=1` to write). Links M1 →
  TASK-111, M2 → TASK-127; v4 names two milestones and stays unlinked (its tasks already carry
  `sourceRef`).

## Non-goals

- Storing chain ids on tasks. Storing derived order. Re-ranking Tier 1 by chain.
- Inferring links (KB2-27: links are human-finalized, then written).
- Per-person anything (KB2-00 #12).
- Making chain a tag (KB2-36: tags are a lens, chain is structure).

## Acceptance

1. `deriveChains()` on the live board returns four milestone chains with the same membership
   as the scheduler's milestone subgraphs; M1 order starts with TASK-113/125 tracks and ends at
   TASK-124.
2. Tier 1 "By chain" groups M1's captured tasks in dependency order under an "M1 · due Sep 22"
   header; "Process chain" opens the Process modal on the first captured task and advances to
   the next on save.
3. Roadmap bands are labeled with milestone name/due/buffer and sorted by due date; clicking
   "Tier 1 ›" lands on the chain view filtered to that chain.
4. Backfill links M1 and M2 to their milestones; `/kanban/plans` shows their live progress.
5. `kanban_board_snapshot` tasks carry `chain`; unwired tasks carry `chain: null`.
6. `npm run check` stays at baseline (11).
