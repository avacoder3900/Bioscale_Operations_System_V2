# Bucket System — Pre-Serialization WIP Tracking (as built)

**Started:** 2026-09-21 · **Last updated:** 2026-09-21
**Branch:** `feat/bucket-system` — **not merged**. Cut from `NEWDEV`, which turned out to be 564
commits behind production; `origin/master` was merged **into** this branch on 2026-09-21
(`f0e9176a`), so it now sits on current production code, 0 behind `master`.
**Production branch is `master`** (Vercel deploys prod from it). `NEWDEV` is GitHub's default but
stale; `main` is older still.
**Status:** Built and deployed to Vercel preview. Reviewed by the user on the preview only; never
exercised in production, no automated tests. See §12 before merging.
**Scope:** A barcode-tracked container system for counting cartridges through the four
production stages that happen *before* a cartridge has a barcode and therefore before a
`CartridgeRecord` exists — plus summary views on the cartridge-admin page, the cart-mfg
dashboard and the pipeline page.

This document began as the design plan and has been rewritten to describe what was actually
built. Where the build departed from the original plan, the text says so. Section numbers are
unchanged from the plan so earlier references (code comments cite e.g. "§6.3") still resolve.
Per-change narrative and every preview URL live in `progress.txt`.

---

## 1. The gap this fills

Before this work, everything upstream of WI-01 was a **scalar**, not a container. Pre-barcode
material existed only as `PartDefinition.inventoryCount` numbers:

- `PT-CT-104` Cartridge (raw blanks) — received via `ReceivingLot`
- `PT-CT-101` Thermoseal roll → `PT-CT-111` cut sheets → `PT-CT-112` laser-cut sheets
- `PT-CT-106` Barcodes — minted as UUIDv4, printed 80/sheet at `/manufacturing/print-barcodes`

Serialization starts at WI-01 (`src/routes/manufacturing/cart-mfg/wi-01/+page.server.ts`),
which consumes 1×104 + 1×112 + 1×106 per cartridge and creates one `CartridgeRecord` per
scanned barcode. A cartridge does not exist as a record until a barcode is stuck on it.

So there was no way to answer "how many cartridges are pressed right now," "where is that batch
of 100," or "we started with 100 and got 97 — where did 3 go." Buckets make those answerable.

### 1.1 The dead ancestor

`src/lib/server/db/models/backing-lot.ts` is a bucket: scanned barcode as `_id`, a
`cartridgeCount`, status machine `created → in_oven → ready → consumed`. It is legacy, not
written since WAX-FLOW-2, and `pipeline/+page.server.ts` still renders it read-only "until
drained."

**BackingLot's fatal flaw was barcode-as-primary-key** — one barcode, one lifetime, forever.
That is precisely what this system avoids (§3.2). BackingLot was not revived; the legacy rows
are left to drain.

---

## 2. The four stages

| Key | UI label | Meaning |
|---|---|---|
| `raw` | Raw | Raw cartridge blanks (PT-CT-104) counted into a bucket |
| `unpressed` | Unpressed | Staged for the press |
| `pressed` | Pressed | Off the press |
| `qr_pending` | **QR Scan-In Pending** | Barcode stickers applied, awaiting WI-01 scan-in |

`qr_pending` means labels are physically ON the cartridges. The bucket holds known-but-
unregistered barcodes; WI-01 scans each one to create the `CartridgeRecord`.

The label was renamed from "QR Pending" to **QR Scan-In Pending** at the user's request — it says
what the carts are waiting *for*. Display-only: the stored key stays `qr_pending`, so labels can
change freely (`STAGE_LABELS` in `bucket-service.ts` plus a handful of hardcoded UI strings) but
**renaming a key means migrating every cycle and every immutable ledger row**.

### 2.1 Pressing — no SOP exists

There is **no written SOP or work instruction for pressing anywhere in the repo** (searched
`docs/`, `protocols/`, `data/`, root `*.md`). The equipment is real and registered:

```
E-45  Press 1  Bench  B-06  Manufacturing
E-46  Press 2  Bench  B-06  Manufacturing   (VEVOR clamshell heat press)
```

— `data/equipment-datasheets/BT.csv` lines 52–53

The `unpressed` / `pressed` vocabulary is therefore **invented by this document** and still
needs confirming with operators (§12).

**Press capture was built, then removed at the user's request.** `unpressed → pressed` is a plain
stage move: no prompt, no `pressEquipment*` fields. If per-press traceability is ever wanted,
this transition is where it attaches (mirroring `backing.ovenLocationId`); nothing was ever
recorded, so re-adding it needs no migration.

