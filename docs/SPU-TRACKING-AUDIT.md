# SPU Tracking & Inventory Audit

**Date:** 2026-04-16
**Scope:** How SPUs move through the system, and how inventory changes are tracked.
**Goal:** Plain-language picture of what we have, what's weak, and what to fix first.

---

## TL;DR

The SPU tracking *model* is solid — we have detailed records per SPU, per part, per validation test, and an immutable state history. The *plumbing around it* is the weak spot: some parts of the app update inventory counts without logging anything, there's no automatic check that our numbers add up, and partial-consumption tracking on wax lots has a race condition that can silently lose data.

**Five things to fix, in order of bang-for-buck:**

1. Make every inventory change go through one service (atomic update + audit log).
2. Add an hourly job that checks if our numbers still add up.
3. Log every change to `PartDefinition` into `AuditLog`.
4. Replace the single `consumedUl` field on lots with a real ledger.
5. Put all status enums in one file and validate transitions.

---

## 1. What "SPU Tracking" Looks Like Today

### The SPU record

Every SPU has:

- A unique ID (nanoid) and a UDI (Unique Device Identifier)
- A barcode
- A **status** — one of 11 states: `draft → assembling → assembled → validating → validated → released-rnd / released-manufacturing / released-field → deployed → servicing → retired → voided`
- A **parts array** — every scanned part, with lot number, serial number, timestamp, and operator
- An **assembly section** — which session built it, which steps were completed, which fields were captured
- A **validation section** — magnetometer, thermocouple, lux, and spectrophotometer results with pass/fail/pending state
- A **`statusTransitions` array** — an append-only history of every status change with operator, time, and reason

*Model file:* `src/lib/server/db/models/spu.ts`

### How an SPU moves through the system

- Operators work through `/assembly/[sessionId]` scanning parts and filling in step fields.
- Validation happens at `/validation/magnetometer`, `/validation/thermocouple`, etc.
- Detail pages at `/spu/[spuId]` pull it all together.

Each transition writes to `statusTransitions` and (usually) to `AuditLog`.

### Related records

- **`AssemblySession`** — the work in progress. Has its own small status enum (`in_progress / paused / completed`).
- **`ValidationSession`** — each validation run. Status enum: `pending / in_progress / running / completed / failed / timed_out`.
- **`PartDefinition.inventoryCount`** — the live part-count number the UI shows.
- **`ReceivingLot`** — a physical lot of received parts. Has a `quantity` (whole items) and a `consumedUl` (partial consumption, for wax lots).

---

## 2. Where the Tracking Gets Weak

### 🟥 Inventory can drift without anyone noticing

Some routes update `PartDefinition.inventoryCount` directly and *then* write an `InventoryTransaction` record.

**The problem:** If the second write fails (network blip, crash, timeout), the live count goes down but the history doesn't record why. Over months this silently accumulates.

**Where it happens:**
- `src/routes/assembly/[sessionId]/+page.server.ts:230-231` — part scan during assembly
- `src/routes/assembly/[sessionId]/+page.server.ts:257` — scan retraction
- `src/routes/parts/accession/+page.server.ts:306` — quick-scan accession

**Why it matters:** The live count is what we trust for reorder alerts and "do we have enough to build X?" questions. If the ledger drifts, we'll make bad decisions based on bad numbers.

### 🟥 No one is checking if the numbers add up

There is **no reconciliation job** anywhere in the codebase. Nothing compares `sum(InventoryTransaction.quantity)` to `PartDefinition.inventoryCount`.

**Why it matters:** If a drift from the bug above happens today, we won't find out until someone does a physical count — possibly months later.

### 🟨 Wax lot partial consumption can lose data

When an operator does a wax fill, we read `ReceivingLot.consumedUl`, add 800 μL, and write it back.

**The problem:** If two operators run fills at the same moment on the same lot, the second write overwrites the first. One fill's worth of wax "disappears" from the record.

**Where it happens:** `src/routes/manufacturing/wax-filling/+page.server.ts` (~line 160)

**Why it matters:** The validator will report the wrong remaining volume; eventually a lot reads as "full" when it's actually depleted (or vice versa).

### 🟨 Bad barcode scans vanish

If an operator scans a barcode that doesn't match any known part, the system silently stores a record with a null `partDefinitionId` and no error surfaces anywhere.

**Where it happens:** `src/routes/assembly/[sessionId]/+page.server.ts:202-234`

