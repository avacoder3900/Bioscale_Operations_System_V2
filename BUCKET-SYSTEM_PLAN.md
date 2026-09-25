# Bucket System — Production Buckets, v2 (as built)

**Started:** 2026-09-21 · **Last updated:** 2026-09-25 (WI-01 page removed; fourth bucket stage **Backed, awaiting oven**; wax filling draws from the bucket)
**Branch:** `feat/bucket-system` — **PR #54 open into `master`**
(https://github.com/avacoder3900/Bioscale_Operations_System_V2/pull/54). `origin/master` has
been merged into this branch twice (last `33a937a4`); it sits on current production code.
**Production branch is `master`** (Vercel deploys prod from it). `NEWDEV` is GitHub's default but
stale; `main` is older still.
**Status:** Built and type-checked; deployed to Vercel preview via the GitHub integration only.
Reviewed by the user on previews; never exercised in production; no automated tests. See §12.
**Scope:** QR-labelled production buckets that carry cartridges through four stages —
**Barcoded → Unpressed → Pressed → Backed, awaiting oven** (status `backing`) — after which the
wax-fill operator puts the tub in the oven and scans its carts onto a deck; that deck load draws
them out of the bucket. A cartridge is *born* when its QR sticker is scanned into a bucket. The
system also owns **thermoseal roll tracking** (§3.4) and removed oven/cure-time tracking
app-wide (§3.8). **2026-09-25:** the WI-01 "Cartridge Back" page and its per-session
`LotRecord` were removed (§6.4) — they were a second, redundant handoff.

This document describes what is built. Section numbers are unchanged from the original plan so
code comments citing e.g. "§6.3" still resolve; where v2 replaced a v1 behaviour the text says
so. Per-change narrative and every preview URL live in `progress.txt`.

### What changed in v2 (2026-09-23)

| v1 (2026-09-21/22) | v2 |
|---|---|
| Buckets counted *unserialized* blanks; the cartridge was born at WI-01 scan-in | The cartridge is born at **bucket scan-in** (status `barcoded`); buckets hold a **membership list** of cartridge ids |
| Stages Barcoded → Unpressed → Pressed → **QR Scan-In Pending** | Stages **Barcoded → Unpressed → Pressed**, then **In Oven** (`backing`) via WI-01 |
| Mint many buckets, print BKT barcode labels, home location | Mint **one bucket at a time from one QR scan**; no printing, no location |
| "Blanks" (PT-CT-104) | **"Shells"** (PT-CT-104). The unrelated optical "Blank Cartridge" and the `cartridgeBlankLot` field name are untouched |
| Thermoseal: one PT-CT-112 unit per cart at Unpressed (interim) | Thermoseal **by length off a roll** (§3.4); rolls pulled from inventory; 2-roll floor with kanban + email |
| Backing oven + cure-time gate in WI-01, wax filling, dashboard, pipeline | **Removed app-wide.** No oven is chosen; nothing is time-gated |

---

## 1. The gap this fills

Before v1 nothing tracked material between receiving and the WI-01 scan: shells (PT-CT-104)
and labels (PT-CT-106) left inventory only when WI-01 scanned a cartridge, so pressing WIP was
invisible, discards before WI-01 were never debited, and "how many carts are on the floor" was a
walk. v2 goes further: because the QR sticker goes on the bare shell, the cartridge record
exists from the first stage and every later system (cartridge-admin, traceability, DHR) sees it.

### 1.1 The dead ancestor

`BackingLot` (`backing_lots`) was the old "tub of cartridges in an oven" aggregate. It is still
read read-only where legacy rows exist (pipeline In Oven view, equipment pages) and is never
written by the bucket system.

## 2. The stages

| Key | Label | What is physically true |
|---|---|---|
| `barcoded` | Barcoded | Shells with QR stickers on, scanned into the bucket one at a time |
| `unpressed` | Unpressed | Bucket staged for the press. **Thermoseal is consumed here** (§3.4) |
| `pressed` | Pressed | Off the press |
| `backing` | Backed, awaiting oven | Tub on the shelf, waiting for the wax-fill operator. **End of the bucket:** wax filling's deck load draws carts out (§6.4). The stage key is the cart status wax filling already accepts |

Each cartridge's `status` mirrors its bucket's stage while it is a member, so
`/cartridge-admin?stage=barcoded|unpressed|pressed|backing` filters real records.

> **Backed stage added 2026-09-25.** Before this, Pressed was the end of the bucket and a
> separate WI-01 page (scan bucket → session → scan/take-all → confirm) moved carts to `backing`
> one batch at a time, creating a `LotRecord` per session. The user judged the oven structure
> redundant and too many clicks: after pressing, carts just sit in a "backed" holding phase until
> the wax-fill operator places them in the oven and loads the deck. **Oven placement and time
> gating are disabled, not modelled** — nothing records which oven or when; it may return later.
> **One category (user, 2026-09-25):** every cart at `backing` is *Backed, awaiting oven*,
> whether or not it is still a member of an open pass. Carts drawn by the old WI-01 page before
> the change, or handed back by a cancelled wax run to a tub that had moved on, are not in a
> pass; they are counted in the Backed tile all the same (`StageCounts.stages.backing.cartridges`
> is the count of every cart at status `backing`, not of pass members) and wax filling accepts
> them. There is no separate "no bucket" tile or count — a first version had one and it was
> removed as redundant.

> **Renamed 2026-09-25: `raw` → `barcoded`.** The first stage is named for what has happened to
> the shell (a QR/barcode label is on it), not for the material it was cut from. The old value
> `raw` stays in the `BucketCycle.stage` and `CartridgeRecord.status` enums so pre-rename rows
> still validate; `scripts/migrate-bucket-raw-to-barcoded.ts` moves live rows over. Nothing
> should write `raw` again.

### 2.1 Pressing — no SOP exists

`unpressed` / `pressed` are still the working names; there is no pressing SOP in the repo. The
"which press" prompt was removed on 2026-09-22.

## 3. Locked decisions

### 3.1 Whole-bucket advancement only

A bucket moves as a unit. At every advance the operator is asked **"Any carts discarded?"** and
scans each discarded cart; those are scrapped (§8) before the move so the rest move together.
Bucket size does **not** have to match a press run or a wax deck (24 carts); a deck load may
draw part of a backed bucket (partial consumption) and the remainder stays Backed.

### 3.2 Buckets and their ids are reusable

`ProductionBucket._id` (`BKT-NNNNNN`) is permanent; the QR sticker (`barcode`) is replaceable at
`/manufacturing/cart-mfg/buckets/new?bucket=BKT-…`. Each use is a **pass** (`BucketCycle`,
`cycleNumber` increments). The `bucketId → open pass` uniqueness is a partial unique index.

### 3.3 Inventory is debited at scan-in — the scan is the truth

Yellow note on the board: **"Inventory is not Debited Until Carts are Scanned in."**

- Scanning a cart into a Barcoded bucket debits **1 × PT-CT-104 (shell) + 1 × PT-CT-106 (label)**
  from the lots chosen when the pass was started, and creates the `CartridgeRecord`.
- A mis-scan can be **un-scanned** while the pass is still Barcoded: the record is deleted and both
  debits are retracted (negative rows of the same type, §8).
- A discarded cart (at advance, via *Scrap*, or as a residual) writes a `scrap` transaction for
  its shell and label. **Thermoseal length is not returned** — it is consumed material.
- Pressed → Backed and the wax-fill draw debit nothing.

### 3.4 Thermoseal — consumed by length off a roll (2026-09-23)

*Replaces v1's "out of scope" and the interim one-unit-per-cart debit.*

PT-CT-112 is stocked in **rolls** and used by **length**:

| Rule | Value | Where |
|---|---|---|
| Length per cartridge (averaged for excess) | **3.75 cm** | `ManufacturingSettings.thermoseal.cmPerCartridge` (default in `thermoseal-service.ts`) |
| Length per roll | **65 m = 6500 cm** (≈ 1733 carts) | `…thermoseal.rollLengthCm` |
| Floor: rolls that must stay in inventory | **2** | `…thermoseal.minRollsInInventory` |
| When consumed | **Barcoded → Unpressed**, members × 3.75 cm | `bucket-service.advanceCycle` → `consumeThermoseal` |
| **Development toggle** — restock notifications | **OFF** by default | `…thermoseal.notificationsEnabled`; admin checkbox on the board's Thermoseal card |
| **Development pin** — rolls on hand shown/used by the board | **pinned at 1** by default | `…thermoseal.rollsOnHandPinned` / `rollsOnHandOverride`; admin control on the same card. Unpin to follow the live PT-CT-112 count (meaningless in rolls until PR #60 lands) |

- `ThermosealRoll` (`thermoseal_rolls`) is one physical roll: `lengthCm`, `consumedCm`,
  `status` active | exhausted | retired, `lotId`, `openedBy/At`, `openedForCycleId`,
  `inventoryTxId`. At most one roll is `active`.
- **A roll is pulled from inventory only when the open roll runs out** (or on the very first
  advance). The pull is one `consumption` of quantity 1 against PT-CT-112, `manufacturingRunId =
  roll id` — *not* the bucket pass — so voiding a pass never puts an opened roll back on the
  shelf. The lot is the one scanned on the advance form (optional) or else the **oldest accepted
  PT-CT-112 lot with stock** (FIFO by the ledger).
- A bucket larger than the roll's remainder rolls over onto the next roll (and again if needed);
  the pass records `thermoseal.segments = [{ rollId, cm }]`.
- **Floor rule.** `checkFloor()` runs after every pull, on every bucket-board load and in the
  kanban supply sweep (daily cron / Queue page). It reads PT-CT-112 `inventoryCount` (rolls);
  the board always shows the below-floor state. **Only while the notifications toggle is on**,
  a shelf below `minRollsInInventory` also gets:
  1. one **kanban restock card** is spawned through the existing supply autopilot
     (`kanban/standing.ensureThermosealRestockCard`): chore, class of service *expedite*,
     auto-committed to the ready queue, idempotent on `sourceRef thermoseal-restock:<partId>`,
     body carries the **lead-time warning** (`PartDefinition.leadTimeDays` if set);
  2. the **low-inventory email list** (`NotificationSettings.lowInventory`, sent via Resend) gets
     `notifyThermosealLow` — only on the pull that *created* the card, so a shelf that stays low
     does not re-mail on every roll; the open card is the standing reminder.
- **Void** (§12.2) credits the pass's segments back to their rolls (`creditThermoseal`); an
  exhausted roll becomes active again only if no other roll is open.
- The board shows a **Thermoseal card**: open roll gauge (m left, ≈ carts left, lot), rolls in
  inventory vs. the floor, the lot the next roll would come from, and the restock state. The
  advance form previews "N cm comes off the open roll" and only asks for a lot when a new roll
  will be pulled.
- **Current stock, and why it is negative.** The live `PT-CT-112` count sits on the *Rolls on
  hand* tile (pinned value shown, live value in "Development settings"), and the yellow card
  above it names the build that is draining it. A fuller "current stock" note was added above
  "Development settings" on 2026-09-23 and **removed the same day as redundant with that tile**
  (user) — `ThermosealStatus.liveCountAt` went with it.

**Cutover:** PT-CT-112 `inventoryCount` was −427 from the interim per-cart debits; a physical
count of **1 roll** was recorded on 2026-09-23 (MCP `record_physical_count`, Samantha Wolf).
The shelf is therefore already below the floor; the restock card + email stay off until the
development toggle is switched on. The part is named "Thermoseal Laser Cut sheet" in parts; the
unit of measure should read "roll". The count has drifted negative again since — **−77 on
2026-09-23** (last physical count 2026-09-23 16:35 UTC) — because the build live on `master`
keeps debiting one unit per cart out of the same database (§12.4). **User, 2026-09-23: that is
a known artifact of the live build and will not go away until this branch ships** — do not
chase it, and do not re-count PT-CT-112 to make it look right.

### 3.5 Auto-release with deferred spot-check

When wax filling draws the last member, the pass closes and the bucket returns to *Available* with
`spotCheckPending`; the next *Start* asks "Is the tub empty?".

### 3.6 Residual disposition — free text, no approval

"No" at the spot-check (or *Report leftover carts* any time) opens a **scan-based** residual
report: scan each leftover cart, then **merge** into an open pass at that cart's stage or **scrap**
(journal required). Whole report validates before anything is written. **Quarantine ("defer")
was removed as a category on 2026-09-23** — the enum values and the `quarantine` ledger type
stay for legacy rows, and any bucket still marked quarantined resolves through merge / scrap.

### 3.7 Residual reporting is available anytime

From the rail on any Available bucket.

### 3.8 Oven tracking and time gating removed app-wide (2026-09-23)

- No step picks an oven; `backing.oven*` and `ovenEntryTime` are **LEGACY** fields (kept
  for old rows, never written). `backing.recordedAt` is the time the bucket was advanced to
  Backed (was the WI-01 scan time until 2026-09-25).
- `cure-time.ts` deleted; `minOvenTimeMin` removed from both settings pages (field kept on the
  model for old docs); wax-filling deck loading no longer computes "ready"/under-time; the
  cart-mfg dashboard's Ovens section is gone; the pipeline's In Oven view has no Oven/Ready
  columns; the lot page shows the source bucket instead of an oven.
- **Left alone on purpose:** the post-wax-run oven placement (`PostRunCooling`, `ovenPlacement`),
  the reagent `ovenCure` step, ovens as equipment, and the legacy read-only aggregates on the
  equipment pages.

## 4. Data model

### 4.1 `ProductionBucket` → `production_buckets`

`_id` BKT-NNNNNN · `barcode` (QR, unique sparse) · `state` available | in_use | quarantined |
retired · `currentCycleId` · `cycleCount` · `spotCheckPending` · `residualNote` ·
`retiredAt/Reason` · `createdBy` · `homeLocation` (LEGACY, unused in v2).

### 4.2 `BucketCycle` → `bucket_cycles`

`bucketId` · `cycleNumber` · `stage` barcoded | unpressed | pressed (`qr_pending` kept in the enum
for v1 rows) · **`cartridgeIds: string[]`** (members) · `quantity` (= length) · `openedQty`
(fixed when leaving Barcoded; shrinkage = openedQty − quantity) · `sourceLots[{partNumber, lotId,
scannedAt}]` · **`thermoseal { cm, cartridges, segments[{rollId, cm}], consumedAt }`** · `status`
open | consumed | scrapped | voided (+ `voidedAt/By/Reason`, `statusBeforeVoid`) ·
`residualFound { cartridgeIds, disposition, … }` · `discrepancies[]` ·
**`audits[{ at, by, scanned[], present[], missing[], foreign[{barcode, action, fromCycleId,
destinationBucketId, destinationCycleId}] }]`** (§9.8) · `stageEnteredAt` ·
`openedBy/At`, `closedAt`. Partial unique index `{bucketId}` where `status: 'open'`; index
`{cartridgeIds: 1}`.

### 4.3 `BucketTransaction` → `bucket_transactions` (immutable)

Types: `mint, relabel, create, scan_in, unscan, advance, adjust, scrap, consume, merge_in,
merge_out, release, quarantine, retire, void, audit`. Carries `cartridgeIds` for the rows that touch
carts. The `advance` row into Unpressed stores the thermoseal note (cm, roll ids, rolls pulled)
in `reason` and the first roll id in `relatedId`.

### 4.4 Changes to existing models (fields only)

- `CartridgeRecord`: status enum gains `barcoded, unpressed, pressed` (before `backing`);
  `bucket { bucketId, cycleId, scannedInAt, scannedInBy }`; `backing.bucketCycleId/bucketBarcode`;
  oven fields LEGACY. Index `{ 'bucket.cycleId': 1 }` sparse.
- `ManualCartridgeRemoval`: `bucketCycleId`, `bucketId`, `journal`, `voidedAt`, `voidReason`.
- `LotRecord`: `bucketCycleId`.
- `ManufacturingSettings.thermoseal { cmPerCartridge, rollLengthCm, minRollsInInventory }`.
- **New** `ThermosealRoll` (§3.4).
- `cartridge-admin/queries.ts` `LifecycleStage` gains `barcoded | unpressed | pressed`.

## 5. State machines

### 5.1 Bucket

`available —start→ in_use —last member drawn / all discarded→ available (spotCheckPending)`;
`available —retire (admin)→ retired`. (`quarantined` is legacy only — no transition into it.)

### 5.2 Pass

`open@barcoded —advance→ open@unpressed —advance→ open@pressed —advance→ open@backing —wax filling loads the last member→ consumed`;
`consumed@backing —wax run cancelled/aborted, tub still free→ open@backing` (`returnCarts`, §6.4);
`open —all members discarded→ scrapped`; `open|consumed|scrapped —void (admin)→ voided`.

## 6. Flows

### 6.1 Start a pass

Rail → pick an Available bucket → choose the **shell lot (104)** and **label lot (106)** →
confirm empty if `spotCheckPending`. Opens at Barcoded with 0 members. Nothing is debited yet.

### 6.2 Scan carts in (Barcoded only)

Scan a QR sticker → `scanCartIn`: the sticker must not be a bucket label (collision guard), a
merged double-read, or an existing cartridge; a `CartridgeRecord` is created at `barcoded` with
`bucket.*`; 1 × shell + 1 × label debited. A mis-scan button un-scans (record deleted, debits
retracted) — see §6.2.1 for why that delete needs the driver-level path.

#### 6.2.1 Scanning pace — the hot path (2026-09-25)

Scan-in is the one bucket flow an operator runs *at speed*: a gun, one cart after another, no
pauses. It was audited end to end for lag on 2026-09-25 and rebuilt around that. Rules for anyone
touching it:

- **The scan box never blocks and is never `disabled`.** A barcode gun is a keyboard — it types
  ~36 characters and hits Enter whether or not the page is ready, and a disabled input loses focus,
  so the characters go nowhere. Enter drains the box onto `scanQueue` and returns; one worker
  (`pumpCartScans`) posts the queue in order. Each queue entry carries its own `cycleId`, so
  opening a different bucket mid-drain still lands the earlier carts in the right tub.
- **No `invalidateAll()` between carts.** It re-ran the root layout, the cart-mfg layout and the
  board load — ~25 queries, three of which scan collections that every scan-in makes bigger, so
  cart #200 was slower than cart #1. Instead the board keeps a **membership overlay**
  (`scanAdded` / `scanRemoved`, keyed by cycle id) that every read of an open pass goes through
  (`boardCycles`), and **one** refetch lands 2.5 s after scanning stops. The overlay is
  self-healing — once the server knows an id, the overlay entry for it is a harmless duplicate —
  so a refetch may land at any moment, including mid-queue.
- **Failed scans stack up** under the box rather than showing one line: with a queue, the next
  cart's success would otherwise erase the error and the cart would be silently lost.
- **A merged double-read is split client-side** and both carts are scanned, matching WI-01.
  `assertNotMergedBarcode` stays as the server backstop.
- **Inside `scanCartIn`,** the three guards (pass, bucket-label collision, "already a cart") run in
  one `Promise.all`, and so do the five writes after the `CartridgeRecord` is created. The
  cartridge record is still created *before* the debits — nothing may be debited for a cart that
  was not born — but the write group beyond that is unordered. It returns the new count only; it
  does **not** re-read the pass.
- **Do not add a sequential `await` to this path** without checking whether it can join one of
  those groups. The count went from ~20 round trips per scan to ~7.

### 6.3 Advance (with discard)

"Any carts discarded?" scan list + journal → discards scrapped first → all remaining members'
`status` follows the bucket. **Barcoded → Unpressed** additionally runs `consumeThermoseal` (§3.4)
and shows the result banner (cm taken, rolls pulled, floor alert). **Pressed → Backed** stamps
`backing.recordedAt/operator/bucketCycleId/bucketBarcode` on every member (what WI-01 used to
write, minus the lot) so the pipeline, dashboard and DHR can group backed carts by pass.
**Backed** is the end of the bucket: the card shows *Ready for the oven → wax filling* instead
of an Advance button.

### 6.4 Wax-fill handoff (2026-09-25; replaced the WI-01 page)

`/manufacturing/cart-mfg/wax-filling`: a purple line above the deck grid lists the **Backed**
buckets (`backedBuckets`, tub id + count) — the operator puts the tub in the oven, then scans
its carts onto the deck as before. `loadDeck` validates each scan (must exist, must be at
`backing`), then groups the scans by open pass and calls `consumeCarts` per pass **before** the
status write; a bucket refusal leaves the cart untouched. Carts not in any open pass (§2)
load without a bucket write. The pass closes (`consumed`) and the tub auto-releases when
the last member is loaded. Ledger row: `consume` with `relatedId` = the wax run id.

**Cancel / abort** (`revertToBacked` in the wax-filling server): real carts go back to
`backing` and `returnCarts` puts them back into their pass — reopening a consumed pass at Backed
if the tub is still `available`; if the tub already started a newer pass the cart stays at
`backing` outside a pass (logged, still counted as Backed, still loadable). Test-mode synthetics (`backing.synthetic: true`, or neither a bucket
nor a WI-01 lot) are hard-deleted as before.

**Removed:** `src/routes/manufacturing/cart-mfg/wi-01/` (page + steps editor), the *Cartridge
Back* nav entry, the board's *WI-01 →* button. `LotRecord`s written by the old page stay
readable on `/manufacturing/cart-mfg/lots/[lotId]` and on the bucket history page under
*WI-01 batches (legacy)*. The `backing` `ProcessConfiguration` row is no longer edited anywhere.
`IN_OVEN_STATUS` / `IN_OVEN_LABEL` became `BACKED_STATUS` / `BACKED_LABEL` (`BACKED_STAGE` is
the stage key); the override's `in_oven` target is gone — Backed is an ordinary target and the
pass stays open there.

## 7. Residual flow

Scan-based (§3.6). A residual is always a **membership discrepancy** — the scanned carts are
real records whose status says which stage they were at — so merge/scrap act on ids, and the
`residualFound` block on the previous pass records the ids and disposition.

**Leftover flow as built (2026-09-23, simplified the same day).** From *Report leftover carts*
on an Available bucket, the panel asks **Merge or Discard** first:

- **Merge** — shows the **last stage this bucket's carts were in** (its previous pass's stage)
  and one *Merge into* picker suggested from the board: an **open pass at that stage** first;
  else an **empty bucket** (this bucket itself first — the carts are already in it), where a
  **new pass opens at that stage** holding them (`openedQty` = n, source lots carried over,
  nothing debited); else a **mint a new bucket** hint linking to `/buckets/new` and the button stays disabled. Then the
  carts are scanned (they are tracked by id, so the records must be named) and merged. The
  server validates every cart on submit (known, still at that stage, not in an open pass).
  Ledger: `create` (new pass) or `merge_in`, plus one `merge_out` on the reported bucket.
- **Discard** — **bulk QR scan** of every cart being discarded + journal (required); shell +
  label scrapped from inventory (§8).

**Where does this cart belong? (user, 2026-09-25).** Above the Merge / Discard choice the panel
carries a small search box: scan (or type) one leftover cart and get one line back — the open
pass it is still a member of (`belongs in bucket BKT-… #n (stage)`), or that it is on no open
pass (with the pass it was last in, if any). Read-only, same `?/cartLookup` → `cartStatusLine()`
as the board's *Find a cart* box (§9.1); it does not add the cart to the scan list, it only tells
the operator which choice fits. `cartStatusLine()` now answers from open-pass **membership**
(`BucketCycle.cartridgeIds`) first and falls back to the cart's own `bucket.cycleId` for
"last seen", since an audit *Take off pass* or a merge can leave that field stale.

`lookupResidualCart()` (per-scan eligibility preview) remains in the service but the board no
longer calls it — validation happens on submit.

## 8. Inventory effects

| Event | PT-CT-104 shell | PT-CT-106 label | PT-CT-112 thermoseal |
|---|---|---|---|
| Start pass | — | — | — |
| Scan cart in (Barcoded) | −1 `consumption` | −1 `consumption` | — |
| Un-scan (Barcoded) | +1 (negative `consumption`) | +1 | — |
| Barcoded → Unpressed | — | — | **members × 3.75 cm off the open roll**; −1 roll `consumption` only when a roll is pulled (`manufacturingRunId = roll id`) |
| Discard / scrap / residual scrap | −1 `scrap` | −1 `scrap` | — (length not returned) |
| Pressed → Backed · wax-fill draw | — | — | — |
| Void pass | net consumption + scrap returned per lot | same | cm credited to roll(s); pulled rolls stay pulled |

All bucket debits carry `manufacturingRunId = cycleId` except roll pulls. Per-lot "N left" =
lot quantity − Σ consumption/scrap rows for that lot.

## 9. UI

### 9.1 `/manufacturing/cart-mfg/buckets` — board, rail, thermoseal, logs

Stage strip (Available · Barcoded · Unpressed · Pressed · **Backed, awaiting oven** — the Backed
tile counts every cart at `backing`, its bucket sub-count the open backed passes) →
5-column board (Available / Barcoded / Unpressed / Pressed / Backed).
Under **Available**: empty buckets only — minting lives on `/buckets/new` (§9.4), reached from
the header *New bucket* button; there is no inline mint card on the board. Every pass card
carries **Audit** (§9.8) under its cart list.
Under **Unpressed**: the yellow *thermoseal not synced* card
and the compact **Thermoseal tile** (§3.4; admin toggles inside "Development settings"). Header
buttons: *New bucket*, *Master override* (admin, §9.5), *Wax filling →*. Rail (start, scan-in box with
mis-scan, advance with discards, scrap by scan, residual by scan, retire) → expandable **change log** (lot, move,
who, discards, thermoseal note) → **bucket log** (every bucket incl. retired). `?stage=` focuses
a column; `?q=` resolves a scan (bucket QR, BKT id, or cartridge id → its bucket).
Below the board + rail: **Find a cart** — scan a cart QR, get one line back (cart id · status
label · the open pass it **belongs in** by membership, or "on no open pass" + where it was last
seen, the legacy WI-01 lot when it has one, and when the status last changed). Read-only,
`?/cartLookup` → `cartStatusLine()`; a bucket sticker scanned there is named as a bucket
rather than reported missing (user, 2026-09-23). The same lookup sits inside the leftover panel
as *Where does this cart belong?* (§7, 2026-09-25).

### 9.2 `/manufacturing/cart-mfg/buckets/[bucketId]`

Passes with per-pass cartridges (in bucket / → on to wax filling / scrapped), source lots,
thermoseal cm, ledger rows, *Replace sticker* link, *Void this pass…* (admin).

### 9.3 Summary views (read-only, deep-link to the board)

- `/cartridge-admin` strip: Barcoded · Unpressed · Pressed (link to the board) · **Backed, awaiting
  oven** (every cart at `backing`; filters the page to `backing`). The
  *Available* tile was removed 2026-09-23 (user: report only the production stages); the
  board's own strip (§9.1) still counts Available buckets.
- `/manufacturing/cart-mfg` **Production Buckets** card beneath the robot grid, same tiles; the
  top-row *Backed* stat counts every cart at `backing`.
- `/manufacturing/cart-mfg/pipeline?stage=bucket_barcoded|bucket_unpressed|bucket_pressed|backing`.
  The `backing` view lists backed bucket passes first, then carts outside a pass grouped per
  legacy WI-01 batch (same status, "awaiting oven"), then legacy `BackingLot` aggregates.

### 9.4 `/manufacturing/cart-mfg/buckets/new` — mint one bucket from one QR

Scan the sticker → `BKT-NNNNNN` minted with that `barcode`. `?bucket=BKT-…` presets *Replace
sticker*. "← Return to previous page." The v1 `print-bucket-labels` page is deleted. This page
(plus the board's *New bucket* header button) is the **only** way to mint a bucket or replace a
sticker — the board's inline Mint card was removed on 2026-09-25, along with its `?/mint` and
`?/relabel` actions.

### 9.5 `/manufacturing/cart-mfg/buckets/override` — Master Override (admin)

Scan a bucket, pick **Barcoded / Unpressed / Pressed / Backed, awaiting oven**, give a reason →
`forceBucketPhase()` puts its open pass there, **bypassing the flow**: no thermoseal
consumption, no discard prompt, no forward-only order (backwards is allowed). The pass stays
open at the target (Backed included — it gets the same `backing.*` stamp as a normal advance and
wax filling draws from it). Nothing is debited or credited. The ledger row, each cart's note and the audit entry (`FORCE_PHASE`) all say
**MASTER OVERRIDE** plus the reason. Live preview of what the scanned code resolves to; table of
open passes with a *use* shortcut. Linked from the board header (red button) and `?bucket=`.

### 9.6 `/manufacturing/cart-mfg/state-change` — per-cart manual override (bucket-aware)

The pre-existing bulk State Change page now routes bucket stages through
`overrideCartStage()`: a target of Barcoded / Unpressed / Pressed / Backed requires a **destination bucket**
(only open passes at that stage are offered) and the cart joins that pass (`merge_in`), leaving
its old one (`merge_out`; an emptied pass closes like a consumed one); any other target removes
a bucket member from its pass. No inventory moves. Unknown barcodes are refused for bucket stages.

### 9.7 Bucket page — retire

*Retire bucket…* on `/buckets/[bucketId]` (admin, reason required, hidden while in use).

### 9.8 Audit a bucket (2026-09-23)

**Audit** on any pass card opens the rail in audit mode: the operator scans *every* cart in the
tub and each scan is classified live (`?/auditScan` → `auditScan()`). **Only the cart just
scanned is shown** (user, 2026-09-23) — a *Just scanned* line with its verdict and an *undo* —
so a 40-cart tub does not become a 40-row list. The counter above it is the tick-off; scans
that still need a decision stay listed under it, newest first and ringed:

| Scan | Shown as | What can be done |
|---|---|---|
| a member of this pass | *belongs here* | ticked off |
| a pre-oven cart that is not a member | *wrong tub* — names the pass it is a member of, if any | **Move** to a destination, or **Discard** |
| past the buckets, unknown, or a bucket sticker | *cannot handle* | must be removed from the list before submitting |

Move destinations for a foreign cart: **its own open pass first** (it is already a member there
— putting it back is recorded, not re-written), then open passes at the cart's stage, then
empty buckets (a fresh pass opens there at that stage; nothing is debited). A move pulls the
cart out of the pass that held it (`merge_out` on that pass) and adds it to the destination
(`merge_in`, or `create` for a new pass). **Discard** requires a journal and behaves like any
other discard: status `scrapped`, a `ManualCartridgeRemoval`, and shell + label scrapped from
inventory at the cart's stage.

Members that were never scanned are listed as **missing** as soon as the first scan lands, one
row each, and every one gets a choice (user, 2026-09-23) — *Keep* (default), *Write off* or
*Take off pass*, with a bulk control for all three:

| Choice | What it does |
|---|---|
| **Keep** | stays a member; the audit records it as missing and the count does not move |
| **Write off** | gone for good: off the pass, status `scrapped`, a `ManualCartridgeRemoval`, shell + label scrapped from inventory at the pass's stage (`scrap` ledger row) |
| **Take off pass** | it is somewhere else: off the pass, still a live cart, so the leftover flow or another bucket's audit can re-home it (`unscan` ledger row) |

Anything removed needs the journal, and the panel says what the count will drop to. A
`shortfall` discrepancy is still pushed onto the cycle, naming how many were kept, written off
and taken off. Nothing is removed unless the operator picks it — an audit never silently
rewrites the count (§7.1). When the panel drops back to the pass view, a **Last audit** box
summarises the run and lists anything still missing and still on the pass.

Every run appends to `BucketCycle.audits` and writes one `audit` ledger row carrying every
scanned id, plus an `AUDIT` audit-log entry. Submitting needs `manufacturing:write`; the
per-scan lookup only needs `manufacturing:read`.

## 10. Files

| File | Role |
|---|---|
| `src/lib/server/db/models/production-bucket.ts`, `bucket-cycle.ts`, `bucket-transaction.ts`, **`thermoseal-roll.ts`** | models |
| `src/lib/server/services/bucket-service.ts` | all bucket logic (create, sticker, start, scanIn/unscan, scrap, advance, consume, **returnCarts**, residual, retire, void, counts, board, logs) |
| **`src/lib/server/services/thermoseal-service.ts`** | config, roll open/consume/credit, floor rule, board status |
| `src/lib/server/kanban/standing.ts` → `ensureThermosealRestockCard` | restock card via the supply autopilot |
| `src/lib/server/notifications.ts` → `notifyThermosealLow` | Resend email to the low-inventory list |
| `src/routes/manufacturing/cart-mfg/buckets/…` | board, history, `new/` |
| ~~`src/routes/manufacturing/cart-mfg/wi-01/…`~~ | **deleted 2026-09-25** (§6.4) |
| `src/routes/manufacturing/cart-mfg/wax-filling/+page.server.ts` | `loadDeck` → `consumeCarts` per backed pass; `revertToBacked` (cancel/abort) → `returnCarts`; `backedBuckets` in load |
| `src/routes/cartridge-admin/…`, `cart-mfg/+page*`, `cart-mfg/+layout.svelte`, `cart-mfg-dev/…`, `cart-mfg/pipeline/…`, `cart-mfg/wax-filling/+page.svelte`, `cart-mfg/lots/[lotId]/…`, both settings pages | oven removal / Backed wording / stage strips / nav |
| Shared code on the scan-in hot path (§6.2.1) — `services/inventory-transaction.ts` (`$inc` debit, part-id cache), `notifications.ts` (`shouldWarnLowInventory` settings cache), `kanban/standing.ts` (`requestSupplyCheckForPart`), `services/cartridge-hard-delete.ts` (`statuses` whitelist), `db/models/inventory-transaction.ts` + `bucket-transaction.ts` (indexes) | **not bucket-only files** — every debit in the app goes through them. Changed 2026-09-25 for scan-in pace; check other callers before changing further. |
| Collision guard (`assertNotBucketLabel` / `findBucketLabels`) | every `CartridgeRecord` genesis path: bucket scan-in, `cv/induct`, `quick-wax-fill`, `state-change`, wax-filling test-mode upsert, reagent-filling stub upsert. **Search for new upserts when adding genesis paths.** |

## 11. Build history

| Commit | What |
|---|---|
| `23b1d6b9` … `b7e2c262` | v1 (2026-09-21/22): count-based buckets, labels, board, residual, WI-01 handoff, dashboard/pipeline views, change + bucket logs |
| `f0e9176a` | Merge of `origin/master` (564 commits); collision guard extended; `findBucketLabels()` |
| `47a2a63d` | `voidCycle()` + *Void this pass…* |
| `fe947207` | No debit on bucket entry; discards remove carts from inventory; yellow note |
| `33a937a4` | Second merge of `origin/master` (magnetometer, SPU validation tracker); PR #54 opened |
| `3f4f49f3` | **v2**: cart membership model, QR-only minting, shells wording, Barcoded → Unpressed → Pressed → In Oven, app-wide oven/cure removal, **thermoseal rolls + 2-roll floor with kanban card + email** |
| `f681ab63` | Floor check on board load + supply sweep (shelf already below the floor) |
| `90bb9a25` | Development toggle: restock notifications off by default; roll tracking always on |
| `c0664759` / `da0daa9f` | Board restructure (Mint card, retire, thermoseal tile) · bucket-aware State Change override (§9.6) |
| `9b06e601` | **Master Override** page — scan a bucket, force it to any phase (§9.5) |
| `fdf00c8e` | **Quarantine category removed** (§3.6/§3.7); `/cartridge-admin` *Available* tile dropped from the bucket strip (§9.3) |
| `64f52310` | **Current thermoseal stock note** above "Development settings" (§3.4); `ThermosealStatus.liveCountAt` |
| `4522ba63` / `8e3e8a67` | Note removed again as redundant with the *Rolls on hand* tile (user); `liveCountAt` reverted; yellow card names `master` as the build draining the shelf |
| `d7e0fe78` | **Find a cart** box under the board — `cartStatusLine()` + `?/cartLookup`, one line of status (§9.1) |
| `3e7bebca` | **Audit a bucket** — scan every cart, move or discard what does not belong (§9.8) |
| `5a01239f` | **Inline Mint card removed** from the board (§9.1/§9.4) — one way in: the *New bucket* button → `/buckets/new`; board `?/mint` + `?/relabel` actions deleted |
| `f21ed50a` | Audit: missing members listed per cart with Keep / Write off / Take off pass, + Last audit summary (§9.8) |
| `6baff520` | Audit: only the cart just scanned is displayed; strays needing a decision stay listed (§9.8) |
| _(this change)_ | **Scan-in lag audit + rebuild** (§6.2.1): queue + membership overlay instead of `invalidateAll()` per cart, input never disabled, client-side merged-read split, batched guards/writes in `scanCartIn`, `resolveBucketId` one query; **mis-scan button fixed** (it had never worked — sacred delete hook); `recordTransaction` now `$inc` (lost-update fix); `createdAt` + `{lotId,transactionType,quantity}` indexes; `checkFloor` throttled on board load; supply check coalesced |
| _(this change)_ | **Leftover panel: *Where does this cart belong?*** search (§7) — scan one leftover, one line back naming the open pass it is a member of; `cartStatusLine()` answers from `BucketCycle.cartridgeIds` membership first (§9.1) |
| `5a01239f` | **`raw` → `barcoded` rename** (§2): stage key, labels, `CartridgeRecord.status`, `LifecycleStage`, pipeline `bucket_barcoded`; old `raw` kept in both enums for historical rows; `scripts/migrate-bucket-raw-to-barcoded.ts` (`--plan` / `--apply`, not yet run). Code swept into the ship-build merge commit; this doc row is the follow-up. |
| _(this change)_ | **WI-01 page removed; fourth stage "Backed, awaiting oven"** (§2, §5.2, §6.3, §6.4, §9): `BUCKET_STAGES` + `BucketCycle.stage` gain `backing`; Pressed → Backed is a normal advance (with the `backing.*` stamp); wax filling's `loadDeck` draws carts out of the pass (`consumeCarts` now requires Backed, `relatedId` = wax run); cancel/abort return them (`returnCarts`, new); `StageCounts.inOven` dropped (the Backed stage count is every cart at `backing`); override `in_oven` target dropped; nav, board, admin strip, dashboard, dev dashboard, pipeline `backing` view relabelled. No data migration: existing `backing` carts count as Backed and are still loadable. A short-lived "Backed, no bucket" tile/count was removed the same day at the user's request. |

`npm run check` after v2: **12 errors / 438 warnings** — the same 12 pre-existing (`r2.ts`,
`AskBimsWidget.svelte`, 8× `assembly/[sessionId]`, 2× `validation/magnetometer/[sessionId]`
from master). None in any file this branch touches.

---

## 12. Open items — read before merging

### 12.1 Verification status

- **No automated tests.** `bucket-service` / `thermoseal-service` have no unit coverage. Most
  worth a test: open-pass uniqueness; advance-with-discard ordering; thermoseal roll-over
  across two rolls; the floor rule firing exactly once per shelf drop.
- **Exercised only by the user on Vercel previews.** Nothing has run in production.
- **Deliberate checks before merge:** (a) scan a bucket's own QR as a cart → refused naming the
  bucket; (b) advance Barcoded → Unpressed with the roll near empty → banner says a roll was pulled,
  ledger shows one −1 PT-CT-112 against the roll id, `thermoseal.segments` has two entries;
  (c) with PT-CT-112 at 2 rolls, pull one → kanban card appears once, email logged once (see
  `/admin/notifications` audit), a second pull adds no second card; (d) void that pass → cm
  credited, roll count unchanged.

### 12.2 Test data and inventory — voiding a pass

Previews write to the configured Atlas database — **unconfirmed whether that is production.**
`voidCycle()` (admin, reason required) reverses the pass's net consumption + scrap per lot with
negative rows of the same type, credits thermoseal length to its rolls, voids the pass's carts
(never deletes), marks its removals, frees the tub. Refused if any member went past the buckets.
**Not reversed:** roll pulls (the roll is open), sticker assignments.

PT-CT-112 was reset to 1 roll on 2026-09-23 (§3.4). The preview shares the kanban board and the
email list with production — **switching the notifications toggle on** while the shelf is below
the floor creates a real card and sends real mail on the next board load.

### 12.3 Decisions still needed from the floor

1. Stage vocabulary (`unpressed` / `pressed`) — labels free, keys are a migration.
2. Bucket sizing — unconstrained by design.
3. Cutover — go-forward only: new shells enter buckets; material already on the floor drains
   through the legacy paths.
4. Thermoseal constants — 3.75 cm / 65 m / floor 2 are in `ManufacturingSettings.thermoseal`
   (no UI yet; defaults in code). **Notifications toggle is off** — turn it on when the build is
   ready for real restock cards and mail. Confirm `leadTimeDays` and `supplier` are filled on the
   PT-CT-112 part so the restock card and email carry a real lead time.

### 12.4 Known risks

- **Backed stage is untested end to end** (2026-09-25). Not yet exercised on a preview: advance
  Pressed → Backed; load a deck from a backed bucket and confirm the pass closes and the tub
  returns to Available; cancel that run and confirm the pass reopens at Backed with the carts
  back in it. `revertToBacked` swallows a `returnCarts` failure (logs it) so a cancel can never
  be blocked by bucket bookkeeping — check the server log if a cancelled run's carts are back at
  `backing` but not back in their bucket.
- **`consumeCarts` callers:** only wax filling's `loadDeck` now. Any other page that moves a cart
  out of `backing` (quick-wax-fill, state-change, cv/induct) leaves it a member of its pass
  unless it goes through `overrideCartStage`; the board's Audit (§9.8) will surface those.

- **Cartridge-admin search** matches cartridge id and legacy lot fields, not
  `backing.bucketBarcode` / `bucket.bucketId` — the history page's "+N more" link finds nothing.
- **Ask BIMS / agent API** do not know buckets or thermoseal rolls exist.
- **Legacy oven readers** (`equipment-status.ts`, `equipment-activity.ts`, cartridge-dashboard,
  equipment location pages, DHR/traceability JSON) still read `backing.ovenLocationId` /
  `ovenEntryTime`; they show nothing for v2 carts, which is correct, but they are dead weight.
- **Thermoseal is not synced with production (2026-09-23).** Production WI-01 on `master` still
  withdraws one PT-CT-112 *unit* per cartridge; this branch counts rolls by length. Every
  production WI-01 batch drags the roll count down (1 → −23 → **−77**, all on 2026-09-23). **User, 2026-09-23: the negative number is a known
  artifact of the build live on `master` and persists until this branch ships** — it is not a
  fault of the bucket flow, and re-counting PT-CT-112 only resets it until the next production
  batch. User
  decision: leave production alone for now; the board carries a yellow "not synced" card and the
  count is re-counted in rolls when needed. **End state (user, 2026-09-23): thermoseal stock is
  universal — one roll-based count consumed by both production WI-01 and the buckets.** The
  hotfix that moves production WI-01 to roll-length
  consumption is **PR #60** — parked until development settles (to stop churning the live
  number), then merged.
- **Inventory counts recorded before 2026-09-25 may sit high.** `recordTransaction` decremented
  `PartDefinition.inventoryCount` by read-compute-`$set`, so two operators debiting the same part
  at the same moment both worked from the same stale read and the second write erased the first.
  It is `$inc` now, but nothing repairs the drift retroactively; the `InventoryTransaction` ledger
  is complete and authoritative, so a physical count (or a re-sum of the ledger) is the fix for
  any part that looks wrong. Shells (PT-CT-104) and labels (PT-CT-106) are the most exposed,
  since a bucket scan-in debits both and scanning is the fastest thing anyone does.
- **Mongoose 9: `schema.pre('deleteOne')` is QUERY middleware**, so the sacred middleware's delete
  hook fires on `Model.deleteOne()`. Anything that reaches for `CartridgeRecord.deleteOne` /
  `deleteMany` throws a 500 (`lib/schema.js` `_getDocumentMiddleware` filters `deleteOne` out
  unless `{ document: true }` was passed). The board's mis-scan button had never once worked for
  this reason, and the client had no `'error'` branch so the operator saw nothing at all — both
  fixed 2026-09-25. Use `hardDeleteUnfinalizedCartridges` (driver-level, audited, takes a
  `statuses` whitelist), never the model's own delete methods.
- **Roll accounting is trust-based**: 3.75 cm is an average; the roll gauge drifts from reality
  over ~1700 carts. A "retire roll early / mark roll exhausted" admin action does not exist yet —
  if a roll runs out before the gauge says so, the operator's only option today is to let the
  next advance pull the next roll (the gauge is then wrong by the remainder).

### 12.5 Deferred / noted

- Thermoseal settings UI; per-roll history page; "retire roll" action.
- WI-01 reminder when Pressed buckets exist but none is selected.
- Wording sweep "tub" → "bucket" outside the Available card.
- Repo is public (`"private": false`).