---

## 3. Locked decisions

### 3.1 Whole-bucket advancement only

A bucket advances between stages as a unit — the *record* moves as one, not the physical work.

**Bucket size does NOT have to match what the press handles in one run.** A bucket can take
several press runs; it simply stays at `unpressed` until the operator advances it, which they do
once the whole bucket is pressed. Bucket size is a floor convenience, not a system constraint.

Quantity still changes *within* a stage, three ways, all preserving the invariant:

- **Scrap** — units lost. Free-text journal required. Writes a `ManualCartridgeRemoval` and a
  ledger row; **no inventory transaction** (§8).
- **Discard at advance** — every Advance form asks **"Any carts discarded?"** (dropdown
  0 … quantity; a reason is required when > 0). It is scrap folded into the move: the discard is
  recorded first, then the remainder advances. Discarding *all* of them closes the pass as
  scrapped and nothing moves.
- **Adjust** — physical recount disagrees with the record. Reason required. Flagged in the
  ledger as a correction, not a loss. Behind `manufacturing:admin`. Never to zero — emptying a
  bucket must go through scrap so the loss gets a journal entry.

**One exception: partial consumption is allowed, partial advancement is not.** WI-01 may
serialize 40 out of a 100-cartridge bucket; the bucket stays open at `qr_pending` with
`quantity: 60`. The remaining 60 never changed stage, so the invariant holds. The cycle closes
when it reaches zero. Without this, an operator running a short shift would be blocked.

### 3.2 Buckets and their lot numbers are reusable

The bucket id identifies the **physical tub**, not the batch. A bucket is used, drained, and
refilled indefinitely. This requires splitting container from contents (§4).

**Identity vs. label** (departure from the plan, which assumed a printed `BKT-` label only):
the bucket's identity is permanently its `BKT-NNNNNN` id; the physical label on the tub is
either a printed BKT label **or one of the already-printed UUID QR stickers** assigned to it
(§9.4). Both scan to the same bucket everywhere. Operators never type or scan a pass suffix.

**Known tradeoff, accepted:** reused lot numbers make history ambiguous — "lot BKT-000123"
could be March's pass or June's. Mitigated, not eliminated, by:

- `CartridgeRecord` binds to the **cycle id**, never the bare barcode.
- Passes are displayed as `BKT-000123 #7` in history, the change log and the rail.
- The bucket history page lists every pass that bucket has ever held.

If an auditor ever requires globally unique upstream lot numbers, the cycle id is already the
unique key — only the display layer would change.

### 3.3 Buckets are the source of truth; part counts stay in sync

Bucket sum per stage is authoritative. The two transitions that take material out of part
inventory write an `InventoryTransaction` via the existing `recordTransaction` service, so
`PT-CT-104` / `PT-CT-106` counts, the inventory pages and low-stock alerts keep working
untouched (§8).

### 3.4 Thermoseal is out of scope

**Nothing in the bucket code touches `PT-CT-112`.** `unpressed → pressed` debits nothing.
Whether thermoseal bonds at the press or at WI-01 is deliberately left unanswered; WI-01
continues to debit `PT-CT-112` exactly as before.

### 3.5 Auto-release with deferred spot-check

When a cycle reaches zero it closes and the bucket returns to `available` **immediately**. The
bucket is marked `spotCheckPending`. The next **Start cycle** on it asks *Is the tub empty?* —
**Yes** records `emptyConfirmedBy/At` on the new cycle and proceeds; **No** opens the residual
report (§7). The check lands at the one moment someone is physically holding the tub.

No cleaning record, no `needs_cleaning` state.

### 3.6 Residual disposition — free text, no approval

- Scrap journal is **required free text**. No reason-code dropdown.
- **No approval step at any quantity.** The journal is the control.

### 3.7 Residual reporting is available anytime

**report contents** is available on any idle bucket's panel, not only the spot-check branch. A
tub found on a shelf with material in it is how leftovers actually get discovered.

---

## 4. Data model

Three new models. Container and contents are separate records — this is what makes reuse work.

### 4.1 `ProductionBucket` → `production_buckets`

The physical tub. One row per bucket owned. Permanent.

```ts
_id              String    // 'BKT-000123' — identity, minted by generateBarcode('BKT','bucket')
barcode          String    // the QR sticker on the tub, if any (unique, SPARSE index); replaceable
state            String    // 'available' | 'in_use' | 'quarantined' | 'retired'
currentCycleId   String    // → BucketCycle._id, or null
cycleCount       Number    // monotonic, $inc on cycle open
homeLocation     String    // shelf label
spotCheckPending Boolean   // set on auto-release, cleared at next cycle start / residual report
residualNote     String    // set when quarantined, e.g. '3 × Pressed, 2 × QR Scan-In Pending — note'
retiredAt        Date
retiredReason    String
createdBy        { _id, username }
```

