> **Filed 2026-08-18 as KB2-18. Implemented same day on `feat/kanban-tweaks` — all of P0-1, P0-2, P1-3, P1-4, P1-5, P2-6.** Decisions taken during build (each was flagged "decide, then implement" in the spec):
> - P0-1: `dor` optional at capture (not required). Same shape on `kanban_capture_bulk` items and `kanban_create_subtasks`. Audit `created` activity carries `dorSetAtCapture:[fields]`.
> - P0-2: **per-item results**, not a transaction. `POST /api/agent/operations/kanban/tasks/bulk`, 1–50 items.
> - P1-3: hygiene at the root — `normalizeTags()` (trim, collapse whitespace, case-fold onto the existing vocabulary, de-dupe) runs inside `createKanbanItem` and on every tags write (agent PATCH, merge, UI capture). `kanban_rename_tag` for migrations. Rejecting-by-casing was NOT chosen; folding is friendlier and reaches the same closed vocabulary.
> - P1-4: built on Alejandro's KB2-20 typed links (`blocks` / `blocked_by` / `relates_to`, stored one-way, inverse derived) rather than a parallel `blockedBy` field. `blockedBy: string[]` is accepted as sugar → `blocked_by` links. DFS cycle guard on blocking edges. Snapshot carries `links` + resolved `blockedBy` / `blocks`. `kanban_replenishment_status` **warns** (`blockedByOpen`, `warning`), never hard-blocks. Optional "last blocker done" message: NOT built this round.
> - P1-5: `parentTaskId` on `kanban_update_task` (`null` detaches); parent must exist, no self, no cycles, **max depth 3**; **no status coupling** (nothing in the kanban services coupled parent/child status, so nothing had to change).
> - P2-6: capture echo (id, trackingNumber, description, itemType, origin, dor, dorSet, links); merge de-dupes tags case-insensitively; `dorChecklist` per candidate; snapshot params `statuses` / `tag` / `includeActivity`; the two `MCP Test` artifacts were declined 2026-08-18 (reason "test artifacts"). MCP server 3.0.2 → 3.1.0.
# BIMS Kanban MCP â€” Improvement Spec

**Origin:** Findings from a live ~45-operation roadmap import via the MCP (Aug 18, 2026): 41 `kanban_capture` calls, ~6 `kanban_update_task` enrichments, 1 `kanban_merge_tasks`, 1 `kanban_disposition` icebox. Everything worked; these are the friction points and gaps that surfaced.

**Audience:** Claude Code agent working in the BIMS repo. Each item below is independently shippable. Priorities: P0 = blocking the roadmap workflow we're actively running, P1 = high-leverage soon, P2 = design-decision-required or nice-to-have.

**Conventions to preserve (do not regress):**
- Every mutating tool takes a required `actor` (BIMS username of the human the change is on behalf of) and is audit-logged.
- Tier-crossing rules are enforced server-side (`captured â†’ ready` rejected; commitment goes through `kanban_replenish` / `kanban_demote`).
- Two-tier semantics: capture is cheap and unshapen; sizing/classing happen at processing; commitment at replenishment.
- Spikes require `spike.question` + `spike.timebox` at creation.
- `kanban_capture` currently returns `{ id, title, status, tags, parentTaskId, createdAt }` â€” keep response shapes stable or additive.

---

## P0-1 Â· Accept `dor` (Definition of Ready) at capture time

### Problem
`kanban_update_task` exposes structured DoR fields:

```
dor: {
  deliverable:  "What will exist or be true when this is done â€” and how you'd verify it. Outcome, not steps."
  handoffBrief: "The coding-agent handoff brief (required to commit items tagged 'software')."
}
```

`kanban_capture` does not accept `dor` at all. During the import, 41 tasks were created whose exit criteria were already known and workshopped â€” they had to be embedded in `description` prose. Backfilling them into the structured field now requires 41 additional `kanban_update_task` calls.

### Design tension (decide, then implement)
The system's philosophy says shaping happens at *processing*, not capture â€” so omitting DoR from capture may have been intentional. However, real workflows (planning workshops, template-driven work, John's incoming punch list) produce options that are **born shaped**. Recommendation: make `dor` **optional** at capture. Its absence keeps the cheap-capture path unchanged; its presence pre-fills what processing would otherwise ask for. Do **not** make it required.

