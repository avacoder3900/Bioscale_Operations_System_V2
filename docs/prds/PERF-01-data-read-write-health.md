# PERF-01 — Data Read/Write Health & Storage Efficiency

**Status:** In progress
**Created:** 2026-07-13
**Source:** `BIMS_ARCHITECTURE.md` → "Performance Audit" section (read-side + write-side code sweeps, 2026-07-13)
**Branch:** `perf/data-health-01`

## Problem

BIMS V2 is functionally healthy but has accumulating performance and correctness
debt in the data layer. All list/detail pages hit MongoDB Atlas from Vercel
serverless functions; several hot paths do full collection scans, transfer fat
documents (including inline CSV attachments) to render slim lists, and serialize
independent writes. Two latent bugs actively waste work or silently drop data.
Left alone, page loads degrade linearly as `spus`, `audit_log`,
`cartridge_records`, and `lab_cartridges` grow.

## Goals

1. Every hot-path query uses an index (no collection scans on growing collections).
2. Display queries transfer only the fields they render (never inline CSV content).
3. Form actions round-trip to Atlas the minimum number of serial times.
4. No lost-update races on concurrent mutations.
5. No silently-dropped writes (schema matches every write path).
6. Connection handling follows serverless best practice.

## Non-goals

- Re-platforming storage (Box/Mongo/inline split stays as-is; R2 is the CV clone's concern).
- Adding pagination UI to unbounded list pages (follow-up: PERF-02 candidate).
- Changing the audit-log/sacred/immutable middleware design.
- Real-time transport changes (polling → SSE/WebSocket is a separate frontend concern).

## Requirements

### R1 — P0 bug fixes (correctness + speed)

**R1.1** `src/routes/spu/[spuId]/+page.server.ts:23` — AuditLog history query must
filter `{ tableName: 'spus', recordId: params.spuId }` and sort `{ changedAt: -1 }`
(current code uses non-existent `entityId`/`createdAt`: full scan, empty result).
Verify the page's rendering of the returned history still matches the field names
it consumes.

**R1.2** `CartridgeRecord.phases` — audit every write to `phases` (e.g.
`src/routes/spu/shipping/+page.server.ts:187-193`), determine the intended shape,
declare the field in `src/lib/server/db/models/cartridge-record.ts` so strict mode
stops dropping the writes. Check live-data implications (writes to date have been
dropped — is a backfill needed?). If the writes were vestigial, remove them
instead; decision must be documented in the PR.

### R2 — Indexes

Add to model files (background builds on deploy):

| Collection | Index |
|---|---|
| `spus` | `{ createdAt: -1 }` |
| `test_results` | `{ status: 1, createdAt: -1 }`, `{ deviceId: 1 }`, `{ assayId: 1 }` |
| `inventory_transactions` | `{ partDefinitionId: 1, performedAt: -1 }`, `{ performedAt: -1 }` |
| `assembly_sessions` | `{ spuId: 1 }` |
| `electronic_signatures` | `{ entityType: 1, entityId: 1 }` |
| `lab_cartridges` | `{ status: 1 }`, `{ groupId: 1 }`, `{ createdAt: -1 }` |
| `cartridge_records` | `{ createdAt: -1 }` |

### R3 — Hot-path projections

**R3.1** `src/routes/spu/mfg/+page.server.ts:11` — `Spu.find()` must `.select()`
only the fields the page maps (~9 scalars + batch/customer snapshots); must
exclude `attachments`, `assembly`, `corrections`, `validation`, `statusTransitions`.

**R3.2** `src/routes/spu/batches/[batchId]/+page.server.ts:13` — same projection
treatment (6 fields used).

**R3.3** Rule for future code (add to CLAUDE.md): SPU display queries always
exclude `attachments.content`.

### R4 — Parallelize independent queries (reads)

- `src/routes/spu/+layout.server.ts:16,23` — two `Integration.findOne` →
  `Promise.all` (runs on every navigation in the app).
- `src/routes/kanban/+layout.server.ts:12-13` — projects + users → `Promise.all`;
  bound/project the `User.find({})`.
- `src/routes/spu/[spuId]/+page.server.ts:35,40,45` — three `User.find({$in})`
  lookups → single merged query or `Promise.all`.
- `src/routes/spu/assembly/[sessionId]/+page.server.ts:13,17,24` — spu + work
  instruction fetches parallel after session fetch.
- `src/routes/documents/[id]/+page.server.ts:7,13,20` — owner + creators parallel.
- `src/routes/kanban/task/[taskId]/+page.server.ts:14,17` — task + projects parallel.

### R5 — Parallelize independent writes (push)

Where writes share no data dependency (IDs are pre-generated nanoids), batch with
`Promise.all`. Preserve ordering only where a later write reads an earlier result.

- `src/routes/spu/receiving/new/+page.server.ts` — 6–8 serialized writes; group
  independent creates/updates (tool confirmations, inspection results,
  transactions, audit logs) after the primary `ReceivingLot.create`.
- `src/routes/spu/validation/magnetometer/+page.server.ts:76,95,111` — session
  create + SPU update + audit log → `Promise.all`.
- `src/routes/spu/shipping/+page.server.ts:182,187` — package + cartridge updates.
- Do NOT blanket-change all 50+ `AuditLog.create` sites in this PRD — apply the
  pattern to the listed hot actions; wider rollout is mechanical follow-up.

### R6 — Cartridge mutation race fix

`src/routes/spu/cartridges/+page.server.ts:104-116` (updateStatus) and `:130-142`
(changeGroup): replace findById → mutate → `save()` with atomic
`updateOne({ $set: {...}, $push: { usageLog: { $each: [entry], $slice: -200 } } })`.
The `$slice` cap bounds `usageLog[]` (the only unbounded embedded array), matching
the existing `recentTransactions` house pattern. Confirm no reader needs usage
history beyond the cap before applying the slice (if unclear, apply $set/$push fix
without the cap and flag the cap decision).

### R7 — Serverless connection hardening

`src/lib/server/db/connection.ts`: cache the in-flight connect **promise** on
`globalThis` (standard Vercel/Mongoose pattern) so concurrent cold-start requests
share one connect; set `minPoolSize: 0`. Keep existing timeouts.

### R8 — Payload/packaging cleanup (lower priority)

**R8.1** `src/routes/spu/test-results/[resultId]/+page.server.ts:39-57` — assess
readings[] payload (16 fields × up to thousands). Only change if it does not alter
what the operator can see (QC context); otherwise document recommendation.

**R8.2** Redundant `JSON.parse(JSON.stringify())` on `.lean()` results (10 sites) —
optional cleanup; if removed, verify SvelteKit devalue handles the shapes (Dates
fine) and update the CLAUDE.md serialization guidance to match.

## Acceptance criteria

- [ ] SPU detail page renders audit history entries (was empty) with no
      collection scan (query uses `{tableName, recordId}` index).
- [ ] `phases` writes persist (or are removed as vestigial, with rationale).
- [ ] All R2 indexes declared in model files.
- [ ] `spu/mfg` load no longer transfers `attachments.content` (verify via
      projection in code).
- [ ] R4/R5 listed sites use `Promise.all` where independent.
- [ ] Cartridge updateStatus/changeGroup use atomic operators (no `.save()`).
- [ ] `connectDB()` caches a promise on `globalThis`; `minPoolSize: 0`.
- [ ] `npm run check` introduces no NEW errors (baseline: 834 pre-existing from
      copied UI layer).
- [ ] `npm run build` passes.
- [ ] Contract tests (84) pass against a running app — deferred to manual/CI step
      if no local instance available.

## Risks

- **R1.2 backfill**: dropped `phases` writes mean historical cartridges lack phase
  entries — fixing the schema fixes future writes only.
- **Index builds** on large collections briefly load Atlas (background builds; low risk).
- **Promise.all write groups**: on partial failure, some writes land without
  others — no transactions today anyway (same exposure as current serial code,
  which also has no rollback), but keep the primary record's create awaited first
  where downstream UX depends on it.
- Home-root clone has no `node_modules` — validation requires `npm install` first.
