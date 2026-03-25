# SEC-02 — Kanban Permission Enforcement

## Overview
**Domain:** Security — Kanban routes
**Dependencies:** SEC-01
**Files:** 4 page server files + 1 API endpoint

The kanban layout (`kanban/+layout.server.ts`) correctly checks `kanban:read`, so page loads are gated. But individual page loads don't recheck, and no mutation action checks `kanban:write`. Any user with `kanban:read` can create, edit, delete, and move tasks.

---

## Story SEC-02-01: Add requirePermission to Kanban Page Loads

### Files to Change
1. `src/routes/kanban/+page.server.ts` — add `requirePermission(locals.user, 'kanban:read')` to load
2. `src/routes/kanban/list/+page.server.ts` — same
3. `src/routes/kanban/archived/+page.server.ts` — same
4. `src/routes/kanban/task/[taskId]/+page.server.ts` — same
5. `src/routes/kanban/projects/+page.server.ts` — same

### Notes
The layout already checks `kanban:read`, so these are defense-in-depth. SvelteKit guarantees layouts run before pages, but explicit checks per-page is the project standard and prevents bugs if routes are reorganized.

### Acceptance Criteria
- Each kanban page server file has `requirePermission(locals.user, 'kanban:read')` in its load function

---

## Story SEC-02-02: Add kanban:write to Mutation Actions

### Files to Change
1. `src/routes/kanban/+page.server.ts` — all form actions (create task, etc.)
2. `src/routes/kanban/archived/+page.server.ts` — unarchive action
3. `src/routes/kanban/task/[taskId]/+page.server.ts` — update, delete, comment, tag, proposal actions
4. `src/routes/kanban/projects/+page.server.ts` — create, update, delete project actions
5. `src/routes/api/kanban/move/+server.ts` — POST handler (drag-and-drop move)

### What to Change
Add `requirePermission(locals.user, 'kanban:write')` at the top of each action/handler.

For the API endpoint, add both auth check (`if (!locals.user)`) and `requirePermission(locals.user, 'kanban:write')`.

### Acceptance Criteria
- A user with `kanban:read` but NOT `kanban:write` can view boards but gets 403 on any mutation
- A user with both `kanban:read` and `kanban:write` can view and mutate normally