### Change
- Add optional `dor` object (same schema as `kanban_update_task`) to `kanban_capture` input.
- Same for each element of `kanban_create_subtasks.subtasks[]`.
- Persist identically to the update path; audit log should note DoR was set at capture.
- Response: include a `dor` echo (or at least a boolean `dorSet`) so callers can verify.

### Acceptance
- Capture with `dor.deliverable` â†’ task shows the deliverable in the UI's DoR section, not in description.
- Capture without `dor` â†’ behavior identical to today.
- Replenishment readiness checks (`kanban_replenishment_status` DoR-readiness) recognize capture-time DoR the same as processing-time DoR.

---

## P0-2 Â· Bulk capture: `kanban_capture_bulk`

### Problem
41 tasks = 41 round-trips. The chat client also has a per-turn tool budget, so a large import got split across turns mid-flight. `kanban_create_subtasks` already proves the array pattern works â€” it just requires a parent.

### Change
New tool `kanban_capture_bulk`:

```
{
  actor: string (required),
  items: [ { â€¦exact same schema as a single kanban_capture, minus actorâ€¦ } ]  // 1â€“50 items
}
```

- Validate **all** items first; then either (a) all-or-nothing transactionally, or (b) per-item results with `{ index, success, id | error }`. Recommendation: **per-item results** â€” partial success with precise reporting is more useful for imports than rollback, and matches Mongo's non-transactional grain. Whichever you pick, document it in the tool description so the agent calling it knows.
- Each item audit-logged individually (same as today).
- Spike items still require `spike.question` + timebox â€” reject that item, not the batch.
- Response: array of per-item results in input order + summary counts.

### Acceptance
- 40-item mixed batch (deliverables, chores, one malformed spike) â†’ 39 created, 1 rejected with a clear per-item error, order preserved.
- Empty `items` or >50 â†’ validation error.

---

## P1-3 Â· Bulk tag operations: `kanban_rename_tag`

### Problem
Tag taxonomy migration (retiring `Misc Operations and Supporting Tasks`, folding `Cartridge Production` â†’ `Filling Line`, fixing `cartridge` vs `Cartridge` casing drift) currently requires one `kanban_update_task` per task, and the caller has to first snapshot the whole board to find affected tasks. Casing drift already exists in production data.

### Change
New tool `kanban_rename_tag`:

```
{
  actor: string (required),
  from: string,           // exact match, case-sensitive
  to: string | null,      // null/empty = remove the tag entirely
  scope?: "active" | "all"  // default "active": skip declined + archived; "all" includes them
}
```

- Returns count of tasks touched + their ids.
- Audit-log one entry per touched task (rename is a task mutation) plus one summary entry.
- Dedupe: if a task already has `to`, just drop `from` (no duplicate tags).
- **Also fix at the root:** normalize/trim tags on write in `kanban_capture` / `kanban_update_task`, and consider case-insensitive duplicate detection with a canonical-casing table so `cartridge`/`Cartridge` can't fork again. If a canonical table is too much, at minimum reject a new tag that differs from an existing tag only by case, with a helpful error naming the existing casing.

### Acceptance
- Rename `cartridge` â†’ `Cartridge` on scope=all â†’ the Zebra task updated; no task ends up with both.
- Rename with `to: null` removes the tag everywhere in scope.
- New capture with tag `" Cartridge "` stores `"Cartridge"`.

---

## P1-4 Â· Structured task dependencies

### Problem
The roadmap has real gating: e.g. the foam-quantification spike gates the LDS decision (Cortisol), foam mitigation (Packaging), and handling procedure; "Publish locked recipe v1.0" gates stability, human testing, and validation work. Today those gates live in description prose ("Gates on â€¦"), which nothing enforces or visualizes. `waitingOn` exists only as free text attached to the *waiting* status â€” it's not a relationship.

### Design decision required (recommend the light version)
Full dependency management (DAG validation, critical path, auto-unblocking) is likely overkill for board scale (~100 active tasks). Recommended **light version**:

- Add `blockedBy?: string[]` (task ids) to the task model; settable in `kanban_capture`, `kanban_capture_bulk`, and `kanban_update_task`.
- Validation: referenced ids must exist; reject self-reference; reject cycles with a simple DFS (board is small â€” this is cheap).
- `kanban_board_snapshot`: include `blockedBy` (ids + resolved titles) and a derived `blocks` reverse list per task.
- `kanban_replenishment_status`: flag a candidate whose blockers aren't done â€” **warn, don't hard-block** (humans may consciously pull gated work).
- Optional QoL: when the last blocker of a task moves to `done`, emit an agent message (existing `send_message` machinery) to the task's assignee or the actor who set the dependency.
- Explicitly out of scope: Gantt/critical-path, cross-board deps, auto status changes.

