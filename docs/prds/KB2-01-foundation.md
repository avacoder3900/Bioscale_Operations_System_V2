# KB2-01 — Foundation: Status Module, Transition Service, Schema + Migration

**Depends on:** nothing. **Everything else depends on this.**
Read `KB2-00-OVERVIEW.md` first.

## Why

Status vocabulary is hardcoded in ~14 places (two conflicting column lists); "move a task" is
implemented 4 separate times with different side effects (only the agent path stamps flow
timestamps); `blocked` is advertised by APIs but rejected by the schema; 3 live tasks hold rogue
statuses. Nothing in KB2-02+ is enforceable until status knowledge and transitions live in exactly
one place each.

## 1. Shared status module — `src/lib/shared/kanban-status.ts`

Client-safe (no server imports). Exports:

```ts
export const TIER1_STATUSES = ['captured', 'processed', 'icebox', 'declined'] as const;
export const TIER2_STATUSES = ['ready', 'wip', 'waiting', 'blocked', 'review', 'done'] as const;
export const ALL_STATUSES = [...TIER1_STATUSES, ...TIER2_STATUSES] as const;
export type KanbanStatus = (typeof ALL_STATUSES)[number];

export function tierOf(status: KanbanStatus): 1 | 2;            // derived, never stored
export function isTierCrossing(from: KanbanStatus, to: KanbanStatus): boolean;

export const BOARDS = ['ops', 'software'] as const;
export type KanbanBoard = (typeof BOARDS)[number];
// review is legal only on the software board:
export function legalStatusesFor(board: KanbanBoard): readonly KanbanStatus[];

export const STATUS_META: Record<KanbanStatus, { label: string; color: string; tier: 1 | 2 }>;
// aging thresholds per status (replaces src/lib/shared/kanban-aging.ts contents + the duplicate
// copy in KanbanTaskCard.svelte — both refactored to import from here)
export const AGING_THRESHOLDS: ...;

export const ITEM_TYPES = ['deliverable', 'spike', 'chore'] as const;
export const CLASSES_OF_SERVICE = ['standard', 'fixed_date', 'chore', 'expedite'] as const;
export const SIZE_CLASSES = ['short', 'medium', 'long'] as const;
export const ORIGINS = ['planned', 'discovered'] as const;
```

Every consumer of status strings is refactored to import from this module: model enum, board page
columns, task-detail flow map, list-view statusOrder, TaskStatusBadge, board-snapshot COLUMNS,
agent dashboard/projects/alerts count buckets, analytics STATUS_COLORS + CFD keys, MCP zod enums,
aging thresholds. Grep acceptance: no string literal `'backlog'` remains in `src/` (the status is
gone), and `'wip'`/`'ready'`/etc. appear in `src/lib` only inside this module (route handlers may
reference exported constants).

## 2. Transition service — `src/lib/server/kanban/transition.ts`

The ONLY code allowed to write `task.status`. Signature (shape, not gospel):

```ts
export type TransitionActor = { username: string; via: 'ui' | 'mcp' | 'agent-api' | 'system' };

export async function transitionTask(opts: {
  taskId: string;
  to: KanbanStatus;
  actor: TransitionActor;               // REQUIRED — equal capture for humans and Claude
  reason?: string;                      // required for → blocked
  waitingOn?: string; waitingUntil?: Date;  // required for → waiting (named dependency + date)
  allowTierCrossing?: boolean;          // ONLY the replenish/demote endpoints pass true (KB2-02)
  session?: ClientSession;
}): Promise<TransitionResult>;
```

Behavior (single implementation of everything that is copy-pasted today):

