# Bucket System Plan — Pre-Serialization WIP Tracking

**Date:** 2026-09-21
**Branch:** NEWDEV
**Status:** Design complete. Implementation not started.
**Scope:** A barcode-tracked container system for counting cartridges through the four
production stages that happen *before* a cartridge has a barcode and therefore before a
`CartridgeRecord` exists. Plus a stage-count strip on the cartridge-admin dashboard.

Read this end-to-end before touching code.

---

## 1. The gap this fills

Today, everything upstream of WI-01 is a **scalar**, not a container. Pre-barcode material
exists only as `PartDefinition.inventoryCount` numbers:

- `PT-CT-104` Cartridge (raw blanks) — received via `ReceivingLot`
- `PT-CT-101` Thermoseal roll → `PT-CT-111` cut sheets → `PT-CT-112` laser-cut sheets
- `PT-CT-106` Barcodes — minted as UUIDv4, printed 80/sheet at `/manufacturing/print-barcodes`

Serialization starts at WI-01 (`src/routes/manufacturing/cart-mfg/wi-01/+page.server.ts`),
which consumes 1×104 + 1×112 + 1×106 per cartridge and creates one `CartridgeRecord` per
scanned barcode. A cartridge does not exist as a record until a barcode is stuck on it.

So there is no way to answer "how many cartridges are pressed right now," "where is that batch
of 100," or "we started with 100 and got 97 — where did 3 go." This plan makes those queries
answerable.

### 1.1 The dead ancestor

`src/lib/server/db/models/backing-lot.ts` is a bucket: scanned barcode as `_id`, a
`cartridgeCount`, status machine `created → in_oven → ready → consumed`. It is legacy, not
written since WAX-FLOW-2, and `pipeline/+page.server.ts` still renders it read-only "until
drained." `LotRecord.bucketBarcode` exists and is unused.

**BackingLot's fatal flaw was barcode-as-primary-key** — one barcode, one lifetime, forever.
That is precisely what this system must not do (see §3.2). Do not revive BackingLot. Build
fresh and let the legacy rows drain.

---

## 2. The four stages

| Stage | Meaning |
|---|---|
| `raw` | Raw cartridge blanks (PT-CT-104) counted into a bucket |
| `unpressed` | Staged for the press |
| `pressed` | Off the press |
| `qr_pending` | **Barcode stickers applied**, awaiting WI-01 scan-in |

`qr_pending` means labels are physically ON the cartridges. The bucket holds known-but-
unregistered barcodes; WI-01 scans each one to create the `CartridgeRecord`.

### 2.1 Pressing — no SOP exists

There is **no written SOP or work instruction for pressing anywhere in the repo** (searched
`docs/`, `protocols/`, `data/`, root `*.md`). The equipment is real and registered:

```
E-45  Press 1  Bench  B-06  Manufacturing
E-46  Press 2  Bench  B-06  Manufacturing   (VEVOR clamshell heat press)
```

— `data/equipment-datasheets/BT.csv` lines 52–53

The `unpressed` / `pressed` vocabulary in this plan is therefore **invented by this document**.
Before build, confirm with operators that these names match what they say on the floor. If a
paper SOP surfaces later, match its step names rather than keeping these.

**Press capture was removed at the user's request (2026-09-21).** `unpressed → pressed` is a
plain stage move: no press prompt, no `pressEquipment*` fields. If per-press traceability is
ever wanted, this transition is where it would attach (mirroring `backing.ovenLocationId`),
and the two presses are already in the equipment datasheet.

---

## 3. Locked decisions

### 3.1 Whole-bucket advancement only

A bucket advances between stages as a unit. The count is set at creation and does not move
between stages in pieces. A bucket is therefore the unit of work for every stage, and bucket
size should be chosen to match what the press handles in one run.

Quantity still changes *within* a stage, via two actions that preserve the invariant:

- **Scrap** — units lost. Reason required. Inventory written down.
- **Adjust** — physical recount disagrees with the record. Reason required. Flagged in the
  ledger as a correction, not a loss.