### Acceptance
- Set `blockedBy` on an existing task via update; snapshot shows both directions.
- Cycle attempt (Aâ†’Bâ†’A) rejected with a clear error.
- Replenishment status shows a "blocked by open task(s): â€¦" warning on gated candidates.

---

## P1-5 Â· Retroactive re-parenting: `parentTaskId` on `kanban_update_task`

### Problem
`parentTaskId` is only settable at creation. During roadmap consolidation, several *existing* tasks were identified as components of new milestone tasks (e.g. Alejandro's "Opentron calibration for cartridge in robot arm deck", "Synchronized opentron+robot arm protocol", "New acrylic deck" are all components of the new "Milestone: robot-arm automated wax filling end-to-end"). Today that relationship can only be described in prose.

### Change
- Add optional `parentTaskId?: string | null` to `kanban_update_task` (`null` detaches).
- Validation: parent must exist; no self-parenting; no cycles; decide + document max depth (recommend matching whatever `kanban_create_subtasks` implies â€” likely depth 1â€“2).
- Decide + document interaction with Tier-2 status: recommend **no coupling** (a parent can be captured while a child is ready) â€” the milestone-with-flowing-components pattern requires it. If existing subtask logic assumes coupling, surface that in the PR rather than silently changing it.
- Audit-log the re-parent on both parent and child.

### Acceptance
- Attach three existing ready-column tasks to a captured milestone parent â†’ allowed; board snapshot shows the relationship; no status side effects.
- Detach with `null` works and is logged.

---

## P2-6 Â· Smaller items (batch into one PR if convenient)

1. **`kanban_capture` response completeness** â€” return the stored `description`, `itemType`, `origin`, and (if P0-1 lands) `dor`, so callers can verify writes without a follow-up snapshot read.
2. **Merge + tags** â€” `kanban_merge_tasks` folds source tags into target; after P1-3's normalization, make sure merge dedupes case-insensitively.
3. **`handoffBrief` discoverability** â€” the "required to commit items tagged `software`" rule currently lives only in the `dor.handoffBrief` field description on the update tool. Surface it in `kanban_replenishment_status` output (per-candidate DoR checklist: `deliverable: âœ“/âœ—`, `handoffBrief: âœ“/âœ—/n-a`) so the requirement is visible *before* a replenish attempt fails.
4. **Snapshot size** â€” `kanban_board_snapshot` returns full `recentActivity` for every task including 36 declined migration artifacts; it's already large. Add optional params: `statuses?: string[]`, `includeActivity?: boolean` (default true for back-compat), `tag?: string`. Pure read-path, low risk, big token savings for agent callers.
5. **Test-artifact cleanup** â€” two MCP smoke-test tasks from Aug 18 are still in `captured`: `TyRC4T8o-_VLmUYqwpGC_` and `xHM-2SXTMoNMdinbGjg-S` ("MCP connection test task A/B â€” safe to delete", tagged `MCP Test`). While you're in the codebase, decline them (reason: "test artifacts") or have Nick do it in the UI. Not a code change â€” just housekeeping riding along.

---

## Explicit non-goals for this round
- No changes to tier-crossing rules, replenishment mechanics, WIP limits, or pull-window behavior.
- No UI work beyond what's needed to display `dor`-at-capture and `blockedBy` (P0-1, P1-4) â€” and if UI display of `blockedBy` is heavy, ship the data model + MCP first; prose descriptions remain the human-readable fallback.
- No dependency automation (auto status transitions) â€” warnings and messages only.

## Suggested implementation order
1. **P0-1** (`dor` at capture) â€” smallest change, unblocks the DoR backfill being one clean pass for future imports.
2. **P0-2** (`kanban_capture_bulk`) â€” needed before John's A4M punch list import.
3. **P1-3** (tag rename + normalization) â€” unblocks the taxonomy cleanup pass.
4. **P1-4 / P1-5** (dependencies, re-parenting) â€” ship together; both touch the task model + snapshot.
5. **P2-6** batch.

After P0-1/P0-2 deploy, the pending work queued on the chat side is: DoR deliverable backfill on the 41 new roadmap tasks (~15 of which are `software`-tagged and will also need `handoffBrief` before commitment), the re-tag cleanup pass, and the John punch-list import â€” all currently frozen pending Nick's review of the roadmap list.
