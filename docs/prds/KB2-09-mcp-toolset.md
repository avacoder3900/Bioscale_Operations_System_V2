# KB2-09 — MCP Toolset v2 (Claude as the primary interface)

**Depends on:** rolling — each tool lands with the PRD that builds its endpoint.
Read KB2-00 first. Most kanban management will happen through Claude; the tool surface IS the UX.

## Attribution (decision #6 — one shared Claude account)

Every **mutating** tool gains a required `actor: string` (BIMS username). Claude asks once per
conversation ("who am I working with?") and passes it on every call; server validates the user
exists + is active (+ holds the needed permission for privileged tools) and records
`{actor, via:'mcp'}` — the SAME fields a UI action records. Read tools take no actor. Tool
descriptions instruct Claude to never guess the actor.

## Tool surface (replaces the v1 kanban tools in `bims-mcp.ts`)

All take optional `board` (`ops|software`, default `ops`) where meaningful.

**Capture & inventory (Tier 1)**
- `kanban_capture` — create an option (`captured`). Args: title, one-line ok; optional
  description, projectId, spawnedFrom, origin (defaults `planned`; `discovered` when Claude is
  working a task — description embeds the stop-now test from KB2-07). REPLACES
  `kanban_create_task`; `ready`/status is not an argument.
- `kanban_process` — captured→processed with sizeClass + classOfService (+dueDate for
  fixed_date); renders size-class definitions from policy in the description.
- `kanban_icebox`, `kanban_decline` (reason required), `kanban_rank_options` (per-project
  reorder), `kanban_list_inventory` (filters; icebox/declined opt-in).

**Commitment (privileged — actor must hold `kanban:replenish`)**
- `kanban_replenish` — ordered taskIds → ready; returns promoted + rejected-with-reasons
  (DoR gaps, cap).
- `kanban_demote` — reason required.
- `kanban_replenishment_status` — candidates w/ DoR readiness, ready count vs cap, min-order
  signal, allocation shares, discovered-ratio suggestion. The "should we replenish?" one-call.

**Flow (Tier 2)**
- `kanban_queue` — the global queue: ready (ranked, pull window marked), wip by assignee,
  waiting/blocked with reasons, recent done. REPLACES `kanban_board_snapshot`.
- `kanban_pull` — ready→wip for actor (enforces top-3 + WIP limits server-side).
- `kanban_move` — wip→done / →review (software) / resume etc. Normal Tier 2 moves only; tier
  crossings rejected with the replenish pointer. REPLACES `kanban_update_task`'s status power.
- `kanban_block` (reason req.), `kanban_wait` (dependency + date req.).
- `kanban_edit` — title/description/dor fields/tags/assignee/dueDate — no status, no rank.
- `kanban_reorder_queue` — explicit global re-rank (audited).

**Spikes & chores**
- `kanban_close_spike` — outcome + spawned options (captured/discovered).
- `kanban_batch_chores` — create a chore referencing Tier 1 items + timebox; on close, mark
  each done or return to captured (KB2-04/spec §5.7).

**Metrics & policy**
- `kanban_flow_metrics` — age list w/ SLE bands, flow-debt flags, throughput, discovered ratio,
  expedite rate. NEVER per-person aggregates (enforced upstream, KB2-05).
- `kanban_get_policy` / `kanban_set_policy` (actor needs `kanban:admin`).
- `kanban_task_history` — transitions + activity for one item (keeps v1 `kanban_task_transitions`).

**Kept from v1:** `kanban_create_subtasks` (parent containment), `kanban_merge_tasks`,
proposals + violations tools, `kanban_projects_overview`.

## Descriptions carry the method

Tool descriptions are where Claude learns the system's rules: capture-not-commit, the stop-now
test, outcome-not-steps for DoR, pull-from-top-3, only-humans-replenish. Write them as policy
prompts, not just API docs — this is load-bearing (spec-quality behavior with zero fine-tuning).

## Acceptance criteria

- [ ] Every mutating tool requires + validates `actor`; privileged tools check permission.
- [ ] No tool can set a Tier 2 status from Tier 1 except `kanban_replenish`.
- [ ] v1 tools that allowed status jumps (`kanban_create_task` with status, `kanban_update_task`)
      are removed/replaced; docs/MCP-SERVER.md updated.
- [ ] A full week of kanban management is possible through Claude alone (capture → process →
      replenish → pull → block/wait → done → metrics review).