`retired` matters: tubs crack. Retiring is terminal so a reprinted duplicate label cannot
resurrect it.

### 4.2 `BucketCycle` → `bucket_cycles`

One pass of material through the stages. `_id` is a nanoid, so every pass is permanent and
unambiguous even though the bucket id repeats.

```ts
_id                String   // nanoid
bucketId           String   // → ProductionBucket._id
cycleNumber        Number   // 7  → displays as 'BKT-000123 #7'
stage              String   // 'raw' | 'unpressed' | 'pressed' | 'qr_pending'
quantity           Number   // current count
openedQty          Number   // count at creation (shrinkage visible by diff)
sourceLots         [{ partNumber, lotId, scannedAt }]   // 104 at open; 106 added at labeling
status             String   // 'open' | 'consumed' | 'scrapped' | 'voided'
voidedAt, voidedBy, voidReason, statusBeforeVoid       // set by voidCycle() — §12.2
emptyConfirmedBy   { _id, username }
emptyConfirmedAt   Date
closedWithResidual Boolean  // a residual was found after close — count-accuracy signal
residualFound      [{ qty, stage, disposition, destinationCycleId?, removalId?, at, by }]
discrepancies      [{ type: 'overrun'|'shortfall', qty, relatedId, at, note }]
openedBy           { _id, username }
openedAt           Date
stageEnteredAt     Date     // set on create and every advance — dwell without ledger replay
closedAt           Date
```

**Indexes:**

```ts
{ bucketId: 1 }, { unique: true, partialFilterExpression: { status: 'open' } }
{ stage: 1, status: 1 }
{ bucketId: 1, cycleNumber: -1 }
```

The partial unique index is the DB-level guarantee that a bucket holds **at most one open
cycle**. Two operators starting a cycle on the same tub becomes a duplicate-key error (mapped to
a 409), not a silent double-booking.

### 4.3 `BucketTransaction` → `bucket_transactions`

Immutable ledger (`applyImmutableMiddleware`).

```ts
_id, bucketId, cycleId?          // cycleId absent for bucket-only events
type         // 'mint' | 'relabel' | 'create' | 'advance' | 'adjust' | 'scrap' | 'consume'
             // | 'merge_in' | 'merge_out' | 'release' | 'quarantine' | 'retire' | 'void'
fromStage, toStage
qtyBefore, qtyAfter, qtyDelta
reason       // required for adjust
journal      // required for scrap
relatedId    // LotRecord._id on consume; peer cycleId on merge; removal id on scrap; sticker on relabel
operator     { _id, username }
createdAt
```

The bucket and cycle docs are current state; the ledger is history. Current state is never
derived by replaying it — it feeds the change log, the history page and future metrics.

### 4.4 Changes to existing models (fields only)

| Model | Change |
|---|---|
| `cartridge-record.ts` | `backing.bucketCycleId` (the real link, sparse index) and `backing.bucketBarcode` (denormalized BKT id, for search) |
| `lot-record.ts` | `bucketCycleId` beside the previously unused `bucketBarcode` |
| `manual-cartridge-removal.ts` | `bucketCycleId` (sparse index), `bucketId`, `journal`; `voidedAt` / `voidReason` when its pass is voided |

`LotRecord.qrCodeRef` carries a unique index, but WI-01 mints that itself as `WI01-xxxx`; the
reused bucket id lands in the plain non-unique `bucketBarcode` field. **No collision.** Verified.

---

## 5. State machines

### 5.1 Bucket (the container)

```
                ┌──────────────────────────────┐
                ▼                              │
  (mint) → available ──start cycle──→ in_use ──┘ auto-release at qty 0
                │                      │          (sets spotCheckPending)
                │  residual report ────┴──defer──→ quarantined
                │       (merge / scrap → stays available)       │
                └───────────────────────◀── merge / scrap ──────┘
                │
                └──retire (not while in_use)──→ retired  (terminal)
```