1. **Legality**: `to` must be in `legalStatusesFor(task.board)`. Tier crossing without
   `allowTierCrossing` → typed error `TIER_CROSSING_FORBIDDEN` whose message names the
   replenishment path (spec's #1 invariant).
2. **Guards**: WIP limit on `→ wip` (per person, across BOTH boards, from policy — closes the
   agent-path bypass); `reason` required on `→ blocked`; `waitingOn` + date on `→ waiting`.
3. **Stamping**: `statusChangedAt`, per-status date field (`readyDate`, `wipDate`, `waitingDate`,
   `blockedDate` (new), `reviewDate` (new), `completedDate`), `committedAt` on first entry to
   Tier 2.
4. **Records**: pushes `transitions[]` `{fromStatus, toStatus, actor: {username, via}, reason?,
   timestamp}` (subdoc gains `via` + `reason`); pushes `activityLog` entry; writes `AuditLog`
   (every transition, not just agent ones).
5. Returns the updated task + what was stamped, for callers to serialize.

All four existing write paths are rewired to call it (board `move` action, `POST /api/kanban/move`,
task-detail `move`, agent `PATCH tasks/[id]`), plus merge (its forced `done`) and any create path
that sets a non-default initial status. Handler-local status logic is deleted.

A sibling `createKanbanItem()` helper standardizes creation: default `status:'captured'`,
`origin`, `spawnedFrom`, board, initial rank (appended to bottom of its Tier 1 project scope),
activityLog + AuditLog. All create paths (UI action, agent POST, subtasks) call it.

## 3. Schema changes — `kanban-task.ts`

```ts
status:  { type: String, enum: ALL_STATUSES, default: 'captured' },
board:   { type: String, enum: BOARDS, default: 'ops', index: true },
rank:    { type: Number, default: 0 },        // strict ordinal; scope = (tier1: board+project) | (tier2: board)
itemType:{ type: String, enum: ITEM_TYPES, default: 'deliverable' },
classOfService: { type: String, enum: CLASSES_OF_SERVICE, default: 'standard' },
sizeClass: { type: String, enum: SIZE_CLASSES },   // REPLACES taskLength (renamed; set at processing, KB2-03)
origin:  { type: String, enum: ORIGINS, default: 'planned' },
spawnedFrom: String,                           // taskId that was in wip when this was captured
committedAt: Date,                             // first Tier-2 entry; stamped by transition service
blockedDate: Date, reviewDate: Date,           // new per-status stamps
blockedReason: String,
dor: {                                         // Definition of Ready (KB2-03 populates/enforces)
  outcome: String,                             // outcome statement, not steps
  acceptanceCriteria: String,
  handoffBrief: String                         // software board: the coding-agent brief (KB2-08)
},
spike: {                                       // KB2-07
  question: String,
  timebox: { amount: Number, unit: { type: String, enum: ['hours', 'days'] } },
  outcome: String
},
replenishment: { eventId: String, promotedBy: String, promotedAt: Date },  // last crossing (KB2-02)
```

**Removed:** `prioritized` (deleted outright — decision #2), `sortOrder` (never adopted; rank
replaces it), `taskLength` (renamed to `sizeClass`; migration copies values). `transitions[]`
subdoc gains `via: String` and `reason: String`; `changedBy` stays for back-compat reads.

New/changed indexes: `{board, status, rank}`, `{board, 'project._id', status, rank}`,
`{spawnedFrom}`, keep `{archived, archivedAt}`, `{assignee._id, status}`, `{parentTaskId}`,
`{tags}`. Drop `{status, sortOrder}`.

## 4. Migration — `scripts/migrate-kanban-two-tier.ts`

Re-runnable (idempotent), dry-run by default, `APPLY=1` to write. Steps:

1. `backlog` → `captured`. Rogue `todo` (2 docs) → `captured`; `in_progress` (1 doc) → `wip`.
2. All docs: `board:'ops'`, `itemType:'deliverable'`, `classOfService:'standard'`,
   `origin:'planned'`, `sizeClass = taskLength ?? 'medium'`.
3. `committedAt` backfill for current Tier 2 (`ready|wip|waiting|done` incl. archived):
   `readyDate ?? wipDate ?? statusChangedAt ?? createdAt`.
4. **Rank backfill** — Tier 2 global (per board): order by `status` weight (wip, waiting, ready)
   then `prioritized desc` then `createdAt asc` → rank 1..N. Tier 1 per project:
   `prioritized desc, createdAt asc` → 1..N. Archived/done get rank 0 (unranked).
5. `$unset prioritized, sortOrder, taskLength` after copying.
6. Report: counts per step, before/after status histogram, any doc it couldn't classify.

Run against Atlas ONLY after KB2-01 code is deployed (enum must accept new values first —
deploy order: code, then migration).

## 5. Blast-radius updates in this PRD (keep the app working, not yet the new UX)

- Board page: `backlog` column becomes `captured` (label "Captured"); add `blocked` column;
  board still per-project until KB2-06 replaces it. Buttons may still be the old arrows here —
  full button UX lands in KB2-06.
- list view / task detail / badges / analytics / agent dashboards / board-snapshot / MCP enums:
  compile against the status module; new statuses render with labels/colors; analytics treats
  `captured|processed|icebox|declined` as upstream (excluded from cycle time; CFD gains bands).
- Archive cron: unchanged (`done` only) — `declined` archival is KB2-02+ policy work.
- `docs/MCP-SERVER.md` + MCP tool enums updated (tool behavior changes land in KB2-09).

## Acceptance criteria

- [ ] No status string literals outside `kanban-status.ts` (grep-verified as defined in §1).
- [ ] Every path that changes status routes through `transitionTask()` — verified by grepping for
      direct `status:` writes to KanbanTask outside the service.
- [ ] A human UI move now stamps the same fields as an agent move (`transitions[]` entry with
      actor + via, per-status date, AuditLog row).
- [ ] `→ blocked` without reason is rejected; `→ waiting` without `waitingOn` is rejected.
- [ ] `wip` beyond the per-person limit is rejected on EVERY path including agent PATCH.
- [ ] Tier 1 → Tier 2 via any normal update path returns `TIER_CROSSING_FORBIDDEN` naming
      the replenishment path.
- [ ] Migration dry-run reports cleanly on prod data; post-apply histogram shows zero
      `backlog|todo|in_progress` and no doc without `board`/`rank`/`committedAt`-where-due.
- [ ] `npm run check` error count ≤ current baseline; contract tests for kanban endpoints pass.
