# PRD — Kanban WIP Limit Hard Enforcement

**Domain:** Kanban / WIP discipline
**Status:** Draft
**Related:** `KANBAN-WIP-TIMELINE.md` (the visualization that surfaces the limit)

---

## Problem

WIP limits in kanban are only effective if the system enforces them. Visual cues alone (rows fill up, overflow lanes go red) train operators over time but don't prevent the same person from picking up a 4th task on a busy Monday. Today, the move-to-wip action does no per-assignee headcount check anywhere in the codebase — the limit exists only as a UX convention in the WIP Timeline widget.

## Goal

Block any move-to-`wip` action that would push the assignee over their `wipLimit`. Surface the block as a modal on the client explaining who is at limit, what's currently in their WIP, and offering a clear "OK, I'll pick something else" exit.

## Non-Goals

- Limits on backlog / ready / waiting counts. Only `wip` is capped.
- Per-project WIP limits (different projects might warrant different caps — out of scope).
- Soft warnings or "are you sure" confirmations — this is a hard block.
- Bypass mechanism for admins. (Easy follow-up; not in v1.)

## Scope

### 1. Schema

Add to `User` model (`src/lib/server/db/models/user.ts`):

```typescript
wipLimit: { type: Number, default: 3, min: 0, max: 50 }
```

`min: 0` allows admins to set a user to "blocked from WIP" (e.g., users on leave). `max: 50` is just a sanity cap.

### 2. Server-side gate

Every code path that mutates a task's status to `'wip'` must call a shared guard before applying the change:

```typescript
// src/lib/server/kanban/wip-limit.ts
export async function assertWipLimitOk(assigneeId: string | null, taskId: string): Promise<void> {
    if (!assigneeId) return;  // unassigned tasks have no limit owner
    const user = await User.findById(assigneeId).select('wipLimit username').lean();
    const limit = user?.wipLimit ?? 3;

    const currentWip = await KanbanTask.countDocuments({
        'assignee._id': assigneeId,
        status: 'wip',
        archived: false,
        _id: { $ne: taskId }   // don't count the task being moved (idempotent re-move)
    });

    if (currentWip >= limit) {
        throw error(409, JSON.stringify({
            kind: 'wip_limit_exceeded',
            assignee: user?.username ?? assigneeId,
            limit,
            currentCount: currentWip
        }));
    }
}
```

Wire into:
- `src/routes/kanban/+page.server.ts` — `move` action.
- `src/routes/kanban/task/[taskId]/+page.server.ts` — `move` action AND the `update` action when assignee changes while status=`wip`.
- `src/routes/api/kanban/move/+server.ts` — POST handler.

### 3. Client-side modal

On any move-to-wip attempt, if the response is a 409 with `kind: 'wip_limit_exceeded'`, render a modal with:

- **Title**: `{assignee} is at their WIP limit`
- **Body**:
  > {assignee} already has {currentCount} task(s) in WIP. Their limit is {limit}.
  > Move one of their existing WIP tasks forward (to Done) or backward (to Ready) first.
- **Below the body**, a list of the assignee's current WIP tasks (titles, click → task detail).
- **Single button**: "OK". Closes modal. No "force anyway" option.

Component: `src/lib/components/kanban/WipLimitModal.svelte`. Triggered from board page (`drag` and arrow-button moves), task detail page (`move` action), and API path (drag-drop → `handleDrop` in `+page.svelte`).

### 4. Admin UI

Add a `wipLimit` field to the user edit form in `src/routes/spu/admin/users/[id]/+page.svelte` (or wherever user editing lives — confirm before wiring). Number input, default 3, range 0–50. Audit-logged like other user changes.

> Confirmation needed: location of user-edit form. Per memory it's `src/routes/spu/admin/users/+page.server.ts`. PRD assumes that's right.

## Decisions

- **Default limit**: 3. Common in kanban literature.
- **Unassigned tasks bypass the check**. No assignee → no quota to enforce.
- **Idempotent re-move** (clicking move-to-wip on a task already in wip): the `_id: { $ne: taskId }` exclusion in the count makes this a no-op rather than a 409.
- **HTTP status**: 409 Conflict — accurate semantics for "current state prevents this action."
- **No bypass in v1**. Admin override is a separate PRD if needed.

## Acceptance criteria

1. A user with `wipLimit: 3` and 3 tasks already in WIP cannot move a 4th task to WIP via any of: board drag-drop, board arrow buttons, task detail move buttons. Each attempt shows the WIP limit modal.
2. The modal lists the 3 current WIP tasks for that user with clickable titles.
3. Moving a task FROM wip to anywhere else succeeds normally and frees a slot.
4. Re-clicking "Move to WIP" on a task that's already in WIP does NOT trigger the modal (idempotent).
5. Tasks with no assignee can be moved to WIP regardless of any user's limit.
6. Changing a wip-status task's assignee to someone at their limit returns 409 with the modal.
7. Admin can edit `wipLimit` for a user and it takes effect immediately (no cache).
8. Setting `wipLimit: 0` for a user blocks all WIP moves for their tasks.
9. AuditLog entries written on `wipLimit` changes (per existing user admin audit pattern).
10. `npm run check` clean.

## Files touched

| File | Change |
|------|--------|
| `src/lib/server/db/models/user.ts` | Add `wipLimit` field |
| `src/lib/server/kanban/wip-limit.ts` | New: `assertWipLimitOk()` guard |
| `src/routes/kanban/+page.server.ts` | Call guard in `move` action |
| `src/routes/kanban/task/[taskId]/+page.server.ts` | Call guard in `move` + assignee-change in `update` |
| `src/routes/api/kanban/move/+server.ts` | Call guard in POST handler |
| `src/routes/kanban/+page.svelte` | Show modal on 409 from drag-drop fetch |
| `src/lib/components/kanban/WipLimitModal.svelte` | New |
| `src/routes/spu/admin/users/[id]/+page.svelte` (or equivalent) | Add wipLimit number input |
| `src/routes/spu/admin/users/[id]/+page.server.ts` | Accept + validate `wipLimit` field; audit-log |
| `docs/prds/KANBAN-WIP-LIMIT-ENFORCEMENT.md` | This doc |

## Risk / rollback

- **False positives** during reassignment storms: if a user is at limit and a task is reassigned to them while they're already at 3, the reassignment fails. Acceptable — that's the point of the limit.
- **Race condition**: two simultaneous moves could both pass the check then both write, exceeding the limit by 1. Mitigation: use a Mongo `findOneAndUpdate` with a count predicate, or accept the rare race (re-checked on next page load). Acceptable for v1.
- **Rollback**: remove `assertWipLimitOk()` calls. Schema field stays unused.

## Open questions

- **Admin override**: should a permission `kanban:admin` allow bypassing the limit? Currently the permission exists in SECURITY.md but is never used. Easy to wire as a follow-up.
- **Modal copy**: should it suggest WHICH of the current WIP tasks to move? (E.g., highlight oldest.) v1: just list them.