**Quarantined** = leftovers were found and the operator chose *Defer* ("I need to ask
someone"). The tub cannot start a cycle until someone opens it and merges or scraps the
contents. It exists so the only escape from uncertainty is not "scrap it anyway".

### 5.2 Cycle (the contents)

```
raw ──→ unpressed ──→ pressed ──→ qr_pending ──→ consumed   (WI-01 drew it to zero)
 │           │            │            │
 └───────────┴────────────┴────────────┴──→ scrapped         (scrap / discard took it to zero)
```

One step forward only. No skipping, no reversing.

Any pass — open or closed — can additionally be **voided** (`status: 'voided'`) by an admin when
it never really happened: test data, or a cycle opened against the wrong lot. Voiding returns
what the pass took from inventory and frees the tub if it was open (§12.2). It is refused if
cartridges were serialized from the pass.

---

## 6. Flows

### 6.1 Start a cycle

1. Pick or scan a bucket (BKT id or its sticker). Must be `available`.
2. If `spotCheckPending` → *Is the tub empty?* (§3.5 / §7)
3. Choose the `PT-CT-104` lot (validated the same way WI-01 validates lots). Enter the count.
4. Writes: `BucketCycle` at `raw`; bucket → `in_use`, `$inc cycleCount`; `create` ledger row;
   `InventoryTransaction` −N `PT-CT-104` against that lot; `AuditLog`.

### 6.2 Advance (with discard)

`advanceCycleWithDiscard()`. The form asks **Any carts discarded?** then, for
`pressed → qr_pending` only, the `PT-CT-106` label lot. Order of operations matters:

1. **Validate everything first** — cycle open, a next stage exists, count ≤ quantity, reason
   present when > 0, label lot valid when moving to `qr_pending`.
2. Record the discard (`scrapFromCycle`), so a discard is never written for a move that fails.
3. Advance the remainder. The `PT-CT-106` debit therefore covers only carts that actually move.

`raw → unpressed` and `unpressed → pressed` record nothing beyond the stage change.

### 6.3 WI-01 handoff

WI-01 is three actions, and the bucket threads through all of them. The legacy manual-lot flow
is **unchanged** when no bucket is chosen.

- **`checkAndStart`** — optional *Source bucket* (scan box + pick-list of open `qr_pending`
  cycles; matches BKT id or sticker). The cycle's source lots **override** the submitted
  `lot1`/`lot3`, the count prefills, the inventory precheck covers `PT-CT-112` only, and
  `LotRecord.bucketCycleId` / `bucketBarcode` are stamped.
- **`scanBackedCartridge`** — stamps `backing.bucketCycleId` / `bucketBarcode` on each new
  `CartridgeRecord`; refuses a bucket's own sticker (§9.4 collision guard).
- **`confirmComplete`** — for a bucket lot: `scrapFromCycle(scrapCartridge)` then
  `consumeFromCycle(scannedCount)`, then withdraws **`PT-CT-112` only** (104 and 106 were
  debited upstream). Both bucket calls are **non-blocking**: a ledger mismatch is surfaced as a
  note in the handoff dialog, never a 500. Scanning *more* than the cycle held is recorded as an
  `overrun` discrepancy, never blocked — the scans are the physical truth.
- At `quantity 0`: cycle → `consumed`, bucket → `available` + `spotCheckPending`.

Fixed along the way: WI-01's hand-fetched action responses were read as plain JSON, but
SvelteKit devalue-encodes them, so `fail()` messages never reached the operator ("Error 409").
Both handlers now use `deserialize()` from `$app/forms`.

---

## 7. Residual flow

Triggered by *Is the tub empty?* → **No**, by **report contents** on any idle bucket, or by
opening a quarantined bucket.

**Step 1 — a count per stage.** Four *How many* rows (Raw / Unpressed / Pressed / QR Scan-In
Pending) with a running total, because a tub can hold leftovers from several stages. The stage
the last pass closed at is tagged as a hint; nothing is preselected. (The plan had one count and
one stage dropdown.)

**Step 2 — one disposition for the whole report:**

**(a) Merge.** A destination box appears under each stage that has a count. Each destination
must have an open cycle **at that same stage**. **All destinations are validated before anything
is written**, so a bad second row never leaves a half-applied report. Destination
`quantity += N` with `merge_in`; source gets `merge_out`.

> `openedQty` on the destination is *not* increased. A merge can legitimately push `quantity`
> above `openedQty`; the ledger explains it.

**(b) Scrap.** One required journal for the report; one `ManualCartridgeRemoval` + one `scrap`
ledger row **per stage**. The journal text is mirrored into the removal's required `reason`
field so Recent Checkouts on `/manufacturing/cart-mfg/scrap` renders these rows with no change
to that UI.

**(c) Defer.** Bucket → `quarantined`, `residualNote` = the breakdown plus any note.

Merge and scrap return the bucket to `available`. Mixed dispositions (merge some, scrap the
rest) are done as two reports; the form says so.

### 7.1 A residual is always a count discrepancy

If pass #7 recorded 100 into WI-01 and three are still in the tub, then 97 went in. **The closed
cycle's quantity is never rewritten** — following the corrections-not-mutations convention the
sacred documents use, it gets one `residualFound` entry and one `shortfall` discrepancy per
stage, and `closedWithResidual: true`. That makes "which stages leak count accuracy" a query.

---

## 8. Inventory effects

| Transition | InventoryTransaction |
|---|---|
| start → `raw` | −N `PT-CT-104` against the chosen lot — the **only** 104 debit for these units |
| `raw → unpressed` | none |
| `unpressed → pressed` | **none** — thermoseal out of scope (§3.4) |
| `pressed → qr_pending` | −N `PT-CT-106` against the chosen label lot — the **only** 106 debit |
| assign / replace a QR sticker | −1 `PT-CT-106` (no lot — which sheet it came from isn't knowable); constant `CONSUME_LABEL_ON_ASSIGN` |
| WI-01 consume | none for 104/106; `PT-CT-112` withdrawn exactly as before |
| scrap / discard / residual scrap | **none** — the units left part inventory when they entered the bucket; recorded on the ledger + `ManualCartridgeRemoval` so loss is visible without double-debiting |
| adjust **down** | none — ledger only |
| adjust **up** | −delta `PT-CT-104` (and −delta `PT-CT-106` at `qr_pending`) |
| merge | none — material moves between buckets |

> The plan originally had scrap debiting "the stage's part" a second time; that double-counts and
> was corrected before build. WI-01's own confirm step has the same double-debit pattern today
> (consumption of good+scrap *and* a separate scrap tx). Pre-existing, deliberately not touched —
> worth its own ticket.

**Consequence for cleanup:** "returning scraps to inventory" is the wrong frame — scraps never
touched inventory. Reversing test activity means reversing the *start*, *labeling* and
*sticker* debits (§12.2).

---

## 9. UI

### 9.1 `/manufacturing/cart-mfg/buckets` — board, rail, change log

```
┌──────────────────────────────────────────────────────────────────┬──────────────────┐
│ Available │  Raw   │ Unpressed │ Pressed │ QR Scan-In Pending    │  ┌────────────┐  │
│           │        │           │         │                       │  │ scan / ⌕   │  │
│  BKT-004  │ BKT-12 │  BKT-007  │ BKT-019 │  BKT-002              │  └────────────┘  │
│  BKT-011  │  100   │    100    │   97    │    97                 │                  │
│ ▲BKT-023  │ 2d     │   4h      │   1h    │   20m                 │  BKT-019  #4     │
│  (quar.)  │        │           │         │                       │   Pressed · 97   │
├──────────────────────────────────────────────────────────────────┴──────────────────┤
│ ▸ Change log (last 150 events)                        7 carts discarded in this window│
└──────────────────────────────────────────────────────────────────────────────────────┘
```

- **Stage strip** on top: Available ("empty buckets") · four stages (cartridges + bucket count)
  · Quarantined.
- **Five columns**, Available first; quarantined tubs list under Available in yellow. Cards show
  count, dwell at the current stage, shrinkage, and the sticker's short form. `?stage=` rings
  the matching column (deep links from the dashboards).
- **Scan rail** (right, persistent): one box, no modes. Resolves locally against the board by
  BKT id or sticker — open cycle → its panel; available → Start (with spot-check); quarantined →
  residual report — and falls through to a server search (`?q=`) for retired/historical ids.
- **Panel**: Advance (with discard), Scrap, Adjust (admin), Start, Report contents, Retire
  (admin). The panel stores **ids only** and resolves the live object with `$derived`; each
  action result is handled exactly once.
- **Change log** (collapsed, under the board): newest 150 ledger events across all buckets —
  When · Lot (`BKT #pass`, linked) · Event · Moved (from → to) · Carts (delta; "N left" after a
  WI-01 draw) · By · Note. Discard rows are red and the collapsed header totals carts discarded
  in the window. Client-side filter.
- **Bucket log** (collapsed, under the change log): the full register — every bucket ever
  minted in **every state, retired included** (retired tubs appear nowhere else on the page).
  Header shows counts per status; rows give Status · *Right now* (count + stage + pass for
  in-use, the residual note for quarantined, reason + date for retired, "empty" / "check
  pending" for available) · Passes · Sticker · Home · Last activity · Minted. Filter by status
  and text. Read model: `bucketRegistry()`.

> Bug fixed after first review: SvelteKit keeps the last action result in `form` until the next
> action, and the panel's effect treated any lingering `*.success` as "reset to view" on every
> panel change — so after one Advance, Scrap/Adjust could never open. Hence the ids-only panel
> and the handled-once guard.

### 9.2 `/manufacturing/cart-mfg/buckets/[bucketId]`

Full history for one tub (accepts BKT id or sticker): every pass, expandable to its ledger, the
WI-01 batches it fed, the cartridges serialized from it (via `backing.bucketCycleId`),
discrepancies and residuals; the scrap journal; bucket-level events (mint, relabel, retire).
Admins get **Void this pass…** inside each expanded pass (§12.2); voided passes and their scrap
entries are shown marked, never hidden.

### 9.3 Summary views (all read-only, all deep-link to the board)

- **Cartridge-admin** (`/cartridge-admin`) — strip above the filters.
- **Cart-mfg dashboard** (`/manufacturing/cart-mfg`) — *Production Buckets* card in the
  Pipeline Flow tile-and-arrow style, **directly beneath the Robot Status Grid** (moved there
  from above Pipeline Flow at the user's request).
- **Pipeline** (`/manufacturing/cart-mfg/pipeline`) — four `bucket_*` stages prepended.

Each load wraps `stageCounts()` in `.catch(() => null)` so a bucket-collection problem hides the
module rather than taking the page down.

### 9.4 Bucket labels — QR sticker or printed BKT label

`/manufacturing/print-bucket-labels` (path kept; page titled *Bucket Labels*; has a
*Return to previous page* button, falling back to the board when there is no history).

- **Assign a QR sticker** (default) — mint N, then scan one already-printed UUID sticker per tub
  through a queue. Any bucket can also be picked (or scanned) to assign or **replace** a sticker;
  `?bucket=` deep-links from the board and history page. Buckets-without-a-sticker list for
  catch-up.
- **Print a BKT label** — render ids 3-across for any adhesive stock. **Reprint** never mints.

Identity stays on `_id` deliberately: the print flow cannot reprint a specific UUID, so a scuffed
sticker is *replaced* (`relabel` ledger event) and history survives. `resolveBucketId()` — `_id`
first, then `barcode`, matched in either case — backs every scan path.

**Collision guard.** A tub wearing a UUID sticker scans exactly like a cartridge, so every place
a `CartridgeRecord` can be born refuses a bucket's label with a readable message. As of the
merge with `master` (2026-09-21) those places are:

| Genesis path | How it creates | Guard |
|---|---|---|
| WI-01 `scanBackedCartridge` | `.create()` | `assertNotBucketLabel` → 409 |
| `cv/induct` | `.create()` | `assertNotBucketLabel` → 409 |
| `quick-wax-fill` | `.create()` | `assertNotBucketLabel` (its catch surfaces the message) |
| `state-change` ("Create unknown barcodes") | `.create()` | `resolveBucketId` → rejected row |
| `wax-filling` deck load, **test mode** | `bulkWrite` **upsert** | `findBucketLabels` → 400 |
| `reagent-filling` deck load (stub for unknown ids) | `bulkWrite` **upsert** | `findBucketLabels` → 400 |

`quick-reagent-test` became a redirect to `state-change` on master and `quick-wax-store` was
deleted there, so their guards went with them. Conversely, assignment refuses a code that is
already a cartridge, another bucket's sticker, or a `BKT-` id.

**This guard is the only thing between a bucket sticker and a phantom cartridge; any new
cartridge-genesis path must call it.** When looking for such paths, search for `bulkWrite` with
`upsert: true` / `$setOnInsert` as well as `.create(` — the first sweep searched only for
`.create(` and missed both upsert paths above; they were found during the master merge.

---

## 10. Files

**New:**

```
src/lib/server/db/models/production-bucket.ts
src/lib/server/db/models/bucket-cycle.ts
src/lib/server/db/models/bucket-transaction.ts
src/lib/server/services/bucket-service.ts        ← every transition + read model lives here
src/routes/manufacturing/cart-mfg/buckets/{+page.server.ts,+page.svelte}
src/routes/manufacturing/cart-mfg/buckets/[bucketId]/{+page.server.ts,+page.svelte}
src/routes/manufacturing/print-bucket-labels/{+page.server.ts,+page.svelte}
```

`bucket-service.ts` is load-bearing: WI-01 and the board share one code path per transition.
Routes only parse forms, enforce permissions and map `BucketError` → `fail()`.

**Modified:**

```
src/lib/server/db/models/index.ts                              exports
src/lib/server/db/models/{cartridge-record,lot-record,manual-cartridge-removal}.ts   fields (§4.4)
src/routes/manufacturing/cart-mfg/wi-01/{+page.server.ts,+page.svelte}   handoff (§6.3), deserialize fix
src/routes/manufacturing/cart-mfg/+layout.svelte               "Buckets" sidebar entry
src/routes/manufacturing/cart-mfg/{+page.server.ts,+page.svelte}         Production Buckets card
src/routes/manufacturing/cart-mfg/pipeline/{+page.server.ts,+page.svelte}  four bucket stages
src/routes/cartridge-admin/{+page.server.ts,+page.svelte}      stage strip
src/routes/cv/induct/+page.server.ts                           collision guard
src/routes/manufacturing/cart-mfg/quick-{reagent-test,wax-fill,wax-store}/+page.server.ts   collision guard
```

**Permissions (as built):** reads `manufacturing:read`; start, advance/discard, scrap, residual,
mint, assign sticker `manufacturing:write`; **adjust and retire `manufacturing:admin`** (or
`admin:full`). The plan wanted scrap behind the higher bar too; it stayed at write to match
WI-01's own scrap and the "journal is the control" decision. Every mutation writes an `AuditLog`.

---

## 11. Build history

Built in the plan's order — models + service, labels, board + history, residual flow, WI-01
last, then the read-only views — then iterated on the preview. Code commits on
`feat/bucket-system` (each followed by a `docs(progress)` commit logging its preview URL):

| Commit | What |
|---|---|
| `23b1d6b9` | Initial system: models, service, board, history, labels, WI-01 handoff, cartridge-admin strip, pipeline stages |
| `634e9a37` | QR-sticker labelling, `resolveBucketId`, collision guard at all five genesis points, `deserialize()` fix |
| `1e3c796a` | Return-to-previous-page button on the labels page |
| `dd123ef6` | Fix: Scrap/Adjust unresponsive after an action; Production Buckets card on the cart-mfg dashboard |
| `7628a469` | "Which press" prompt removed end to end |
| `29e51136` | Change log under the board |
| `201a639d` | "Any carts discarded?" at every Advance |
| `a621288e` | Residual report takes a count per stage |
| `14d55fff` | Dashboard card moved beneath the robot grid |
| `1dca1661` | Label: QR Pending → QR Scan-In Pending |
| `e59307be` | Available card: "empty tubs" → "empty buckets" |
| `b7e2c262` | Bucket log under the change log — every bucket, every status, retired included |
| `f0e9176a` | **Merge of `origin/master` (564 commits) into the branch**; collision guard extended to `state-change`, `wax-filling` test-mode upsert and `reagent-filling` stub upsert; `findBucketLabels()` |
| `47a2a63d` | `voidCycle()` + *Void this pass…* — return a test pass's inventory debits (§12.2) |

On the merged tree `npm run check` is **10 errors / 437 warnings** — the same ten pre-existing
errors; 437 is master's own warning count. None in any bucket-touched file.

`npm run check` after every change: **10 errors / 434 warnings, none in any file this branch
touches.** The 10 are pre-existing (`r2.ts` Buffer/BodyInit, `AskBimsWidget.svelte` unreachable
comparison, 8× implicit-any in `assembly/[sessionId]/+page.svelte`). Note `progress.txt`'s
2026-07-28 entry quoted a 46-error baseline; with the lockfile on the build machine it is 10.

---

## 12. Open items — read before merging

### 12.1 Verification status

- **No automated tests.** The repo's only harness is contract tests against a running app;
  `bucket-service` has no unit coverage. The open-cycle uniqueness guarantee, the
  validate-all-before-write residual merge and the advance-with-discard ordering are the three
  things most worth a test.
- **Exercised only by the user clicking through Vercel previews.** Nothing here has run in
  production.
- **Worth a deliberate check before merge:** (a) assign a sticker to a tub, then scan that
  sticker as a cartridge at WI-01 → must be refused with the bucket named; (b) residual merge
  with the second row's destination at the wrong stage → whole report refused, first destination's
  count unchanged; (c) advance with 2 discarded → change log shows a red −2 row then the move.

### 12.2 Test data and inventory — voiding a pass

The previews write to whatever Atlas database the preview environment is configured with —
**unconfirmed whether that is production.** Test cycles debited real `PT-CT-104` / `PT-CT-106`
lot quantity (on start, labeling and sticker assignment — *not* on scrap, §8).

**`voidCycle()` — built.** Admin-only (`manufacturing:admin`), from *Void this pass…* on the
bucket history page, reason required.

- **What it reverses** is read from the inventory ledger itself: every bucket debit is stamped
  `manufacturingRunId = cycleId` (start, labeling, adjust-up), so the pass's net debit per
  (part, lot) is a query, not a guess.
- **How**: one compensating row per (part, lot) — a **negative `consumption`** against the same
  lot, carrying the model's `retractedBy/At/retractionReason` — plus `$inc` on the part's
  `inventoryCount`. The negative-consumption shape is deliberate: per-lot "N left" is computed
  by summing consumption rows per lot, so an `adjustment` would fix the part total but leave the
  lot looking consumed.
- **Atomic claim**: the cycle is flipped to `voided` with a conditional update *before* any
  compensation is written, so a double-submit cannot return inventory twice.
- **Refused (409)** if any `CartridgeRecord` has `backing.bucketCycleId` = this pass — that
  material was genuinely used. Test buckets that went through WI-01 therefore need manual
  cleanup (the cartridges themselves, and the `PT-CT-112` WI-01 withdrew).
- **Not reversed, by design**: QR-sticker assignments (stamped with the bucket id, and the
  sticker really is on the tub).
- **Nothing is deleted.** The pass keeps its record and ledger (`void` row added), its scrap
  removals get `voidedAt`, the inventory ledger keeps both the debit and its retraction, and the
  change log greys the pass's rows and stops counting its discards as loss. An open pass frees
  its tub (`available`, empty-check armed).

Recent Checkouts on `/manufacturing/cart-mfg/scrap` does not yet badge voided rows.

### 12.3 Decisions still needed from the floor

1. **Stage vocabulary.** `unpressed` / `pressed` are invented (§2.1). Labels are free to change;
   keys are a migration once real data exists. Also confirm `raw` and `unpressed` are genuinely
   different places — every stage costs one scan per bucket per pass, forever.
2. **Bucket sizing — unconstrained.** Bucket size does **not** have to match a press run (§3.1),
   nor a WI-01 session (partial draws are allowed). The start form has no default or cap, which
   is consistent with that. If the floor ever wants a standard fill count for convenience, it
   would just be a default value on the form — nothing in the system depends on it.
3. **Cutover.** Recommended go-forward only: new blanks enter buckets, material already on the
   floor drains through the unchanged manual WI-01 flow. Walking existing tubs through the stages
   would put fake dwell times in an immutable ledger.

### 12.4 Known risks in how buckets meet the existing flows

- **Double-debit when the bucket is not selected at WI-01.** A bucket's blanks were debited at
  *start* and its labels at *labeling*. If that same physical material is run through WI-01's
  manual path (no Source bucket chosen), WI-01 debits `PT-CT-104` and `PT-CT-106` **again** —
  it has no way to know they came from a tub — and the bucket never drains, sitting at QR
  Scan-In Pending forever. Nothing prevents this today. Options: a warning on WI-01 whenever
  QR-pending buckets exist; or make the bucket mandatory once cutover is complete.
- **WI-01's "Can Make" card and low-inventory banner understate.** They compute from part
  inventory, which no longer includes blanks/labels sitting in buckets — even though QR-pending
  carts are exactly what can be made next.
- **Broken link.** Cartridge-admin search matches cartridge id and two legacy lot fields, not
  `backing.bucketBarcode`, so the "+N more" link on a bucket's history page (which searches by
  BKT id) finds nothing. One-line fix in `cartridge-admin/+page.server.ts`.
- **Ask BIMS and the agent API do not know buckets exist.**

### 12.5 Deferred / noted

4. **Press capture** — removed (§2.1); re-add at `unpressed → pressed` if ever needed.
5. **Thermoseal** — untouched (§3.4). If bucket-level tracking is wanted, it attaches at
   `unpressed → pressed`, mirroring the `qr_pending` branch; WI-01 would then stop withdrawing it
   for bucket lots. Today the *total* is right but *which 112 lot went with which bucket* is lost.
6. **WI-01 double-debit** (§8) — pre-existing, separate ticket.
7. **Adjust permission.** Disabled without `manufacturing:admin` (shown on the button). Opening
   it to `manufacturing:write` is a two-line change if the floor needs it.
8. **Wording.** The Available card says "empty buckets"; other copy still says "tub"
   ("Is the tub empty?", "In tub"). Sweep if consistency is wanted.
9. **Long label.** "QR Scan-In Pending" wraps to two lines in narrow tiles; a short form could be
   used in tight spots.
10. **Repo visibility.** The GitHub repo is public (`"private": false`) — flagged in case that is
    not intentional for a manufacturing-ops system.
