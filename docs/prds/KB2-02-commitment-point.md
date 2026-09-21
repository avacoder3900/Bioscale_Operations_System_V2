# KB2-02 — Commitment Point: Replenish / Demote, Global Ranked Queue, Caps

**Depends on:** KB2-01. Read `KB2-00-OVERVIEW.md` first.
This is the highest-value PRD in the set — the single enforced boundary that makes Tier 2 mean
"we committed" instead of "someone dragged it."

## 1. Concepts

- **Replenish** = promote Tier 1 → Tier 2 (`processed → ready`), assigning a global rank.
  Privileged: distinct endpoint, never reachable via task update. Weekly cadence (humans decide
  when; the system signals when the queue runs low).
- **Demote** = Tier 2 → Tier 1 (back to `processed`), audited — the honest unwind of a bad
  commitment. Frees a rank slot and closes the item's committed interval (metrics count it).
- **Replenishment event** = one sitting; groups the promotions made together
  (`replenishmentEventId` on each promotion) so the decision record is inspectable.

## 2. Permission + actor rules

- New permission **`kanban:replenish`** (added to permission catalog, Admin role, and seed
  script; grantable to specific users). Required for replenish AND demote.
- **Only a human replenishes.** UI path: `locals.user` must hold the permission. MCP/agent path:
  required `actor` username must resolve to a real, active user **who holds
  `kanban:replenish`** — the human driving Claude is the committer; Claude is the channel.
  Recorded as `{ actor, via: 'mcp' }`.

## 3. Endpoints (agent API + session-auth actions share one server module)

`src/lib/server/kanban/replenish.ts` implements; exposed as:
- `POST /api/agent/operations/kanban/replenish` (agent key + actor) and a form action on the
  Replenishment view (KB2-06).
- `POST .../kanban/demote`, `POST .../kanban/reorder` similarly.

### replenish
Input: `{ taskIds: string[] (ordered), board, actor, note? }`.
Per task, in order: verify Tier 1 + `processed` status; verify DoR complete (KB2-03 — until it
ships, verify `dor.outcome` non-empty); verify ready cap not exceeded (count of `ready` on that
board + this promotion ≤ policy cap) — reject the remainder with a clear error naming the cap;
then `transitionTask(to:'ready', allowTierCrossing:true)`, assign rank at bottom of the global
ready order (or explicit `insertAt`), stamp `replenishment: {eventId, promotedBy, promotedAt}`.
One replenishment event id for the batch. Response reports promoted / rejected-with-reasons.

### demote
Input: `{ taskId, actor, reason (required) }`. `ready|waiting|blocked → processed` (a `wip` item
must leave wip first — deliberate friction). Clears rank from the global queue (closing the gap),
keeps `committedAt` history in transitions, records reason.

### reorder
Input: `{ board, scope: 'ready' | {projectId}, orderedTaskIds }` — explicit, audited re-rank.
Strict ordinal invariant: after any write, ranks in scope are exactly 1..N, no ties (renumber on
write; ~90 active docs, cost irrelevant). Also used by Tier 1 per-project ranking.

## 4. Queue integrity + signals

- **Ready cap** (policy, seed 8/board): enforced in replenish only — never blocks demotion or
  normal Tier 2 flow.
- **Minimum order point** (policy, seed 3): when a transition or demotion drops the ready count
  below it, emit a **replenishment signal**: a `WorkflowViolation` (`type:
  'replenishment_needed'`, auto-resolving when count recovers) + surfaced in
  `operations/alerts` + the Replenishment view. This prevents queue starvation → people quietly
  pulling from Tier 1 again.
- `update_task` / all normal paths keep rejecting tier crossings (KB2-01) with an error naming
  these endpoints.

## 5. Pull (consume from the queue)

`pull` = `ready → wip` self-assignment. Stays on the normal transition path (anyone can pull) but
the transition service enforces the **pull window** (policy, seed top-3 of global ready rank):
`→ wip` from rank > 3 is rejected with "pull from the top 3 (ranks 1–3); this item is rank N."
On pull, the queue renumbers (item leaves ready scope).

## Acceptance criteria

- [ ] Tier 1 → Tier 2 impossible via any update path; possible only via replenish; every crossing
      carries actor + replenishment event id (spec §11 items 1, 14).
- [ ] Replenishing without `kanban:replenish` (or with an MCP actor lacking it) is rejected.
- [ ] Promotion beyond the ready cap rejected; count-below-min-order-point emits the signal.
- [ ] Ready ranks are always exactly 1..N per board, no ties, after every mutation.
- [ ] Pulling rank ≥ 4 rejected with explanation.
- [ ] Demotion requires a reason and returns the item to `processed`, renumbering both scopes.
- [ ] Every operation writes AuditLog + activityLog with `{actor, via}`.