**One exception: partial consumption is allowed, partial advancement is not.** WI-01 may
serialize 40 out of a 100-cartridge bucket; the bucket stays open at `qr_pending` with
`quantity: 60`. The remaining 60 never changed stage, so the invariant holds. The cycle closes
when it reaches zero. Without this, an operator running a short shift would be blocked.

### 3.2 Buckets and their lot numbers are reusable

The barcode identifies the **physical tub**, not the batch. A bucket is used, drained, and
refilled indefinitely. This requires splitting container from contents (§4).

**The label an operator sees and scans is always bare `BKT-000123`,** on the shop floor, in the
scan box, on the bucket page. Suffixes never get typed or scanned.

**Known tradeoff, accepted:** reused lot numbers make history ambiguous — "lot BKT-000123"
could be March's pass or June's. Mitigated, not eliminated, by:

- `CartridgeRecord` binds to the **cycle id**, never the bare barcode.
- Completed passes are displayed as `BKT-000123 #7` in history and DHR views only.
- Searching `BKT-000123` returns every pass that bucket has ever produced, grouped.

If an auditor ever requires globally unique upstream lot numbers, the cycle id is already the
unique key — only the display layer would change.

### 3.3 Buckets are the source of truth; part counts stay in sync

Bucket sum per stage is authoritative. Each transition writes an `InventoryTransaction` via the
existing `recordTransaction` service so `PT-CT-104` / `PT-CT-106` counts, the inventory pages,
and low-stock alerts keep working untouched. If the two ever disagree, the bucket ledger wins
and the drift is a visible bug.

### 3.4 Thermoseal is out of scope

**Do not touch `PT-CT-112` or any thermoseal count in this work.** The `unpressed → pressed`
transition debits nothing. Whether thermoseal bonds at the press or at WI-01 is deliberately
left unanswered; WI-01 continues to debit `PT-CT-112` exactly as it does today.

### 3.5 Auto-release with deferred spot-check

When a cycle reaches zero it closes and the bucket returns to `available` **immediately** —
nobody waits. The bucket is marked `spotCheckPending`.

The next **Start new cycle** on that bucket shows a one-tap *Confirmed empty* acknowledgement
before the quantity field. It records `emptyConfirmedBy/At`, clears the flag, and never blocks.
The check lands at the one moment someone is physically holding the tub and looking into it.

No cleaning record, no `needs_cleaning` state. The tubs hold dry components; visual empty check
is sufficient.

### 3.6 Residual disposition — free text, no approval

If the operator answers **No** to *Is the tub empty?*, they disposition the leftovers (§7).

- Journal entry is **required free text**. No reason-code dropdown.
- **No approval step at any quantity.** The journal is the control.

### 3.7 Residual reporting is available anytime

"Report contents" is an action on **any bucket card**, not only the spot-check branch. A tub
found on a shelf with material in it and no cycle attached is how leftovers actually get
discovered.

---

## 4. Data model

Three new models. Container and contents are separate records — this is what makes reuse work.

### 4.1 `ProductionBucket` → `production_buckets`

The physical tub. One row per bucket owned. Permanent.

```ts
_id              String    // 'BKT-000123' — the barcode IS the id, permanently
state            String    // 'available' | 'in_use' | 'quarantined' | 'retired'
currentCycleId   String    // → BucketCycle._id, or null
cycleCount       Number    // monotonic, $inc on cycle open
homeLocation     String    // shelf label or Equipment._id
spotCheckPending Boolean   // set on auto-release, cleared at next cycle start
residualNote     String    // set when quarantined with undispositioned contents
retiredAt        Date
retiredReason    String
```

`retired` matters: tubs crack. Retiring kills the barcode permanently so a reprinted duplicate
label cannot resurrect it.

### 4.2 `BucketCycle` → `bucket_cycles`

One pass of material through the stages. `_id` is a nanoid, so every pass is permanent and
unambiguous even though the barcode repeats.

