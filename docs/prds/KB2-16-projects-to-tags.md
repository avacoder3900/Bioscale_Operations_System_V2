# KB2-16 — Projects → tags; one board; one flat ranked inventory

**Decided:** 2026-08-16 (Jacob, in-session). Supersedes KB2-00 decisions **#8** (software
board) and **#10** (projects stay a separate collection). Rationale: "projects are too
one-dimensional — tasks + tags accomplish the exact same thing"; a tag system is more robust
than a board discriminator; inventory should be **one solid iterable list** with an order the
operator applies directly.

## Decisions

1. **Projects are removed as a concept.** Tasks carry tags only. Every existing project
   assignment converts to a tag bearing the project's name (verbatim string — tags are already
   plain strings, `kanbanTaskSchema.tags: [String]`, indexed).
2. **The software board is removed.** `board: 'software'` tasks get a `software` tag. One
   board, one policy block, one global ready queue. The `review` status stays available to all
   work (already in the shared status vocabulary).
3. **Tier 1 rank scope becomes global.** Was `(board, project)`; becomes one strict-ordinal
   list across all of Tier 1. Tier 2 rank was per-board global; becomes global.
4. **Inventory page:** one flat ranked list (no project grouping). Existing ▲▼ rerank arrows
   move items in the single global order. **Tag filter** added (multi-select; a task matches if
   it has any selected tag) alongside the existing status/type/origin filters. Capture form's
   project select is replaced by an optional comma-separated tags input.
5. **Projects page deleted** (`/kanban/projects`), along with the project ui-state API
   (`/api/kanban/projects/[id]/ui-state`) and the Projects nav link.
6. **Board toggle scrubbed everywhere** (nav, queue, flow, policy, MCP).
7. **Flow page:** per-project table becomes per-tag table (same computations, grouped by tag;
   a task with N tags counts toward N rows; untagged rows group as "untagged").
8. **Templates:** `defaultProjectId` replaced by the project's name appended to the template's
   `tags` (migration does this data-side; code reads tags only).
9. **KanbanProject collection is left in place as dead data** (zero-risk archaeology); all code
   referencing the model is removed. Same for the task `project` subdoc and `board` field after
   migration: schema fields dropped from the model, data cleaned by the migration script.
10. **KanbanPolicy:** `boards.ops` / `boards.software` collapse to a single top-level policy
    block seeded from the `ops` values. `wipPerPerson` unchanged (was already cross-board).

## Migration (script, run deliberately — ALL_TO_TIER1 precedent)

One idempotent script, dry-run mode default:

1. For every task with `project._id`: `$addToSet` tag = project name; `$unset` project.
2. For every task with `board: 'software'`: `$addToSet` tag `software`. `$unset board` on all.
3. Re-rank Tier 1 globally: order by (project sortOrder, then old rank) → sequential ranks.
   Re-rank Tier 2 globally: ops queue first, then software, preserving intra-board order.
4. Policy doc: copy `boards.ops` values to the new single block; drop `boards`.
5. Templates: fold `defaultProjectId`'s project name into `tags`; unset the field.
6. `kanban_projects` collection untouched (dead).
7. Indexes: drop `{board, status, rank}` and `{board, project._id, status, rank}`; add
   `{status, rank}`.

## Out of scope

- The strategy layer (KB2-17 note) — tags become its join point later.
- Tag colors / tag management UI. Tags remain plain strings.
- Any change to Tier 2 flow semantics, DoR, spikes, standing work, or supply loops.

## Blast radius (audited 2026-08-16)

Server: `transition.ts`, `replenish.ts`, `process.ts`, `queue.ts`, `policy.ts`, `wip-limit.ts`,
`flow-history.ts`, `flow-metrics.ts`, `wip-timeline.ts`, `standing.ts`, `bims-mcp.ts` (kanban
tools lose board/project params), models `kanban-task`, `kanban-policy`, `kanban-template`,
`kanban-project` (deleted from exports). Routes: kanban layout/queue/inventory/flow/policy/
archived/task pages, projects pages (deleted), project ui-state API (deleted), move API.
Components: `KanbanNav`, `PerProjectTable` (→ per-tag), `WipTimelineWidget`, `CycleScatterChart`,
task detail. Breaking for any MCP/agent caller passing `board`/`projectId` — flag to Alejandro.
