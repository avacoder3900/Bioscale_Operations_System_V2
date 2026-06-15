# BACKINGLOT-LEGACY-RETIREMENT — retire the aggregate BackingLot going forward

**Date:** 2026-06-15 · **Owner:** Jacob · **Status:** Approved direction; **execution DEFERRED**
**Depends on:** legacy buckets draining (see gate below)

## Background

The original `BackingLot` model was an **aggregate bucket** (`cartridgeCount`, no
individual cartridges). WAX-FLOW-2 replaced it with per-cartridge `CartridgeRecord`
(`status:'backing'`) grouped by a `LotRecord` batch. **Nothing has written to
`BackingLot` since WAX-FLOW-2** — it is already abandoned on the write side.

Decision (2026-06-15): keep the *backing-lot concept* (the `LotRecord` batch — it
captures the group + per-cartridge scan time/operator) and **formally retire the
aggregate `BackingLot` model going forward**. Legacy cartridges keep their
historical buckets; we do not migrate them.

## Why this is DEFERRED (do not delete yet)

Undrained legacy buckets are still **read** in live code and still matter until the
last one is consumed at wax fill:

- `src/lib/server/services/equipment-status.ts:95,142` — undrained buckets still
  **lock ovens** / count toward oven occupancy.
- `src/lib/server/services/equipment-activity.ts:130` — legacy oven activity feed.
- `src/routes/+page.server.ts:209` — dashboard backing aggregate.
- `src/routes/manufacturing/cart-mfg/pipeline/+page.server.ts:139` — pipeline shows
  legacy buckets read-only until drained.
- `src/routes/manufacturing/cart-mfg-dev/+page.server.ts:50` — dev view.
- `src/lib/server/ask-bims.ts` — traceability joins.

Deleting the model/reads now would unlock ovens still physically holding legacy
cartridges and drop them from the pipeline.

## Retirement plan (execute when the gate is met)

**Gate:** `BackingLot.countDocuments({ status: { $in: ['in_oven','ready','created'] } }) === 0`
(no undrained buckets remain).

When the gate is met:
1. Remove the `BackingLot` reads in the files listed above (replace oven-lock /
   pipeline / dashboard logic with the `CartridgeRecord{status:'backing'}` +
   `LotRecord` equivalents already used alongside them).
2. Drop the `BackingLot` export from `models/index.ts` and delete `backing-lot.ts`.
3. Leave the legacy `cartridge-record.ts` `backing.lotId` field (historical lineage
   on old cartridges) — comment only, no migration.

## Acceptance (of this PRD, now)
- Direction documented; no code deleted. A future session checks the gate query and
  executes the plan. (Optionally `/schedule` a recheck once buckets are expected to
  be drained.)