```ts
_id                String   // nanoid
bucketId           String   // → ProductionBucket._id ('BKT-000123')
cycleNumber        Number   // 7  → displays as 'BKT-000123 #7'
stage              String   // 'raw' | 'unpressed' | 'pressed' | 'qr_pending'
quantity           Number   // current count
openedQty          Number   // count at creation (shrinkage visible by diff)
sourceLots         [{ partNumber, lotId, scannedAt, _id: false }]
pressEquipmentId   String   // Equipment._id, set at unpressed → pressed
pressEquipmentName String   // denormalized for display
status             String   // 'open' | 'consumed' | 'scrapped'
emptyConfirmedBy   { _id, username }
emptyConfirmedAt   Date
closedWithResidual Boolean  // residual found after close — count accuracy signal
residualFound      [{ _id: false, qty, stage, disposition, at, by }]
openedAt           Date
closedAt           Date
```

**Indexes:**

```ts
{ bucketId: 1 }, { unique: true, partialFilterExpression: { status: 'open' } }
{ stage: 1, status: 1 }
{ bucketId: 1, cycleNumber: -1 }
```

The partial unique index is the DB-level guarantee that a bucket holds **at most one open
cycle**. Two operators starting a cycle on the same tub becomes a write error, not a silent
double-booking. Do not rely on application-level checks for this.

### 4.3 `BucketTransaction` → `bucket_transactions`

Immutable ledger. Apply `applyImmutableMiddleware` — same pattern as
`ManufacturingMaterialTransaction`.

```ts
_id          String
cycleId      String
bucketId     String
type         String   // 'create' | 'advance' | 'adjust' | 'scrap' | 'consume'
                      // | 'merge_in' | 'merge_out' | 'release' | 'quarantine'
fromStage    String
toStage      String
qtyBefore    Number
qtyAfter     Number
qtyDelta     Number
reason       String   // required for adjust / scrap
journal      String   // required for residual scrap
relatedId    String   // LotRecord._id on consume; peer cycleId on merge
operator     { _id, username }
createdAt    Date
```

The bucket doc is current state; the ledger is history. Never derive current state by replaying
the ledger at read time — it is for audit and metrics.

### 4.4 Changes to existing models

| Model | Change |
|---|---|
| `cartridge-record.ts` | Add `backing.bucketCycleId` (real link) and `backing.bucketBarcode` (denormalized, for search) |
| `lot-record.ts` | Add `bucketCycleId` beside the existing unused `bucketBarcode` |
| `manual-cartridge-removal.ts` | Add `bucketCycleId` (sparse index) and `journal: String` |

`LotRecord.qrCodeRef` carries a **unique index** (`lot-record.ts:74`), but WI-01 mints that
itself as `WI01-xxxx` (`wi-01/+page.server.ts:283`). The reused bucket label lands in the plain
non-unique `bucketBarcode` field. **No collision.** Verified.

---

## 5. State machines

### 5.1 Bucket (the container)

```
                ┌──────────────────────────────┐
                ▼                              │
  (new) → available ──start cycle──→ in_use ───┘ auto-release at qty 0
                │                      │          (sets spotCheckPending)
                │                      └──residual deferred──→ quarantined
                │                                                   │
                └───────────────────────◀── dispositioned ──────────┘
                │
                └──damaged──→ retired  (terminal)
```

### 5.2 Cycle (the contents)

```
raw ──→ unpressed ──→ pressed ──→ qr_pending ──→ consumed
 │           │            │            │
 └───────────┴────────────┴────────────┴──→ scrapped (whole cycle)
```

Advancement is one step forward only. No skipping, no reversing — a mistaken advance is
corrected by `adjust` plus a reason, not by moving backwards.

---

## 6. Flows

### 6.1 Create a cycle

1. Scan `BKT-000123`. Bucket must be `available`.
2. If `spotCheckPending` → *Is the tub empty?* (§7)
3. Scan the `PT-CT-104` lot. Enter the count.
4. Writes: `BucketCycle` at `raw`; bucket → `in_use`, `$inc cycleCount`; `create` transaction;
   `InventoryTransaction` −N `PT-CT-104`; `AuditLog`.

