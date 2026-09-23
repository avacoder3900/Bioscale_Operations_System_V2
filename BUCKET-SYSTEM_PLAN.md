# Bucket System — Production Buckets, v2 (as built)

**Started:** 2026-09-21 · **Last updated:** 2026-09-23 (v2 restructure + thermoseal rolls)
**Branch:** `feat/bucket-system` — **PR #54 open into `master`**
(https://github.com/avacoder3900/Bioscale_Operations_System_V2/pull/54). `origin/master` has
been merged into this branch twice (last `33a937a4`); it sits on current production code.
**Production branch is `master`** (Vercel deploys prod from it). `NEWDEV` is GitHub's default but
stale; `main` is older still.
**Status:** Built and type-checked; deployed to Vercel preview via the GitHub integration only.
Reviewed by the user on previews; never exercised in production; no automated tests. See §12.
**Scope:** QR-labelled production buckets that carry cartridges through the three stages before
WI-01 — **Raw → Unpressed → Pressed** — after which WI-01 draws them into the oven (**In Oven**
= status `backing`). A cartridge is *born* when its QR sticker is scanned into a bucket. The
system also owns **thermoseal roll tracking** (§3.4) and removed oven/cure-time tracking
app-wide (§3.8).

This document describes what is built. Section numbers are unchanged from the original plan so
code comments citing e.g. "§6.3" still resolve; where v2 replaced a v1 behaviour the text says
so. Per-change narrative and every preview URL live in `progress.txt`.

### What changed in v2 (2026-09-23)

| v1 (2026-09-21/22) | v2 |
|---|---|
| Buckets counted *unserialized* blanks; the cartridge was born at WI-01 scan-in | The cartridge is born at **bucket scan-in** (status `raw`); buckets hold a **membership list** of cartridge ids |
| Stages Raw → Unpressed → Pressed → **QR Scan-In Pending** | Stages **Raw → Unpressed → Pressed**, then **In Oven** (`backing`) via WI-01 |
| Mint many buckets, print BKT barcode labels, home location | Mint **one bucket at a time from one QR scan**; no printing, no location |
| "Blanks" (PT-CT-104) | **"Shells"** (PT-CT-104). The unrelated optical "Blank Cartridge" and the `cartridgeBlankLot` field name are untouched |
| Thermoseal: one PT-CT-112 unit per cart at Unpressed (interim) | Thermoseal **by length off a roll** (§3.4); rolls pulled from inventory; 2-roll floor with kanban + email |
| Backing oven + cure-time gate in WI-01, wax filling, dashboard, pipeline | **Removed app-wide.** No oven is chosen; nothing is time-gated |

---

## 1. The gap this fills

Before v1 nothing tracked material between receiving and the WI-01 scan: shells (PT-CT-104)
and labels (PT-CT-106) left inventory only when WI-01 scanned a cartridge, so pressing WIP was
invisible, discards before WI-01 were never debited, and "how many carts are on the floor" was a
walk. v2 goes further: because the QR sticker goes on the **raw** shell, the cartridge record
exists from the first stage and every later system (cartridge-admin, traceability, DHR) sees it.

### 1.1 The dead ancestor

`BackingLot` (`backing_lots`) was the old "tub of cartridges in an oven" aggregate. It is still
read read-only where legacy rows exist (pipeline In Oven view, equipment pages) and is never
written by the bucket system.

## 2. The stages

| Key | Label | What is physically true |
|---|---|---|
| `raw` | Raw | Shells with QR stickers on, scanned into the bucket one at a time |
| `unpressed` | Unpressed | Bucket staged for the press. **Thermoseal is consumed here** (§3.4) |
| `pressed` | Pressed | Off the press; WI-01 may draw from it |
| — | In Oven | `CartridgeRecord.status = 'backing'`. Not a bucket stage: WI-01 scanned it out |

Each cartridge's `status` mirrors its bucket's stage while it is a member, so
`/cartridge-admin?stage=raw|unpressed|pressed` filters real records.

### 2.1 Pressing — no SOP exists

`unpressed` / `pressed` are still the working names; there is no pressing SOP in the repo. The
"which press" prompt was removed on 2026-09-22.

## 3. Locked decisions

### 3.1 Whole-bucket advancement only

A bucket moves as a unit. At every advance the operator is asked **"Any carts discarded?"** and
scans each discarded cart; those are scrapped (§8) before the move so the rest move together.
Bucket size does **not** have to match a press run or a WI-01 session; WI-01 may draw part of
a bucket (partial consumption) and the remainder stays Pressed.

### 3.2 Buckets and their ids are reusable

`ProductionBucket._id` (`BKT-NNNNNN`) is permanent; the QR sticker (`barcode`) is replaceable at
`/manufacturing/cart-mfg/buckets/new?bucket=BKT-…`. Each use is a **pass** (`BucketCycle`,
`cycleNumber` increments). The `bucketId → open pass` uniqueness is a partial unique index.

### 3.3 Inventory is debited at scan-in — the scan is the truth

Yellow note on the board: **"Inventory is not Debited Until Carts are Scanned in."**

- Scanning a cart into a Raw bucket debits **1 × PT-CT-104 (shell) + 1 × PT-CT-106 (label)**
  from the lots chosen when the pass was started, and creates the `CartridgeRecord`.
- A mis-scan can be **un-scanned** while the pass is still Raw: the record is deleted and both
  debits are retracted (negative rows of the same type, §8).
- A discarded cart (at advance, via *Scrap*, or as a residual) writes a `scrap` transaction for
  its shell and label. **Thermoseal length is not returned** — it is consumed material.
- WI-01 (In Oven) debits nothing.

### 3.4 Thermoseal — consumed by length off a roll (2026-09-23)

*Replaces v1's "out of scope" and the interim one-unit-per-cart debit.*

PT-CT-112 is stocked in **rolls** and used by **length**:

| Rule | Value | Where |
|---|---|---|
| Length per cartridge (averaged for excess) | **3.75 cm** | `ManufacturingSettings.thermoseal.cmPerCartridge` (default in `thermoseal-service.ts`) |
| Length per roll | **65 m = 6500 cm** (≈ 1733 carts) | `…thermoseal.rollLengthCm` |
| Floor: rolls that must stay in inventory | **2** | `…thermoseal.minRollsInInventory` |
| When consumed | **Raw → Unpressed**, members × 3.75 cm | `bucket-service.advanceCycle` → `consumeThermoseal` |
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

**Cutover:** PT-CT-112 `inventoryCount` was −427 from the interim per-cart debits; a physical
count of **1 roll** was recorded on 2026-09-23 (MCP `record_physical_count`, Samantha Wolf).
The shelf is therefore already below the floor; the restock card + email stay off until the
development toggle is switched on. The part is named "Thermoseal Laser Cut sheet" in parts; the
unit of measure should read "roll".

### 3.5 Auto-release with deferred spot-check

When WI-01 draws the last member, the pass closes and the bucket returns to *Available* with
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

- WI-01 no longer picks an oven; `backing.oven*` and `ovenEntryTime` are **LEGACY** fields (kept
  for old rows, never written). `backing.recordedAt` is the scan time.
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

`bucketId` · `cycleNumber` · `stage` raw | unpressed | pressed (`qr_pending` kept in the enum
for v1 rows) · **`cartridgeIds: string[]`** (members) · `quantity` (= length) · `openedQty`
(fixed when leaving Raw; shrinkage = openedQty − quantity) · `sourceLots[{partNumber, lotId,
scannedAt}]` · **`thermoseal { cm, cartridges, segments[{rollId, cm}], consumedAt }`** · `status`
open | consumed | scrapped | voided (+ `voidedAt/By/Reason`, `statusBeforeVoid`) ·
`residualFound { cartridgeIds, disposition, … }` · `discrepancies[]` · `stageEnteredAt` ·
`openedBy/At`, `closedAt`. Partial unique index `{bucketId}` where `status: 'open'`; index
`{cartridgeIds: 1}`.

### 4.3 `BucketTransaction` → `bucket_transactions` (immutable)

Types: `mint, relabel, create, scan_in, unscan, advance, adjust, scrap, consume, merge_in,
merge_out, release, quarantine, retire, void`. Carries `cartridgeIds` for the rows that touch
carts. The `advance` row into Unpressed stores the thermoseal note (cm, roll ids, rolls pulled)
in `reason` and the first roll id in `relatedId`.

### 4.4 Changes to existing models (fields only)

- `CartridgeRecord`: status enum gains `raw, unpressed, pressed` (before `backing`);
  `bucket { bucketId, cycleId, scannedInAt, scannedInBy }`; `backing.bucketCycleId/bucketBarcode`;
  oven fields LEGACY. Index `{ 'bucket.cycleId': 1 }` sparse.
- `ManualCartridgeRemoval`: `bucketCycleId`, `bucketId`, `journal`, `voidedAt`, `voidReason`.
- `LotRecord`: `bucketCycleId`.
- `ManufacturingSettings.thermoseal { cmPerCartridge, rollLengthCm, minRollsInInventory }`.
- **New** `ThermosealRoll` (§3.4).
- `cartridge-admin/queries.ts` `LifecycleStage` gains `raw | unpressed | pressed`.

## 5. State machines

### 5.1 Bucket

`available —start→ in_use —last member drawn / all discarded→ available (spotCheckPending)`;
`available —retire (admin)→ retired`. (`quarantined` is legacy only — no transition into it.)

### 5.2 Pass

`open@raw —advance→ open@unpressed —advance→ open@pressed —WI-01 draws all→ consumed`;
`open —all members discarded→ scrapped`; `open|consumed|scrapped —void (admin)→ voided`.

## 6. Flows

### 6.1 Start a pass

Rail → pick an Available bucket → choose the **shell lot (104)** and **label lot (106)** →
confirm empty if `spotCheckPending`. Opens at Raw with 0 members. Nothing is debited yet.

### 6.2 Scan carts in (Raw only)

Scan a QR sticker → `scanCartIn`: the sticker must not be a bucket label (collision guard) or an
existing cartridge; a `CartridgeRecord` is created at `raw` with `bucket.*`; 1 × shell + 1 ×
label debited. A mis-scan button un-scans (record deleted, debits retracted).

### 6.3 Advance (with discard)

"Any carts discarded?" scan list + journal → discards scrapped first → all remaining members'
`status` follows the bucket. **Raw → Unpressed** additionally runs `consumeThermoseal` (§3.4)
and shows the result banner (cm taken, rolls pulled, floor alert). **Pressed** is the end of the
bucket: WI-01 draws from it.

### 6.4 WI-01 handoff (bucket-fed)

`/manufacturing/cart-mfg/wi-01`: scan or pick a **Pressed** bucket → session lists its members →
scan each one (or *Take all*) → the cart leaves the bucket (`consumeCarts`) and becomes
`backing` (In Oven) with `backing.recordedAt/operator/bucketCycleId/bucketBarcode` and a
`LotRecord` per session. Confirm-complete scraps any carts scanned but binned. No oven, no
inventory withdrawal, no time gate. Removing a scanned cart from the session puts it back into
the bucket (reopens the pass if it had closed).

## 7. Residual flow

Scan-based (§3.6). A residual is always a **membership discrepancy** — the scanned carts are
real records whose status says which stage they were at — so merge/scrap act on ids, and the
`residualFound` block on the previous pass records the ids and disposition.

## 8. Inventory effects

| Event | PT-CT-104 shell | PT-CT-106 label | PT-CT-112 thermoseal |
|---|---|---|---|
| Start pass | — | — | — |
| Scan cart in (Raw) | −1 `consumption` | −1 `consumption` | — |
| Un-scan (Raw) | +1 (negative `consumption`) | +1 | — |
| Raw → Unpressed | — | — | **members × 3.75 cm off the open roll**; −1 roll `consumption` only when a roll is pulled (`manufacturingRunId = roll id`) |
| Discard / scrap / residual scrap | −1 `scrap` | −1 `scrap` | — (length not returned) |
| WI-01 draw (In Oven) | — | — | — |
| Void pass | net consumption + scrap returned per lot | same | cm credited to roll(s); pulled rolls stay pulled |

All bucket debits carry `manufacturingRunId = cycleId` except roll pulls. Per-lot "N left" =
lot quantity − Σ consumption/scrap rows for that lot.

## 9. UI

### 9.1 `/manufacturing/cart-mfg/buckets` — board, rail, thermoseal, logs

Stage strip (Available · Raw · Unpressed · Pressed · **In Oven** (links to
`/cartridge-admin?stage=backing`)) → 4-column board (Available / Raw / Unpressed / Pressed).
Under **Available**: the **Mint New Bucket** card (→ `/buckets/new`, and *Replace a damaged
sticker* → `/buckets/new#replace`). Under **Unpressed**: the yellow *thermoseal not synced* card
and the compact **Thermoseal tile** (§3.4; admin toggles inside "Development settings"). Header
buttons: *New bucket*, *Master override* (admin, §9.5), *WI-01 →*. Rail (start, scan-in box with
mis-scan, advance with discards, scrap by scan, residual by scan, retire) → expandable **change log** (lot, move,
who, discards, thermoseal note) → **bucket log** (every bucket incl. retired). `?stage=` focuses
a column; `?q=` resolves a scan (bucket QR, BKT id, or cartridge id → its bucket).

### 9.2 `/manufacturing/cart-mfg/buckets/[bucketId]`

Passes with per-pass cartridges (in bucket / → into the oven / scrapped), source lots,
thermoseal cm, ledger rows, *Replace sticker* link, *Void this pass…* (admin).

### 9.3 Summary views (read-only, deep-link to the board)

- `/cartridge-admin` strip: Available · Raw · Unpressed · Pressed · **In Oven** (filters the page).
- `/manufacturing/cart-mfg` **Production Buckets** card beneath the robot grid, same tiles.
- `/manufacturing/cart-mfg/pipeline?stage=bucket_raw|bucket_unpressed|bucket_pressed|backing`.

### 9.4 `/manufacturing/cart-mfg/buckets/new` — mint one bucket from one QR

Scan the sticker → `BKT-NNNNNN` minted with that `barcode`. `?bucket=BKT-…` presets *Replace
sticker*. "← Return to previous page." The v1 `print-bucket-labels` page is deleted.

### 9.5 `/manufacturing/cart-mfg/buckets/override` — Master Override (admin)

Scan a bucket, pick **Raw / Unpressed / Pressed / In Oven**, give a reason → `forceBucketPhase()`
puts its open pass there, **bypassing the flow**: no thermoseal consumption, no discard prompt,
no forward-only order (backwards is allowed), and *In Oven* moves every member to `backing` with
no WI-01 session or LotRecord and closes the pass like a consumed one. Nothing is debited or
credited. The ledger row, each cart's note and the audit entry (`FORCE_PHASE`) all say
**MASTER OVERRIDE** plus the reason. Live preview of what the scanned code resolves to; table of
open passes with a *use* shortcut. Linked from the board header (red button) and `?bucket=`.

### 9.6 `/manufacturing/cart-mfg/state-change` — per-cart manual override (bucket-aware)

The pre-existing bulk State Change page now routes bucket stages through
`overrideCartStage()`: a target of Raw / Unpressed / Pressed requires a **destination bucket**
(only open passes at that stage are offered) and the cart joins that pass (`merge_in`), leaving
its old one (`merge_out`; an emptied pass closes like a consumed one); any other target removes
a bucket member from its pass. No inventory moves. Unknown barcodes are refused for bucket stages.

### 9.7 Bucket page — retire

*Retire bucket…* on `/buckets/[bucketId]` (admin, reason required, hidden while in use).

## 10. Files

| File | Role |
|---|---|
| `src/lib/server/db/models/production-bucket.ts`, `bucket-cycle.ts`, `bucket-transaction.ts`, **`thermoseal-roll.ts`** | models |
| `src/lib/server/services/bucket-service.ts` | all bucket logic (create, sticker, start, scanIn/unscan, scrap, advance, consume, residual, retire, void, counts, board, logs) |
| **`src/lib/server/services/thermoseal-service.ts`** | config, roll open/consume/credit, floor rule, board status |
| `src/lib/server/kanban/standing.ts` → `ensureThermosealRestockCard` | restock card via the supply autopilot |
| `src/lib/server/notifications.ts` → `notifyThermosealLow` | Resend email to the low-inventory list |
| `src/routes/manufacturing/cart-mfg/buckets/…` | board, history, `new/` |
| `src/routes/manufacturing/cart-mfg/wi-01/…` | bucket-fed WI-01 |
| `src/routes/cartridge-admin/…`, `cart-mfg/+page*`, `cart-mfg-dev/…`, `cart-mfg/pipeline/…`, `cart-mfg/wax-filling/…`, `cart-mfg/lots/[lotId]/…`, both settings pages | oven removal / In Oven wording / stage strips |
| Collision guard (`assertNotBucketLabel` / `findBucketLabels`) | every `CartridgeRecord` genesis path: bucket scan-in, `cv/induct`, `quick-wax-fill`, `state-change`, wax-filling test-mode upsert, reagent-filling stub upsert. **Search for new upserts when adding genesis paths.** |

## 11. Build history

| Commit | What |
|---|---|
| `23b1d6b9` … `b7e2c262` | v1 (2026-09-21/22): count-based buckets, labels, board, residual, WI-01 handoff, dashboard/pipeline views, change + bucket logs |
| `f0e9176a` | Merge of `origin/master` (564 commits); collision guard extended; `findBucketLabels()` |
| `47a2a63d` | `voidCycle()` + *Void this pass…* |
| `fe947207` | No debit on bucket entry; discards remove carts from inventory; yellow note |
| `33a937a4` | Second merge of `origin/master` (magnetometer, SPU validation tracker); PR #54 opened |
| `3f4f49f3` | **v2**: cart membership model, QR-only minting, shells wording, Raw → Unpressed → Pressed → In Oven, app-wide oven/cure removal, **thermoseal rolls + 2-roll floor with kanban card + email** |
| `f681ab63` | Floor check on board load + supply sweep (shelf already below the floor) |
| `90bb9a25` | Development toggle: restock notifications off by default; roll tracking always on |

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
  bucket; (b) advance Raw → Unpressed with the roll near empty → banner says a roll was pulled,
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

- **Cartridge-admin search** matches cartridge id and legacy lot fields, not
  `backing.bucketBarcode` / `bucket.bucketId` — the history page's "+N more" link finds nothing.
- **Ask BIMS / agent API** do not know buckets or thermoseal rolls exist.
- **Legacy oven readers** (`equipment-status.ts`, `equipment-activity.ts`, cartridge-dashboard,
  equipment location pages, DHR/traceability JSON) still read `backing.ovenLocationId` /
  `ovenEntryTime`; they show nothing for v2 carts, which is correct, but they are dead weight.
- **Thermoseal is not synced with production (2026-09-23).** Production WI-01 on `master` still
  withdraws one PT-CT-112 *unit* per cartridge; this branch counts rolls by length. Every
  production WI-01 batch drags the roll count down (1 → −23 was seen on 2026-09-23). User
  decision: leave production alone for now; the board carries a yellow "not synced" card and the
  count is re-counted in rolls when needed. **End state (user, 2026-09-23): thermoseal stock is
  universal — one roll-based count consumed by both production WI-01 and the buckets.** The
  hotfix that moves production WI-01 to roll-length
  consumption is **PR #60** — parked until development settles (to stop churning the live
  number), then merged.
- **Roll accounting is trust-based**: 3.75 cm is an average; the roll gauge drifts from reality
  over ~1700 carts. A "retire roll early / mark roll exhausted" admin action does not exist yet —
  if a roll runs out before the gauge says so, the operator's only option today is to let the
  next advance pull the next roll (the gauge is then wrong by the remainder).

### 12.5 Deferred / noted

- Thermoseal settings UI; per-roll history page; "retire roll" action.
- WI-01 reminder when Pressed buckets exist but none is selected.
- Wording sweep "tub" → "bucket" outside the Available card.
- Repo is public (`"private": false`).
