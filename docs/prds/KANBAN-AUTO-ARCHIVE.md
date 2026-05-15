# PRD — Kanban Auto-Archive

**Domain:** Kanban / Task Management
**Branch:** `feature/kanban-improvement`
**Author:** Jacob Q
**Status:** Draft
**Related:** `DOMAIN-02-KANBAN.md`, `SEC-02-KANBAN-PERMISSIONS.md`

---

## Problem

Two related gaps in the kanban archive flow:

1. **Per-task archive is broken.** The `Archive Task` button on `/kanban/task/[taskId]/+page.svelte` posts to a form action `?/archive` that does not exist on the server. Clicking it returns a 404 "Action not found" error.

2. **No automatic archive of completed work.** Done tasks accumulate forever on the board unless a user manually clicks "Archive All Done Tasks" on `/kanban/archived`. There is a cron endpoint at `/api/cron/archive-done-tasks` that does the bulk-archive work, but it is not wired to any schedule and its auth/method shape is incompatible with Vercel Cron (POST-only, agent-key-only).

Net effect: the board gets cluttered with stale done items, and the only single-task archive UI is silently broken.

## Goal

Done items disappear from the active board automatically once a week, with the option for a user to archive a single task from its detail page in the meantime. The archive operation is idempotent, audit-logged, and safe to re-run.

## Non-Goals

- Auto-archive of any status other than `done`. (Backlog/Ready cleanup is a separate question.)
- Restoring archived tasks from the UI. (Currently archived tasks are read-only — that stays.)
- Project archiving. (Projects already have `isActive` toggle — separate feature.)
- Notifications/emails about what was archived. The cron is silent; users can audit via the AuditLog row or the `/kanban/archived` view.

## Scope

### 1. Fix per-task archive (immediate bug fix)

Add an `archive` form action to `src/routes/kanban/task/[taskId]/+page.server.ts`.

**Behavior:**
- Requires session + `kanban:write` permission (matching the other actions on this page).
- **Rejects with `fail(400)` if the task's `status !== 'done'`.** Only done tasks can be archived. The error surfaces in the existing `form?.error` banner at the top of the page.
- Sets `archived: true`, `archivedAt: new Date()` on the task.
- Pushes an `activityLog` entry with action `'archived'`.
- Writes an `AuditLog` entry (`action: 'UPDATE'`, `tableName: 'kanban_tasks'`).
- Returns `{ success: true }`. The existing client code already redirects to `/kanban` on success.

The frozen UI shows the Archive button unconditionally — the server-side gate is the source of truth.

### 2. Weekly auto-archive cron

#### 2a. Schedule

Add to `vercel.json`:

```json
{
  "path": "/api/cron/archive-done-tasks",
  "schedule": "0 4 * * 1"
}
```

**`0 4 * * 1` = 04:00 UTC every Monday** = **11:00 PM Sunday CDT** (UTC-5) / **10:00 PM Sunday CST**. Runs at the start of the work week so Monday morning the board is clean.

*Alternatives if Jacob prefers a different time:*
- `0 22 * * 5` — Friday 5 PM CDT (end of work week)
- `0 6 * * 6` — Saturday 1 AM CDT (mid-weekend)

#### 2b. Min-age safety threshold

Add a `MIN_AGE_HOURS = 24` filter to the cron's query so tasks marked done in the last 24 hours are spared. Prevents the scenario where a user marks a task done at 10:59 PM Sunday and it disappears at 11:00 PM.

New query:

```typescript
const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
const result = await KanbanTask.updateMany(
  { status: 'done', archived: false, statusChangedAt: { $lte: cutoff } },
  { $set: { archived: true, archivedAt: new Date() } }
);
```

Tasks with no `statusChangedAt` (legacy data) are excluded by this filter, which is the safe choice — they'll surface in the manual "Archive All Done Tasks" sweep.

#### 2c. Auth + method hardening

Update `/api/cron/archive-done-tasks/+server.ts` to match the pattern used by `daily-digest` and `cartridge-cleanup-reminder`:

- Export both `GET` and `POST`.
- Authenticate via the 3-mode pattern:
  1. `Authorization: Bearer ${env.CRON_SECRET}` (Vercel's standard cron-secret header)
  2. GET requests from `User-Agent: vercel-cron/*` (Vercel's actual cron caller)
  3. Fallback to `requireAgentApiKey(request)` for manual triggers / agent calls

This lets Vercel Cron actually invoke it, while preserving agent-API and manual-trigger access.

#### 2d. Audit logging

Keep the existing single AuditLog row per cron run (`recordId: 'cron-bulk'`, `changedBy: 'system-cron'`, `newData: { archived: true, count: N }`). Already idempotent — if zero tasks match, `count: 0` is logged.

## Decisions (confirmed 2026-05-15)

- **Schedule:** Sunday 11 PM CDT (`0 4 * * 1` UTC).
- **Min-age threshold:** 24 hours.
- **Per-task archive:** done-only. Non-done tasks get a 400 error.

## Acceptance criteria

1. **Per-task archive bug fixed.** Clicking "Archive Task" on `/kanban/task/[taskId]` when status is `done` archives the task, redirects to `/kanban`, and the task disappears from the active board. An `AuditLog` row and an `activityLog` entry are created. Clicking it when status is not `done` returns a 400 with `"Only done tasks can be archived"` and the task is unchanged.

2. **Cron route accepts Vercel Cron.** A GET request to `/api/cron/archive-done-tasks` with `User-Agent: vercel-cron/1.0` (no other auth) succeeds and returns `{ success: true, archivedCount: N }`.

3. **Cron route still accepts agent API key.** A POST with `x-agent-api-key` (existing behavior) succeeds.

4. **Min-age threshold works.** A task moved to `done` 1 hour ago is *not* archived by the cron. A task moved to `done` 25 hours ago *is* archived.

5. **Schedule wired.** `vercel.json` contains an entry for `/api/cron/archive-done-tasks`. On deploy, Vercel's cron dashboard shows the job.

6. **Idempotent.** Running the cron when zero tasks match returns `{ success: true, archivedCount: 0 }` and writes one AuditLog row.

7. **`npm run check` passes.** No new TypeScript errors.

## Files touched

| File | Change |
|------|--------|
| `src/routes/kanban/task/[taskId]/+page.server.ts` | Add `archive` action |
| `src/routes/api/cron/archive-done-tasks/+server.ts` | Add GET, multi-mode auth, min-age filter |
| `vercel.json` | Add cron schedule entry |
| `docs/prds/KANBAN-AUTO-ARCHIVE.md` | This document (new) |
| `progress.txt` | Append session entry (per Ralph protocol) |

## Risk / rollback

- **Schedule misfire** (timezone confusion): mitigated by the 24h min-age filter — even if the cron fires Friday instead of Sunday, it only touches tasks that have been done for a day.
- **Vercel cron silently broken on first deploy:** PRD acceptance criterion #2 is testable locally by curling `/api/cron/archive-done-tasks` with the vercel-cron UA. Production verification: check Vercel cron logs Monday AM after first deploy.
- **Rollback:** delete the entry from `vercel.json`. The endpoint stays functional for manual triggers.

## Not in scope for this PR (parking lot)

- Restoring an archived task (would need an unarchive action + UI affordance on `/kanban/archived`).
- Configurable schedule via UI (currently hard-coded in vercel.json).
- Per-project archive policies (some projects might want different retention).
- Email digest of "what was archived this week."