### 6.2 Advance

Scan bucket → **Advance**. One step forward. `pressed → qr_pending` asks for the `PT-CT-106`
lot and debits −N of it; the other two moves record nothing extra.

### 6.3 WI-01 handoff

WI-01 step one becomes **scan the bucket** instead of typing a quantity:

- Bucket must have an open cycle at `qr_pending`.
- Quantity and `sourceLots` prefill from the cycle.
- On confirm: `LotRecord.bucketCycleId` + `bucketBarcode` set; every `CartridgeRecord` gets
  `backing.bucketCycleId` + `backing.bucketBarcode`.
- Cycle `quantity -= N` where N = records actually created. **Stop debiting `PT-CT-106`** —
  already debited at `pressed → qr_pending`. `PT-CT-104` already debited at create.
  **`PT-CT-112` continues to be debited here exactly as today** (§3.4).
- **Reconciliation:** a bucket labeled 100 that produces 97 records reports a 3-unit gap. Today
  that gap is invisible.
- At `quantity 0`: cycle → `consumed`, bucket → `available` + `spotCheckPending`.

---

## 7. Residual flow

Triggered by *Is the tub empty?* → **No**, or by **Report contents** on any bucket card (§3.7).

**Step 1 — count and stage.** Enter how many are in the tub. Stage pre-fills from the stage the
previous cycle closed at, and stays **editable** — leftovers can be older than the last pass.

**Step 2 — disposition, three ways:**

**(a) Merge into a matching lot.** Scan the destination bucket. Validate it has an open cycle
**at the same stage** — a `pressed` residual cannot pour into a `raw` tub. Destination
`quantity += N` with `merge_in`; source cycle gets `merge_out`. If nothing is open at that stage
the option is disabled with the reason shown, because there is physically nowhere to pour them.

> `openedQty` on the destination stays the opening count and is *not* increased. A merge can
> legitimately push `quantity` above `openedQty`; the ledger explains it.

**(b) Scrap.** Required free-text journal, no reason code, no approval. Writes a
`ManualCartridgeRemoval` with `bucketCycleId`, `cartridgeCount`, `journal`, and the journal text
also into the existing required `reason` field so the current Recent Checkouts list on
`/manufacturing/cart-mfg/scrap` renders these rows without any change to that UI. Debits the
stage's part. Logs a `scrap` transaction.

**(c) Defer.** Abort. Bucket → `quarantined` with `residualNote`; it stops being offered for
reuse until dispositioned. Sometimes the honest answer is "I need to ask someone," and without
this the operator's only escape is to scrap material they were not sure about.

Any of the three clears `spotCheckPending` and continues.

### 7.1 A residual is always a count discrepancy

If cycle #7 recorded 100 into WI-01 and three are still in the tub, then 97 went in — and
WI-01's reconciliation (§6.3) already flagged that gap. **Link the residual disposition to the
open discrepancy** so the gap closes with a cause attached instead of staying an unexplained
variance.

**Do not retroactively rewrite the closed cycle's quantity.** This follows the
corrections-not-mutations convention the sacred documents already use. The closed cycle keeps a
`residualFound` entry recording what was discovered, when, and where it went, and
`closedWithResidual: true`. That makes "which stages leak count accuracy" a query.

---

## 8. Inventory effects

| Transition | InventoryTransaction |
|---|---|
| create → `raw` | −N `PT-CT-104` — the **only** 104 debit for these units |
| `raw → unpressed` | none |
| `unpressed → pressed` | **none** — thermoseal out of scope (§3.4) |
| `pressed → qr_pending` | −N `PT-CT-106` — the **only** 106 debit for these units |
| WI-01 consume | none for 104/106 (already debited); `PT-CT-112` unchanged from today |
| scrap / residual scrap | **none** — units already left part inventory when they entered the bucket; recorded on the bucket ledger + `ManualCartridgeRemoval` so loss is visible without double-debiting |
| adjust **down** | none — ledger only (same reasoning as scrap) |
| adjust **up** | −delta `PT-CT-104` (and −delta `PT-CT-106` at `qr_pending`): more material left inventory than the cycle recorded |
| merge | none — material moves between buckets, not in or out of inventory |