**Why it matters:** Operator mistakes or damaged barcodes are invisible. We can't tell good SPUs from ones built with garbage scans.

### 🟨 Status enums are scattered

`SPU` has 11 statuses. `AssemblySession` has 3. `ValidationSession` has 6. `ReceivingLot` has 5. Every enum lives in its own model file; no central constants file.

**Why it matters:** When we add a new state, we have to hunt across the codebase. And the two "completed" concepts (`SPU.status = assembled` vs. `AssemblySession.status = completed`) can fall out of sync — we read them both independently on the detail page.

### 🟨 Mutations that skip `AuditLog`

We have a well-designed `AuditLog` model (with `oldData` / `newData` capture). It's used in ~175 places. But direct `PartDefinition.updateOne` calls (assembly, accession) don't write to it.

**Why it matters:** We can't answer "who changed this part count on Tuesday?" for the paths that skip audit logging.

---

## 3. How We Track Changes & Inventory Today

Here's what's happening in the code, in plain terms:

### `AuditLog`

- **What it is:** An append-only log of every (most) write. Fields: table name, record ID, INSERT/UPDATE/DELETE action, old data, new data, who, when, why.
- **Coverage:** Good for manufacturing workflows. Weak for assembly and parts accession.
- **Works correctly?** Where it's called, yes. It's immutable — nothing can edit it.

### `InventoryTransaction`

- **What it is:** An append-only ledger of every inventory movement (receipt, consumption, scrap, adjustment, etc.).
- **Should be the single source of truth.** Today it's not — the live number lives on `PartDefinition.inventoryCount`, and they can diverge.
- **Worked correctly?** Manufacturing routes (wax, reagent, laser, QA/QC) use the `recordTransaction` service. Assembly and parts accession skip it and do their own `updateOne` + manual create.

### `recordTransaction` service

- Defined in `src/lib/server/services/inventory-transaction.ts`.
- Does two things in sequence: update `PartDefinition.inventoryCount`, then insert an `InventoryTransaction`. **These two writes are not wrapped in a Mongo transaction**, so either one can succeed without the other.
- Fires low-inventory notifications on threshold crossings. Nice feature, but it's tied to the (possibly drifted) live count.

### Per-lot partial consumption

- Only `ReceivingLot.consumedUl` tracks partial wax draws (wax-filling workflow, 800 μL per cartridge).
- No ledger for per-fill events — just a running total on the lot.
- As noted above, it's race-prone.

### Invalid scans

- Not logged anywhere.

### Reconciliation

- Doesn't exist.

---

## 4. Top 5 Fixes, Ranked

| # | Fix | Impact | Effort | What it buys us |
|---|-----|--------|--------|-----------------|
| 1 | **Atomic inventory service** — wrap count update + transaction insert in a single Mongo session so either both land or neither does. Replace all ad-hoc `updateOne` calls. | High | Medium | Eliminates the silent-drift bug at its root. |
| 2 | **Hourly reconciliation cron** — sum `InventoryTransaction` per part, compare to `PartDefinition.inventoryCount`, write any mismatch to a new `InventoryDrift` collection + alert. | High | Low | Catches drift within an hour instead of months. |
| 3 | **Audit-log every `PartDefinition` mutation** — wrap each direct `updateOne` with an `AuditLog.create` capturing old/new values. | Medium | Low | Restores the "who changed what" answer for currently-silent paths. |
| 4 | **`LotConsumption` ledger** — replace `ReceivingLot.consumedUl` with a collection where each draw is its own document (lot ID, time, operator, μL, purpose). Remaining = initial − sum(ledger). | Medium | Medium | Kills the race condition, gives real traceability per fill. |
| 5 | **Central status-enum constants + `isValidTransition()` guard** — one file holds the enums; a helper validates every status change before it's written. | Medium | Medium | No more enum drift; orphaned states become impossible. |

---

## 5. Recommended First Move

Fixes **#1 + #2 together** are the best next step:

- #1 alone stops *new* drift.
- #2 alone can't stop drift but surfaces whatever already exists.
- Together, we stop the bleeding **and** clean up history.

Rough estimate: 1-2 days of work, isolated to two new files (`src/lib/server/services/inventory-transaction.ts` rewrite + `src/routes/api/cron/reconcile-inventory/+server.ts`) plus a handful of edits to the routes that bypass the service today. No UI changes required.