> Earlier drafts had scrap debiting "the stage's part" a second time. That double-counts:
> the create/label transitions are where part inventory drops. WI-01's own confirm step
> has the same double-debit pattern today (consumption of good+scrap *and* a separate scrap
> tx) — deliberately not fixed here; it's pre-existing and outside this change.

---

## 9. UI

### 9.1 `/manufacturing/cart-mfg/buckets` — stage board + scan rail

```
┌─────────────────────────────────────────────────────────┬──────────────────┐
│ Available │  Raw   │ Unpressed │ Pressed │ QR Pending   │  ┌────────────┐  │
│           │        │           │         │              │  │ scan / ⌕   │  │
│  BKT-004  │ BKT-12 │  BKT-007  │ BKT-019 │  BKT-002     │  └────────────┘  │
│  BKT-011  │  100   │    100    │   97    │    97        │                  │
│  BKT-023  │ 2d     │   4h      │   1h    │   20m        │  BKT-019  #4     │
│   (3)     │ BKT-18 │           │         │  BKT-015     │   Pressed · 97   │
│           │   80   │           │         │    60        │  BKT-019  #3     │
│           │        │           │         │              │   consumed 3/14  │
└─────────────────────────────────────────────────────────┴──────────────────┘
```

Five columns, `Available` first. Cards are open cycles showing count and dwell time. The right
rail is persistent: scan box on top, short result list under it, so an operator holding a tub
never hunts the board for it.

Scan resolution is context-dependent — one label, no modes:

- open cycle → jump to that cycle's card
- `available` → offer **Start new cycle** (with spot-check if pending)
- `quarantined` → offer **Disposition residual**
- retired / historical → short list of past passes, where `#3` / `#7` suffixes surface

### 9.2 `/manufacturing/cart-mfg/buckets/[bucketId]`

Full history for one tub: every cycle it has held, newest first, each expandable to its
transaction ledger. This is where reuse pays off — turns per bucket, dwell per stage, and every
residual it has ever produced.

### 9.3 Cartridge-admin dashboard strip

Above the In Process table on `src/routes/cartridge-admin/+page.svelte`:

```
Available 3 · Raw 420 · Unpressed 180 · Pressed 95 · QR Pending 60
```

Each tile deep-links into the bucket board filtered to that stage. Read-only glance; all moves
happen on the operator page. `Available` is included because empty buckets ready to fill is a
real constraint on starting work.

### 9.4 Bucket labels — QR sticker or printed BKT label

`/manufacturing/print-bucket-labels`. A bucket's **identity** is always its `BKT-NNNNNN` id
(minted from the existing `generateBarcode()` counter). Its **physical label** is the
operator's choice per bucket:

- **Assign a QR sticker** (default) — scan one of the already-printed UUID stickers from the
  Avery cartridge sheets onto the bucket. Stored on `ProductionBucket.barcode` (unique,
  sparse). Consumes 1× `PT-CT-106`, since a sticker on a tub is one fewer for cartridges.
  Minting in this mode queues the new ids so the operator scans one sticker per tub in
  sequence; any bucket (new or old) can also be picked and assigned or **re-labelled** later.
- **Print a BKT label** — render the ids for any adhesive stock, 3 across. **Reprint** renders
  an existing id again; it never mints.

Identity stays on `_id` deliberately: a scuffed sticker is *replaced* (`relabel` ledger
event), not the bucket, so history survives. Every scan path resolves a code by `_id` first,
then by `barcode` (`resolveBucketId`), so either label works at the board, WI-01, residual
merge, retire, and the history page.

**Collision guard.** A tub wearing a UUID sticker scans exactly like a cartridge. Every place
a `CartridgeRecord` is born (WI-01 scan-in, `cv/induct`, the three quick-* tools) calls
`assertNotBucketLabel()` and refuses a bucket's label with a 409, so a bucket sticker can never
become a phantom cartridge id. Conversely, assigning refuses a code that is already a
cartridge, another bucket's sticker, or a `BKT-` id.

---

## 10. Files

**New:**

```
src/lib/server/db/models/production-bucket.ts
src/lib/server/db/models/bucket-cycle.ts
src/lib/server/db/models/bucket-transaction.ts
src/lib/server/services/bucket-service.ts        ← all transition logic lives here
src/routes/manufacturing/cart-mfg/buckets/+page.server.ts
src/routes/manufacturing/cart-mfg/buckets/+page.svelte
src/routes/manufacturing/cart-mfg/buckets/[bucketId]/+page.server.ts
src/routes/manufacturing/cart-mfg/buckets/[bucketId]/+page.svelte
src/routes/manufacturing/print-bucket-labels/+page.server.ts
src/routes/manufacturing/print-bucket-labels/+page.svelte
```

`bucket-service.ts` is load-bearing: WI-01 and the bucket page must share one code path for
transitions. Do not duplicate transition logic into route actions.

**Modified:**

```
src/lib/server/db/models/index.ts                         export the three new models
src/lib/server/db/models/cartridge-record.ts              + backing.bucketCycleId / bucketBarcode
src/lib/server/db/models/lot-record.ts                    + bucketCycleId
src/lib/server/db/models/manual-cartridge-removal.ts      + bucketCycleId, journal
src/routes/manufacturing/cart-mfg/wi-01/+page.server.ts   scan-bucket prefill; drop PT-CT-106 debit
src/routes/manufacturing/cart-mfg/+layout.svelte          "Buckets" sidebar entry
src/routes/cartridge-admin/+page.server.ts                stage counts in load
src/routes/cartridge-admin/+page.svelte                   stage strip
src/routes/manufacturing/cart-mfg/pipeline/+page.server.ts  four upstream stages
```

**Permissions:** reads `manufacturing:read`, moves `manufacturing:write`. `adjust` and `scrap`
behind a higher bar — they are the two that change counts without physical justification. Every
mutation writes an `AuditLog` entry per CLAUDE.md.

---

## 11. Build order

1. **Models + service.** Three models, `bucket-service.ts`, the partial unique index. No UI.
   Unit-test the transition logic, especially the open-cycle uniqueness guarantee.
2. **Label printing.** Without labels there are no buckets to test with.
3. **Bucket board + detail page.** Create, advance, adjust, scrap. Not yet wired to WI-01.
4. **Residual flow.** Spot-check branch, Report contents, all three dispositions.
5. **WI-01 integration.** Scan-bucket prefill, reconciliation, the `PT-CT-106` debit move.
   Highest-risk step: it touches a live production flow. Do it last, alone, in its own commit.
6. **Dashboard strip + pipeline stages.** Read-only, lowest risk.

Steps 1–4 are additive and cannot break existing flows. Step 5 is the only one that modifies a
path operators use today.

---

## 12. Open items

1. **Validate stage vocabulary with operators** before step 3. `unpressed` / `pressed` is
   invented by this document (§2.1). Renaming after the UI ships means a data migration.
2. **Bucket sizing.** Whole-bucket advancement makes the tub the unit of work for the press.
   Confirm a sensible standard fill count before printing labels.
3. **How many physical tubs exist**, and do they need retroactive labeling of tubs already in
   service holding material?
4. **Press capture** — removed entirely at the user's request (§2.1). Re-add at the
   `unpressed → pressed` transition if per-press traceability or press parameters are ever
   needed; no migration required since nothing was recorded.
5. **Thermoseal** stays untouched (§3.4). If it later needs bucket-level tracking, the
   `unpressed → pressed` transition is where it would attach.
