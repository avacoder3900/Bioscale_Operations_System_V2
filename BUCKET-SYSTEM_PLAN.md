# Bucket System — Production Buckets, v2 (as built)

**Started:** 2026-09-21 · **Last updated:** 2026-10-05 (**one badge per pass** — the board drops the badge when the rail moves to another pass, §6.6; **In oven: Copy all ids**, §6.5; **badge on the rest of the bucket actions** — mint, start pass, un-scan, sticker replace, retire, void, Master Override and State Change's bucket moves, §6.6; 2026-10-02: **State Change: straight to Backed, no bucket**, §9.6; **Pressed stage removed** — Unpressed advances straight to Backed, §2; **scan-in count lag** — the count moves on Enter, not on the server's confirm, §6.2.1; **badge at every phase** — every advance is now gated too, §6.3/§6.6; 2026-09-30: **badge gate moved** to scan-in / discards / move to oven, §6.6; earlier that day page-to-page **navigation lag** fixes, §9.1/§9.2/§11, and bucket **nicknames**, §4.1; before that 2026-09-25: thermoseal one roll part; fourth bucket stage **Backed** with **Move to oven**)
**Branch:** `feat/bucket-system` — **PR #54 open into `master`**
(https://github.com/avacoder3900/Bioscale_Operations_System_V2/pull/54). `origin/master` has
been merged into this branch twice (last `33a937a4`); it sits on current production code.
**Production branch is `master`** (Vercel deploys prod from it). `NEWDEV` is GitHub's default but
stale; `main` is older still.
**Status:** Built and type-checked; deployed to Vercel preview via the GitHub integration only.
Reviewed by the user on previews; never exercised in production; no automated tests. See §12.
**Scope:** QR-labelled production buckets that carry cartridges through three stages —
**Barcoded → Unpressed → Backed** (status `backing`) — after which the
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
| ~~`pressed`~~ | Pressed | **Removed 2026-10-02** (user: an added layer of redundancy — pressing and backing happen in one go). No longer a board stage; see the callout below for rows still at it |
| `backing` | Backed | A storage stage: the tub sits on the shelf. **End of the bucket:** *Move to oven* frees the carts and returns the tub (§6.5) — or wax filling's deck load draws carts straight out (§6.4). The stage key is the cart status wax filling already accepts |

Each cartridge's `status` mirrors its bucket's stage while it is a member, so
`/cartridge-admin?stage=barcoded|unpressed|backing` filters real records (`pressed` still filters historical rows).

> **Unpressed is two board lanes since 2026-10-05 (user: "it's kind of confusing what's happening
> to a bucket at any given moment").** The board reads Available → Barcoded → **Unpressed**
> (waiting) → **Unpressed — in process** → Backed (a narrow column; it is storage). Marking a
> Barcoded bucket *Done* is the old Barcoded → Unpressed advance (thermoseal still taken there) and
> lands it in the waiting lane. An operator then **pulls** it into in process with their badge
> (`bucket-service.pullIntoProcess`, action `?/pull`, ledger type `pull`): that is the attribution
> point and the custody handoff — the open `Custody` row is released as `takeover` and a new one is
> opened for the puller; `BucketCycle.inProcessAt` / `inProcessBy` are set. Only a pulled pass can
> be marked *Done* → Backed (`advanceCycle` refuses a waiting one, code `NOT_PULLED`). **No new
> stage and no new cart status:** both lanes are stage/status `unpressed`; every stage change
> clears the in-process fields. The board drops the held badge after every advance, so each lane
> change takes a fresh badge scan. Same day: the counter tiles above the board were removed and the
> right-hand rail (scan box + bucket panel) became a horizontal strip in their place.

> **Pressed stage removed 2026-10-02.** Unpressed now advances straight to Backed. `BUCKET_STAGES`
> is `barcoded | unpressed | backing`; the key `pressed` stays in the `BucketCycle.stage` and
> `CartridgeRecord.status` enums so historical rows validate (`LEGACY_PRESSED_STAGE`). Anything
> still sitting at it is handled without a data migration: `isBucketStatus()` counts a legacy
> pressed cart/pass as inside the bucket system (residual, audit, void, state-change all accept it);
> `boardStage()` lists a legacy pressed pass in the **Unpressed** column and folds it into the
> Unpressed strip count; `nextStage('pressed')` is Backed, so its Advance button moves it on with
> the normal `backing.*` stamp and **no thermoseal** (that was taken when it entered Unpressed);
> `stageLabel()` shows it as "Pressed (legacy)" in cart lookups. Nothing writes `pressed` any more:
> the override page and the state-change page no longer offer it as a target.

> **Backed stage added 2026-09-25.** Before this, Pressed was the end of the bucket and a
> separate WI-01 page (scan bucket → session → scan/take-all → confirm) moved carts to `backing`
> one batch at a time, creating a `LotRecord` per session. The user judged the oven structure
> redundant and too many clicks: after pressing, carts just sit in a "backed" holding phase until
> the wax-fill operator places them in the oven and loads the deck. **Oven placement and time
> gating are disabled, not modelled** — nothing records which oven or when; it may return later.
> **One category (user, 2026-09-25):** every cart at `backing` is *Backed*,
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

`unpressed` is still the working name (`pressed` was dropped 2026-10-02); there is no pressing SOP in the repo. The
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
  from the lots fixed when the pass was started (the shell lot the operator picked; the label lot
  the system took FIFO — §6.1), and creates the `CartridgeRecord`.
- A mis-scan can be **un-scanned** while the pass is still Barcoded: the record is deleted and both
  debits are retracted (negative rows of the same type, §8).
- A discarded cart (at advance, via *Scrap*, or as a residual) writes a `scrap` transaction for
  its shell and label. **Thermoseal length is not returned** — it is consumed material.
- Unpressed → Backed and the wax-fill draw debit nothing.

### 3.4 Thermoseal — ONE part, counted ONLY in rolls, moved ONLY at the bucket phase (2026-09-25)

*Replaces v1's "out of scope", the interim one-unit-per-cart debit, and the 2026-09-23 roll model
that still sat on PT-CT-112 next to a per-cart production debit and a laser-cut sheet count.*

**User, 2026-09-25: "completely overhaul the thermoseal inventory so that it ONLY counts at the
bucket phase, and that it is only counted by the roll … we do not need to track the laser cut
sheet at all, that inventory is now stale."**

| Rule | Value | Where |
|---|---|---|
| The thermoseal part | **PT-CT-101 "Thermoseal Roll"** (`THERMOSEAL_PART`) — the roll SKU receiving books rolls into | `thermoseal-service.ts`; re-exported by `bucket-service.ts` |
| Unit of the count | **rolls**, nothing else | `PartDefinition.inventoryCount`, `unitOfMeasure: 'roll'` |
| What moves the count | **only** the bucket board's roll pull (`openRoll`, −1 `consumption`, `manufacturingRunId = roll id`) and receiving | — |
| Length per cartridge (averaged for excess) | **3.75 cm** | `ManufacturingSettings.thermoseal.cmPerCartridge` |
| Length per roll | **65 m = 6500 cm** (≈ 1733 carts) | `…thermoseal.rollLengthCm` |
| Floor: rolls that must stay in inventory | **2** | `…thermoseal.minRollsInInventory` |
| When length is consumed | **Barcoded → Unpressed**, members × 3.75 cm | `bucket-service.advanceCycle` → `consumeThermoseal` |
| **Development toggle** — restock notifications | **OFF** by default | `…thermoseal.notificationsEnabled`; admin checkbox on the board's Thermoseal tile |

- **Retired: PT-CT-111 "Thermoseal Cut Sheet" and PT-CT-112 "Thermoseal Laser Cut sheet".** No
  page writes to them any more. `cut-thermoseal` (roll −1 / cut sheets +N), `wi-02` (orphan
  "strips" creation) and `laser-cutting` (cut sheets −N / laser-cut strips +N×16 / ReceivingLot
  mirror / legacy `ManufacturingMaterial` "laser cut substrates" counter) are **run logs only**;
  their inventory tiles are gone. Wax filling never touched thermoseal. The consumables overview
  no longer derives "individual backs" from a sheet count.
- **The development pin is gone.** `rollsOnHandPinned` / `rollsOnHandOverride` were removed from
  the settings schema, the service, the board action and the tile; `setThermosealToggles`
  `$unset`s them. The tile shows the live PT-CT-101 count. The yellow "not synced" card is gone
  with it — the board no longer reads the part the live `master` build debits per cart.
- `ThermosealRoll` (`thermoseal_rolls`) is one physical roll: `lengthCm`, `consumedCm`,
  `status` active | exhausted | retired, `lotId`, `openedBy/At`, `openedForCycleId`,
  `inventoryTxId`. At most one roll is `active`. `partNumber` defaults to PT-CT-101.
- **A roll is pulled from inventory only when the open roll runs out** (or on the very first
  advance). The lot is always the **oldest accepted PT-CT-101 lot with stock** (FIFO by the
  ledger) — the advance form no longer offers a lot picker (user, 2026-09-25: "this can occur
  in the background but causes too much friction"); `advanceCycle` still accepts
  `thermosealLotId` for callers that want to name one. Voiding a pass never puts an opened
  roll back on the shelf.
- A bucket larger than the roll's remainder rolls over onto the next roll (and again if needed);
  the pass records `thermoseal.segments = [{ rollId, cm }]`.
- **Floor rule.** `checkFloor()` runs after every pull, on every bucket-board load (throttled) and
  in the kanban supply sweep. It reads PT-CT-101 `inventoryCount` (rolls); the board always shows
  the below-floor state. **Only while the notifications toggle is on**, a shelf below
  `minRollsInInventory` also gets one **kanban restock card** (`ensureThermosealRestockCard`,
  idempotent on `sourceRef thermoseal-restock:<partId>`, lead-time warning in the body) and one
  email to the **low-inventory list** (`notifyThermosealLow`, only on the pull that created the
  card).
- **Void** (§12.2) credits the pass's segments back to their rolls (`creditThermoseal`); an
  exhausted roll becomes active again only if no other roll is open.
- The board's **Thermoseal tile** (under Unpressed): open roll gauge (m left, ≈ carts left, lot),
  rolls on hand (live PT-CT-101) vs. the floor, the lot the next roll would come from, restock
  state, and the notifications toggle under "Development settings". The advance form shows
  nothing about thermoseal — the length comes off in the background; the tile and the
  post-move banner are the only places it surfaces.

**Cutover — `scripts/migrate-thermoseal-roll-only.ts` (`--plan` / `--apply`, not yet run):**
renames PT-CT-101 to "Thermoseal Roll" with `unitOfMeasure: 'roll'`, sets PT-CT-111 and PT-CT-112
`isActive: false`, relabels existing `thermoseal_rolls` to PT-CT-101, and reports any open
restock card for the old part id. It does **not** touch any count: after it runs, **record a
physical count of rolls on PT-CT-101** — **user, 2026-09-25: exactly 1 roll on hand**, not the
113 "ea" the part read from the old cut-thermoseal debits; that count is recorded via the MCP
`record_physical_count` (see progress.txt for the timestamp), and with the 2-roll floor the tile
shows *below floor* until rolls are received (notifications off, so no card or mail); PT-CT-112's −228 is left behind and no longer read). Until this branch
ships, the live `master` build keeps debiting PT-CT-112 per cart — that part is now retired
here and nothing on this branch reads it, so the drift is invisible to the board (§12.4).

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

`_id` BKT-NNNNNN · `barcode` (QR, unique sparse) · **`nickname`** (optional, ≤30 chars, 2026-09-30) ·
`state` available | in_use | quarantined | retired · `currentCycleId` · `cycleCount` ·
`spotCheckPending` · `residualNote` · `retiredAt/Reason` · `createdBy` · `homeLocation` (LEGACY,
unused in v2).

**Nickname (2026-09-30).** A human name for the tub ("Big Blue"), shown in place of the sticker on
board cards, panels and the registry, with the BKT id always underneath. Display only: nothing
resolves a *scan* by nickname (`resolveBucketId` is unchanged), so a typo can never send carts into
the wrong bucket; the board's scan box and `resolveScan` list it as a *search* hit. Unique
(case-insensitive) among non-retired buckets — a retired tub releases its name. Set from the *Nickname a bucket* block on
`/buckets/new` (§9.4) or any time from the history page (§9.2) by any `manufacturing:write` user, in any state
but retired; blank clears it. Every set/change/clear is a `nickname` ledger row + `NICKNAME` audit.

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

Types: `mint, relabel, nickname, create, scan_in, unscan, advance, adjust, scrap, consume, merge_in,
merge_out, release, quarantine, retire, void, audit, oven`. Carries `cartridgeIds` for the rows that touch
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

`open@barcoded —advance→ open@unpressed —advance→ open@backing —wax filling loads the last member→ consumed`
(a pre-2026-10-02 pass still at `open@pressed` advances to `open@backing` the same way);
`consumed@backing —wax run cancelled/aborted, tub still free→ open@backing` (`returnCarts`, §6.4);
`open —all members discarded→ scrapped`; `open|consumed|scrapped —void (admin)→ voided`.

## 6. Flows

### 6.1 Start a pass

Rail → pick an Available bucket → choose the **shell lot (104)** →
confirm empty if `spotCheckPending`. Opens at Barcoded with 0 members. Nothing is debited yet.
**The label lot (106) is no longer picked (2026-10-05, user: "all I care about at the barcoding
stage is selecting the shell lot").** `startCycle` takes the oldest PT-CT-106 lot with stock (FIFO,
`lot-remaining.fifoLot`) and fixes it on the pass, so labels are still debited per scan and
`backing.barcodeLabelLot` is still stamped. With no label lot in stock the pass opens without one
and the label debit carries no lot.
**Badge-gated again since 2026-10-05** (§6.6; it was ungated from 2026-09-30 to then): the badge
box is the first field of the start form, and the badge holder is `openedBy`, `emptyConfirmedBy`
and the operator on the `create` row. The pass's `Custody` row is still claimed by whoever scans
the first cart in, not at start. The badge stays on for the cart scans that follow.

### 6.2 Scan carts in (Barcoded only)

**Badge-gated (§6.6).** Scan your badge into the panel's badge box (or straight into the cart
box — a `BDG-` code is routed to the badge box), then the carts. The badge is sent with every
scan-in POST; the badge holder is `scannedInBy`, the operator on the two debits and the
`scan_in` ledger row (`enteredBy` = session, `attribution.method = 'badge'`), and — at the
**first** scan of the pass — the pass's `Custody` holder (`claimCustody`, `custodyId` on the
pass). Scan a QR sticker → `scanCartIn`: the sticker must not be a bucket label (collision
guard), a merged double-read, a badge, or an existing cartridge; a `CartridgeRecord` is created
at `barcoded` with `bucket.*`; 1 × shell + 1 × label debited. A mis-scan button un-scans (record
deleted, debits retracted; **not** gated) — see §6.2.1 for why that delete needs the
driver-level path.

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
- **The count moves on Enter, not on confirm** (2026-10-02). Confirms arrive one at a time and each
  is a full round trip (session, badge, guards, cart insert, two debits, log rows — ~8 hops in
  series), so with the gun at a cart a second the card count and the stage tile trailed the gun by
  the length of the queue. A third overlay, `scanPending` (keyed by cycle id), takes the code the
  moment it is queued and counts exactly like `scanAdded`; on confirm the id moves to `scanAdded`,
  on failure it is dropped (`settlePending`), so the count visibly steps back by one and the code
  is in the "did not take" list. The queued-check now runs before the membership check, because a
  pending id is already a member through the overlay. The server path is unchanged.
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

"Any carts discarded?" scan list + journal → **badge** (§6.6 — **required at every advance since
2026-10-02**, discards or not; one scan signs the discards and the `advance` row alike. From
2026-09-30 to 2026-10-02 the box appeared only when the discard list was non-empty and the move
alone was not gated) → discards scrapped first → all remaining members'
`status` follows the bucket. **Barcoded → Unpressed** additionally runs `consumeThermoseal` (§3.4)
silently — nothing about thermoseal appears on the form itself — and shows the result banner
(cm taken, rolls pulled, floor alert) after the move. **Unpressed → Backed** stamps
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

### 6.5 Move to oven (2026-09-25)

**User:** "Just name it backed and when it passes to the next phase all it should functionally do is
move the bucket back to available, and free all of the carts from that location. Have a short drop
down list of 'in oven' but do not create a separate card for this. Carts will leave this status when
they get scanned in for wax filling. Functionally the cart statuses will all remain the same:
pressed → backed → wax filled. Backed in the bucket system just refers to a storage system."

On a **Backed** pass card the panel's primary button is **Move to oven (N carts)** → `?/moveToOven` →
`bucket-service.moveToOven`. **Badge-gated (§6.6):** the badge box sits above the button; the
holder is `ovenReleasedBy` and the operator on the `oven` row. It does two things and nothing else:

1. the pass closes (`consumed`, `ovenReleasedAt` / `ovenReleasedBy` on the pass, one `oven` change-log
   row with the cart ids, a `MOVE_TO_OVEN` audit row) and the tub returns to **Available** (with the
   usual deferred spot-check, §3.5);
2. the carts are freed from the bucket — **no cart is written**. They keep status `backing` until wax
   filling scans them in (§6.4); a cancelled wax run leaves them loose rather than reopening the pass
   (`returnCarts` checks `ovenReleasedAt`).

**In oven** is a short `<details>` dropdown at the bottom of the board's Backed column, not a card and
not a status: `inOvenCarts()` = carts at `backing` on no open pass (freed by Move to oven, returned by a
cancelled run, or drawn by the old WI-01 page), count + up to 200 ids. A **Copy all N ids** button
in the dropdown (user, 2026-10-05; `?/inOvenList`, read-only, `manufacturing:read`) fetches the whole
list — not just the 200 shown — and puts it on the clipboard and in a box, one id per line, the shape
State Change's cart box takes. The Backed stage count stays
*every cart at `backing`* (§2, one category). The board's five columns are one row wide from `md` up,
so Backed sat beside Pressed (four columns since the Pressed column was removed 2026-10-02, §9.1).

### 6.6 Where the badge is asked for (2026-09-30; every phase since 2026-10-02; every operator action since 2026-10-05)

**User (2026-10-05), after an audit of where the badge scan could be used:** implement the
ungated bucket actions — the Master Override, void / retire / sticker replace, and mint / start
pass / un-scan. This **reverses the 2026-09-30 decision** that took the badge off mint and
start-pass. The steps added on 2026-10-05 (branch `feat/badge-all-bucket-actions`):

| Step | Where | Holder must have | What the holder becomes |
|---|---|---|---|
| **Mint a bucket** (§9.4) | badge box above the sticker box on `/buckets/new` | `manufacturing:write` | `createdBy`, operator on the `mint` row |
| **Replace a sticker** (§9.4) | badge box in the *Replace a damaged sticker* block | `manufacturing:write` | operator on the `relabel` row |
| **Start a pass** (§6.1) | badge box at the top of the board's start form | `manufacturing:write` | `openedBy`, `emptyConfirmedBy`, operator on the `create` row |
| **Un-scan a mis-scan** (§6.2) | the rail's badge rides on `?/unscan` | `manufacturing:write` | operator on the two retractions, the delete's audit row and the `unscan` row |
| **Retire a bucket** (§9.7) | badge box on the retire form (board rail and bucket page) | **bucket admin** | operator on the `retire` row |
| **Void a pass** (§12.2) | badge box on the bucket page's void form | **bucket admin** | `voidedBy`, operator on the retractions, the thermoseal credit and the `void` row |
| **Master Override** (§9.5) | badge box under the reason | **bucket admin** | cart-note author, `backing.operator` on a move to Backed, operator on the `advance` row |
| **State Change, bucket moves** (§9.6) | badge box above the cart box | `manufacturing:write` | cart-note author, operator on the `merge_in` / `merge_out` rows, `backing.operator` on a no-bucket move |

*Bucket admin* = `manufacturing:admin` or `admin:full`, the same test the routes apply to the
session (`requireBadge(badge, session, 'admin')`): on an admin-only step **both** the login and
the badge holder must be admins. A non-admin badge is refused with `BADGE_FORBIDDEN`.

**Still not gated, on purpose:** `consumeCarts` and `returnCarts`. They are not bucket-page
actions — `consumeCarts` runs inside wax filling's hands-off deck load (robot sweep → `loadDeck`
→ start, no operator form to put a badge box on) and `returnCarts` inside its cancel / abort
path, where the caller swallows a bucket error so the abort always completes; a refused badge
there would silently leave the carts loose. In the normal flow neither fires at all: *Move to
oven* (gated) frees the carts first and the deck load then makes no bucket write. Gating them is
a wax-filling change (a badge at deck load and at cancel), not a bucket one. Nicknames, audit
moves / take-offs and leftover merges are unchanged too.

**User (2026-10-02):** "I want to adjust the bucket system to require a scan in at every phase."
Read as the badge plan's *Model 1* — "scan in at each stage and advancement"
(`BADGE-SYSTEM_PLAN.md` §1) — not as re-scanning every cart at every stage: the badge is now
asked for at **every phase a bucket enters**, which adds the three advances to the three steps
below. Barcoded is entered by scanning carts in (already gated); Unpressed and Backed
are entered by an advance (**now gated, discards or not**); the oven by *Move to oven* (already
gated). Start-pass stays ungated — no carts are handled there and the user had the badge taken
off it on 2026-09-30; the Barcoded phase gets its badge at the first cart scan. Taps per pass
under *Require badge* on: one at scan-in, one per advance, one at Move to oven — the "4 taps"
reading of the badge plan's §5, plus the oven step.

**User (2026-09-30):** "I want the badge requirement for the bucket system to be when counting up a bucket,
when discarding carts, and when passing carts to oven." Before this (same day, `feat/badge-system`)
the badge gated **mint** and **start-pass** and nothing after; that is reversed. The operator
badge (`BADGE-SYSTEM_PLAN.md` for the badge itself, the portal and the *Require badge* switch)
is asked for at these steps — the ones where carts are handled, and (2026-10-02) every advance:

| Step | Where on the board | What the holder becomes |
|---|---|---|
| **Counting a bucket up** = scanning carts in (§6.2) | badge box above the cart box on a Barcoded pass; the badge rides on every `?/scanIn` | `scannedInBy`, operator on the shell + label debits and the `scan_in` row; **custodian of the pass** at the first scan (`claimCustody`) |
| **Advancing a phase** (§6.3) — Barcoded → Unpressed, Unpressed → Backed (**2026-10-02**) | badge box on the advance form, always shown; the gun lands on it when no badge is on yet | operator on the `advance` row (and on that step's discards, if any); `backing.operator` on every member at Pressed → Backed |
| **Discarding carts** — at an advance (§6.3), *Discard carts…* (`?/scrap`), an audit's *Discard* / *Write off* (§9.8), a leftover *Discard* (§7) | badge box beside the journal, shown only when something is actually being discarded (on the advance form it is always shown) | operator on the `ManualCartridgeRemoval`, the scrap debits and the `scrap` row |
| **Passing carts to the oven** (§6.5) | badge box above *Move to oven* | `ovenReleasedBy`, operator on the `oven` row |

Everything else — audit moves and take-offs, leftover merge, wax filling's draw and return,
nickname — is **not** gated: the session is the operator, as before. (Until 2026-10-05 this
list also held mint, start-pass, un-scan, retire, void and the overrides — see the table at the
top of this section.) On every gated row `operator` = badge holder, `enteredBy` = session,
`attribution` = `{ method: 'badge', badgeId, custodyId? }`. With *Require badge* **off** the
boxes are hidden, but a badge scanned into a cart box is still routed and honoured.

**One badge per pass (user, 2026-10-05):** "Do not save badge info in the scan in window between
scans. Each pass should require a fresh scan, and not hold onto stale badge info." The board
remembers what the rail was pointed at when the badge was scanned (`badgeFor` — a pass id, or a
bucket id on the start / leftover / retire forms) and **drops the badge the moment the rail points
at anything else**: another pass, another bucket, or nothing (panel closed). Reopening the same pass
later asks again. Within one pass the badge still covers every cart scan, un-scan, advance, discard
and *Move to oven*, so scanning 100 carts is still one badge scan. The one hand-over: the badge
that started a pass is re-keyed to that pass, so its cart scans do not ask a second time. A page
reload also clears it (the value only ever lived in the page). From 2026-09-30 until this change
there was **one badge for the whole rail** — scanned once, it filled every gated form on every
bucket until someone pressed *Change badge*. (The same change was built on 2026-10-02 as
`feat/badge-every-phase` @ `c69d26f6` and never merged; this replaces it.)

The `badge` value itself: scanned into any badge box,
or into any cart box — `BDG-…` is recognised client-side and never queued as a cart — it fills
that pass's gated forms until the operator presses *Change badge* or the server refuses it
(`BADGE_*` codes clear it and refocus the box). The Barcoded panel says who the carts are being
recorded to after the first scan lands. Cart scans made before a badge is on are held with *Scan
your badge first* rather than sent.

**Hot path (§6.2.1).** `requireBadge()` reads the mode and resolves the badge in one `Promise.all`,
and on scan-in that whole gate runs inside the existing guard group — the badge adds no round trip
in series. The custody claim is one extra write on the first scan of a pass only.

**Custody.** `Custody` rows are still released by every close path (§16.3 of the badge plan);
they are just opened later — by the first scan-in, by the badge holder who counts the bucket up
— instead of at start-pass by whoever picked the lots. A pass that never gets a cart never gets
a custody row. A later scan by a different badge is attributed on its own rows but does not
take the pass over (no takeover in v1).

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
- **Discard** — **bulk QR scan** of every cart being discarded + journal (required) + **badge**
  (§6.6; the box appears only for Discard, never for Merge); shell + label scrapped from
  inventory (§8).

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

| Event | PT-CT-104 shell | PT-CT-106 label | PT-CT-101 thermoseal roll (the only thermoseal part) |
|---|---|---|---|
| Start pass | — | — | — |
| Scan cart in (Barcoded) | −1 `consumption` | −1 `consumption` | — |
| Un-scan (Barcoded) | +1 (negative `consumption`) | +1 | — |
| Barcoded → Unpressed | — | — | **members × 3.75 cm off the open roll**; −1 roll `consumption` only when a roll is pulled (`manufacturingRunId = roll id`) |
| Discard / scrap / residual scrap | −1 `scrap` | −1 `scrap` | — (length not returned) |
| Unpressed → Backed · wax-fill draw | — | — | — |
| Void pass | net consumption + scrap returned per lot | same | cm credited to roll(s); pulled rolls stay pulled |

All bucket debits carry `manufacturingRunId = cycleId` except roll pulls. Per-lot "N left" =
lot quantity − Σ consumption/scrap rows for that lot.

## 9. UI

### 9.1 `/manufacturing/cart-mfg/buckets` — board, rail, thermoseal, logs

Stage strip (Available · Barcoded · Unpressed · **Backed** — the Backed
tile counts every cart at `backing`, its bucket sub-count the open backed passes) →
4-column board (Available / Barcoded / Unpressed / Backed; the Pressed column was removed
2026-10-02 — a legacy pressed pass shows under Unpressed and its Advance goes to Backed, §2).
Under **Available**: empty buckets only — minting lives on `/buckets/new` (§9.4), reached from
the header *New bucket* button; there is no inline mint card on the board. Every pass card
carries **Audit** (§9.8) under its cart list.
Under **Unpressed**: the compact **Thermoseal tile** (§3.4; live PT-CT-101 roll count, notifications
toggle inside "Development settings"; the "not synced" card and the rolls-on-hand pin are gone). Header
buttons: *New bucket*, *Master override* (admin, §9.5), *Badge required: on/off* (admin, links to the
portal switch), *Wax filling →*. Rail (start, **badge box** + scan-in box with
mis-scan, advance with discards (+ badge, every advance since 2026-10-02), scrap by scan (+ badge), residual by scan (+ badge on
Discard), move to oven (+ badge), retire — see §6.6) → expandable **change log** (lot, move,
who, discards, thermoseal note) → **bucket log** (every bucket incl. retired). `?stage=` focuses
a column; `?q=` resolves a scan (bucket QR, BKT id, or cartridge id → its bucket).
Below the board + rail: **Find a cart** — scan a cart QR, get back cart id · status · the open
pass it **belongs in** by membership, or "on no open pass" + where it was last seen, the legacy
WI-01 lot when it has one, and when the status last changed. Read-only, `?/cartLookup` →
`cartStatusLine()`; a bucket sticker scanned there is named as a bucket rather than reported
missing (user, 2026-09-23). The same lookup sits inside the leftover panel as *Where does this
cart belong?* (§7, 2026-09-25).

Since 2026-10-02 (user: "results should return the bucket's nickname … and colour-coded status
markers like the other search functions") the answer is **structured** rather than one grey
line: `CartStatusLine` carries `status` / `statusLabel`, `home` (`bucketId`, `nickname`,
`barcode`, `bucketState`, `cycleNumber`, `stage`, `relation` = `member | taken_off | closed`),
`legacyLotId` and `since`; `line` remains the plain-text fallback for not-found and errors. The
`?/cartLookup` action returns the whole object. The board renders a found cart with the
`cartHitView` snippet (shared by both boxes): cart id · a **status pill** tinted like the stage
columns (`cartStatusTint`: grey Barcoded, blue Unpressed / legacy Pressed, purple Backed;
neutral for anything downstream) · a **relation pill** (green *Belongs in*, yellow *Taken off*,
grey *Last seen in*; yellow *On no open pass* when a bucket-stage cart has no home) · the bucket
link headlined by its **nickname** with the id and `#pass` in mono (sticker in the tooltip) ·
"at <stage>" · the bucket's own **state pill** from the bucket log's `regStateTint` ("bucket
In use" / "bucket Available" …) · legacy lot · "since". One extra `ProductionBucket` read per
found cart (nickname, barcode, state).

**Load cost (2026-09-30, navigation-lag pass).** The board load fans out nine branches; the
longest used to be the thermoseal one (floor rule → status, ~8 reads in series). It is now ~3:
`thermosealConfig()` + `thermosealPart()` are read once and handed to both `checkFloor()` and
`thermosealStatus(pre)`, and the tile's *next roll lot* comes from the same per-lot-remaining
rows the start-pass pickers use (`lot-remaining.ts`, one ledger pass instead of two). Two
app-wide costs paid on *every* page change were also removed: the root layout no longer re-runs
its load on each client-side navigation (it read `url.pathname`, which SvelteKit tracks — now
`untrack`ed), and its Box/Particle status reads are cached per process for a minute. The
cart-mfg sidebar preloads a page's data on hover (`data-sveltekit-preload-data="hover"`; the
app default is `tap`). Not verified: that the Atlas cluster sits in the same region as the
Vercel functions (`pdx1`) — a cross-region cluster would multiply every remaining round trip.

### 9.2 `/manufacturing/cart-mfg/buckets/[bucketId]`

Passes with per-pass cartridges (in bucket / → on to wax filling / scrapped), source lots,
thermoseal cm, ledger rows, *Replace sticker* link, *Void this pass…* (admin), and the
*add nickname* / *rename* control in the header (§4.1; `?/nickname`, `manufacturing:write`,
hidden on a retired bucket). With a nickname the header reads *Big Blue* with the BKT id beside it.
Payload trimmed 2026-09-30: `bucketHistory()` resolves and loads the tub in one read and leaves
each pass's `cartridgeIds` array in the database (the page lists the carts *born* in a pass via
`CartridgeRecord`, never the member list), and the per-pass cart aggregate slices to the 12 ids
the page shows before leaving the server. A well-used tub no longer gets slower to open with
every pass it has run.

### 9.3 Summary views (read-only, deep-link to the board)

- `/cartridge-admin` strip: Barcoded · Unpressed (link to the board) · **Backed** (was "Backed, awaiting
  oven** (every cart at `backing`; filters the page to `backing`). The
  *Available* tile was removed 2026-09-23 (user: report only the production stages); the
  board's own strip (§9.1) still counts Available buckets.
- `/manufacturing/cart-mfg` **Production Buckets** card beneath the robot grid, same tiles. This
  is the dashboard's only Backed card: the top-row *Backed* stat and the Pipeline Flow strip's
  leading *In Oven* card were removed 2026-09-25 (user: redundant) — Pipeline Flow now starts
  at Wax Fill.
- `/manufacturing/cart-mfg/pipeline?stage=bucket_barcoded|bucket_unpressed|backing` (`bucket_pressed` removed 2026-10-02).
  The `backing` view lists backed bucket passes first, then carts outside a pass grouped per
  legacy WI-01 batch (same status, "awaiting oven"), then legacy `BackingLot` aggregates.

### 9.4 `/manufacturing/cart-mfg/buckets/new` — mint one bucket from one QR

Scan your badge, then the sticker → `BKT-NNNNNN` minted with that `barcode`; `createdBy` and the
`mint` row's `operator` are the badge holder, `enteredBy` the login session. **Badge-gated again
since 2026-10-05** (§6.6; the page had no badge from 2026-09-30 to then), and so is *Replace a
damaged sticker*. One badge value serves both blocks and stays on after a success, so one operator
can mint several tubs in a row; a refused badge is cleared and its box refocused. A badge scanned
into a sticker box is moved to the badge box rather than refused. *Nickname a bucket* is not
gated. Nicknames are **not**
taken here (user, 2026-09-30): the page's third block, **Nickname a bucket** (`?/nickname`, §4.1),
is scan the sticker → type the name → *Set nickname*; an empty name is *Clear nickname*. The gun's
Enter on the sticker jumps to the name field. `?bucket=BKT-…` presets
*Replace sticker*. "← Return to previous page." The v1 `print-bucket-labels` page is deleted. This page
(plus the board's *New bucket* header button) is the **only** way to mint a bucket or replace a
sticker — the board's inline Mint card was removed on 2026-09-25, along with its `?/mint` and
`?/relabel` actions.

### 9.5 `/manufacturing/cart-mfg/buckets/override` — Master Override (admin)

Scan a bucket, pick **Barcoded / Unpressed / Backed**, give a reason →
`forceBucketPhase()` puts its open pass there, **bypassing the flow**: no thermoseal
consumption, no discard prompt, no forward-only order (backwards is allowed). The pass stays
open at the target (Backed included — it gets the same `backing.*` stamp as a normal advance and
wax filling draws from it). Nothing is debited or credited. The ledger row, each cart's note and the audit entry (`FORCE_PHASE`) all say
**MASTER OVERRIDE** plus the reason. Live preview of what the scanned code resolves to; table of
open passes with a *use* shortcut. Linked from the board header (red button) and `?bucket=`.
**Badge-gated since 2026-10-05** (§6.6): the form asks for a badge whose holder is a bucket admin
as well as the login; the holder is the operator on the row and the author of the cart notes. The
badge is cleared after every move that goes through — each override is signed on its own.

### 9.6 `/manufacturing/cart-mfg/state-change` — per-cart manual override (bucket-aware)

The pre-existing bulk State Change page now routes bucket stages through
`overrideCartStage()`: a target of Barcoded / Unpressed / Backed requires a **destination bucket**
(only open passes at that stage are offered) and the cart joins that pass (`merge_in`), leaving
its old one (`merge_out`; an emptied pass closes like a consumed one); any other target removes
a bucket member from its pass. No inventory moves. Unknown barcodes are refused for bucket stages.

**No bucket (2026-10-02).** User: "create a cart state change setting to move a cart directly to
backed without the need of a bucket." When the target is **Backed** the page shows a *No bucket*
checkbox; ticked, the destination picker goes away and `overrideCartStage({ noBucket: true })` moves
each cart straight to status `backing` on no pass. That is a state that already exists — it is
where *Move to oven* leaves carts (§6.5): counted in the Backed tile, listed in the board's *In oven*
dropdown, loadable by wax filling. The cart leaves its open pass if it is in one (`merge_out`, and an
emptied pass closes as usual), gets the same `backing.recordedAt` / `backing.operator` stamp the
Unpressed → Backed advance writes (minus the pass ids), plus `backing.manualBackedAt` (new model
field), a *Manual override: … → backing (no bucket)* note and an `OVERRIDE` audit row with
`noBucket: true`. The marker matters: wax filling's cancel/abort (`revertToBacked`) treats a cart
with neither `bucket.cycleId` nor a WI-01 lot as a test-mode synthetic and hard-deletes it, so a
never-bucketed cart backed this way would have vanished on a cancelled run — `manualBackedAt` is now
a third proof of a real cart there, and such a cart is returned loose at `backing` instead. Only the
Backed target offers the setting (Barcoded and Unpressed still need a destination pass); unknown
barcodes are still refused; nothing is debited.

**Badge (2026-10-05, §6.6).** A cart entering or leaving a bucket pass through this page is a
badge-gated bucket step. The page shows a badge box whenever *Require badge* is on; the action
resolves the badge **once per batch** (`badgeGate()`, handed to every `overrideCartStage` call)
and only when a cart actually takes the bucket path. A bucket-stage target with no badge is
refused up front; with any other target, carts that are in a pass are rejected one by one with
the badge message while carts outside the buckets still change — those plain status changes stay
on the login session. A `BDG-` code scanned into the cart box is taken as the badge and never
treated as a cartridge (with *Create unknown barcodes* ticked it used to be originated as one).

### 9.7 Bucket page — retire

*Retire bucket…* on `/buckets/[bucketId]` (admin, reason required, hidden while in use).
Badge-gated since 2026-10-05 (§6.6) — here and on the board rail's *Retire…* — with an admin
badge. On this page a failed retire or void now keeps its form open (it used to close, which hid
the retire form's own error line).

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

An audit that **discards** a stray or **writes off** a missing member is discarding carts, so it
asks for the **badge** (§6.6) — the box appears beside the journal as soon as one of those is
chosen; moves and *Take off pass* alone do not ask. The holder is the operator on every row the
audit writes.

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
| **`src/lib/server/services/lot-remaining.ts`** | the one per-lot "remaining by ledger" math (`lotRemaining`, `fifoLot`, `lotsWithStock`) — board lot pickers + thermoseal next-roll lot (2026-09-30) |
| `src/routes/+layout.server.ts` | **not a bucket file** — its load used to re-run on every client-side navigation; `untrack`ed + Box/Particle status cached 60 s (2026-09-30). Every page in the app rides on it. |
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
| _(feat/badge-per-pass)_ | **One badge per pass** (§6.6; user 2026-10-05): the board keys the scanned badge to what the rail is pointed at (`badgeFor` / `panelKey`) and clears it when that changes — another pass, another bucket, or the panel closed — so no badge is left sitting in the scan-in window for the next pass. The badge that started a pass carries into that pass's cart scans. Board page only; no server, schema or data change. Supersedes the unmerged `feat/badge-every-phase` @ `c69d26f6`. |
| `0ef9d195` _(feat/in-oven-copy-ids)_ | **In oven: Copy all ids** (§6.5; user 2026-10-05, "give me every cart qr code in the backed category minus any that are currently sitting in buckets"): `?/inOvenList` on the board returns every `inOvenCarts()` id (ceiling 10 000); a *Copy all N ids* button in the In oven dropdown copies them one per line and shows them in a read-only box. Read-only, no data change. Context: the Backed tile reads high because carts are still listed in oven that are not physically there; PR #80 (count in-bucket carts only) was closed unmerged at the user's request — the count rule stays buckets + oven — and a bulk "oven is empty" reset was not built. |
| `ce75e928` _(feat/badge-all-bucket-actions)_ | **Badge on the rest of the bucket actions** (§6.6; user 2026-10-05, after the badge-scan audit): `requireBadge()` gains a level (`'write'` / `'admin'`) and now gates `createBucket`, `replaceBucketSticker`, `startCycle`, `unscanCart`, `overrideCartStage` (write) and `retireBucket`, `voidCycle`, `forceBucketPhase` (admin badge). New `badgeGate()` export so State Change resolves the badge once per batch. Badge boxes on `/buckets/new` (create + replace), the board's start and retire forms, `/buckets/[bucketId]` (void + retire), `/buckets/override` and State Change, via the new `BadgeScanField.svelte`; `?/unscan` carries the rail's badge. `consumeCarts` / `returnCarts` deliberately left on the session (wax filling's deck load and abort path). Reverses the 2026-09-30 removal of the badge from mint and start-pass. No schema or data change. |
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
| _(this change)_ | **Thermoseal: one part, rolls only, bucket phase only** (§3.4): `THERMOSEAL_PART` → PT-CT-101 (owned by `thermoseal-service`, re-exported by `bucket-service`); development pin removed (schema, service, board action, tile); yellow "not synced" card removed; `cut-thermoseal`, `wi-02`, `laser-cutting` no longer write inventory (PT-CT-101 / 111 / 112 / `ManufacturingMaterial`), laser-cutting inventory tile dropped; consumables overview stops deriving "individual backs"; `scripts/migrate-thermoseal-roll-only.ts` (`--plan` / `--apply`, not yet run) |
| _(this change)_ | **Advance form: thermoseal preview + lot picker removed** (§3.4, §6.3) — the "N cm comes off the open roll" box and the "Lot the new roll comes from" select are gone from the Barcoded → Unpressed confirm; consumption is unchanged and runs in the background (FIFO lot); `?/advance` no longer reads `thermosealLotId`; board `thermosealCm()` helper dropped |
| _(this change)_ | **"Backed" + Move to oven + In oven dropdown** (§2, §6.5, §9.1): stage relabelled everywhere (board, strip, dashboard, cartridge-admin, pipeline, dev dashboard, override); board grid `md:grid-cols-5` so Backed sits beside Pressed; `moveToOven` (service + `?/moveToOven`) closes the pass (`ovenReleasedAt/By`, `oven` change-log type, `MOVE_TO_OVEN` audit) and returns the tub to Available — no cart write, carts stay `backing` until wax filling; `returnCarts` leaves oven-released carts loose; the history page counts a released pass's carts as *went on*; `inOvenCarts()` feeds the **In oven** dropdown inside the Backed column. (An interim version the same day stamped carts `backing.movedToOvenAt` and had a longer stage name — reverted at the user's request.) |

| _(feat/badge-system)_ | **Operator badges at mint + start-pass** (§6.1, §9.4; design and build layout in `BADGE-SYSTEM_PLAN.md` Part 2): `createBucket` / `startCycle` take a scanned `badge`; `requireBadge()` resolves it (or falls back to the session when the admin-only *Require badge* switch at `/admin/badges` is off) and refuses a holder without `manufacturing:write`; `startCycle` opens a `Custody` row (`custodyId` on the cycle) that `closeCycle` / `voidCycle` release; every ledger row now carries `enteredBy` + `attribution`; `scanCartIn`, `assertStickerFree`, `auditScan` refuse a badge code; `resolveScan` names the holder when a badge lands in the bucket box. New: `operator-badge.ts`, `custody.ts`, `badge-service.ts`, `/admin/badges` (portal + CR80 print). |
| _(feat/badge-system)_ | **Bucket nicknames** (§4.1, §9.2, §9.4): `ProductionBucket.nickname` (optional, ≤30, unique among non-retired, case-insensitive); `setBucketNickname()` + `?/nickname` on the history page (any `manufacturing:write` user, blank clears, refused on retired); optional Nickname box on `/buckets/new` (`createBucket` takes `nickname`); board cards/panels headline the nickname over the sticker via `nameOf()`, registry gains a Nickname column, board scan box + `resolveScan` search by it (never an exact resolve — `resolveBucketId` unchanged); new `nickname` ledger type + `NICKNAME` audit. |

| _(feat/bucket-nickname-block)_ | **Nickname moved out of the mint form** (§9.4): the mint block is back to badge + sticker; a third block *Nickname a bucket* on `/buckets/new` (scan sticker → name → `?/nickname` → `setBucketNickname`) sits beside *Create* and *Replace sticker*. Clearing = empty name. History-page rename unchanged. |

| `6c0a8bc1` (feat/bucket-nav-perf) | **Navigation lag between bucket pages** (§9.1, §9.2): root `+layout.server.ts` no longer re-runs on every client-side navigation (`untrack(() => url.pathname)`) and caches the Box/Particle status reads for 60 s per process; new `lot-remaining.ts` (`lotRemaining` / `fifoLot` / `lotsWithStock`) is the one per-lot ledger math — the board's `availableLots` and thermoseal's `defaultThermosealLot` both use it; `thermosealStatus(pre?)` takes a preloaded config / part / next lot and runs its reads in parallel, `checkFloor` takes `part`, `thermosealPart()` exported; board thermoseal branch ~8 → ~3 round trips in series; `bucketHistory` resolves + loads the tub in one read (`findBucketByCode`, shared with `resolveBucketId`) and drops `cartridgeIds` from the cycles it returns; history-page cart aggregate `$slice`s to 12 ids in the database; cart-mfg sidebar `data-sveltekit-preload-data="hover"`. No schema or data change. |

| _(feat/badge-gated-steps)_ | **Badge gate moved to the cart-handling steps** (§6.6; §6.1, §6.2, §6.3, §6.5, §7, §9.1, §9.4, §9.8): `requireBadge()` now runs in `scanCartIn` (inside the guard `Promise.all`; mode read + badge lookup in parallel), `scrapCarts` (so advance discards, *Discard carts…*), `auditCycle` (when a stray is discarded or a missing member written off), `reportResidual` (Discard only) and `moveToOven`; removed from `createBucket` and `startCycle`. New `claimCustody()`: the `Custody` row is opened by the badge holder at the first scan-in of a pass (`BucketCycle.custodyId` set then), no longer at start-pass. Gated rows carry `operator` = holder, `enteredBy` = session, `attribution` (+ `custodyId`). Board: one shared `badge` state + `badgeField` snippet on the Barcoded panel, advance (discards only), scrap, audit (discards/write-offs only), residual (Discard only) and Move to oven; a `BDG-` code scanned into any cart box is routed to the badge; `?/scanIn` returns `operator`; start form and `/buckets/new` lose their badge fields. Badge Portal copy updated. No schema change. |

| _(fix/bucket-scan-count)_ | **Scan-in count lag** (§6.2.1): the card count and stage tile now tick on Enter — new `scanPending` overlay joins `scanAdded` / `scanRemoved` in `overlay()`; queued on Enter, moved to `scanAdded` on confirm, dropped on failure (`settlePending`). Queued-check before membership-check in `enqueueCartScan`. Client only; no server, schema or data change. |
| _(feat/badge-every-phase)_ | **Badge at every phase** (§6.3, §6.6, §9.1; user 2026-10-02: "require a scan in at every phase", read as the badge plan's Model 1): `advanceCycle` now calls `requireBadge()` unconditionally — every advance (Barcoded → Unpressed, Unpressed → Pressed, Pressed → Backed) is badge-gated, not only one with discards; with *Require badge* off and no scan it still falls back to the session. Board: the advance form always renders the badge box (`badgeField(true)`) and `setMode('advance')` focuses it when no badge is on; header-link title and the "that is a badge" message name the advance. Badge Portal copy (`/admin/badges`) says "every phase". No schema, server-action or data change — `?/advance` already carried `badge`. |
| _(feat/drop-pressed-stage)_ | **Pressed stage removed** (§2, §5.2, §6.3, §7, §9.1, §9.3, §9.5, §9.6, §12.3): `BUCKET_STAGES` is now `barcoded | unpressed | backing`, so Unpressed advances straight to Backed (same `backing.*` stamp; thermoseal still consumed at Barcoded → Unpressed). The key stays in both model enums as `LEGACY_PRESSED_STAGE`; new `isBucketStatus()` / `boardStage()` / `stageLabel()` and a legacy branch in `nextStage()` keep any pass or cart still at `pressed` visible (Unpressed column + count), advanceable (→ Backed, no thermoseal) and accepted by residual / audit / void / state-change — no data migration. Board `md:grid-cols-4`, dashboard + cartridge-admin strips lose the Pressed tile, pipeline loses `bucket_pressed`, override + state-change no longer offer the target. `npm run check`: 14 errors, the pre-existing baseline. |
| _(feat/state-change-direct-backed)_ | **State Change: straight to Backed with no bucket** (§9.6): a *No bucket* checkbox on `/manufacturing/cart-mfg/state-change`, shown only when the target is Backed, sends `noBucket` to `overrideCartStage()`, which moves the cart to status `backing` on no pass — it leaves its open pass if any (`merge_out`; an emptied pass closes), gets the `backing.recordedAt` / `operator` stamp and the new `backing.manualBackedAt` (model), a `(no bucket)` note and an `OVERRIDE` audit row. Loose backed carts are the state Move to oven already produces (Backed tile, In oven dropdown, loadable by wax filling). Wax filling's `revertToBacked` accepts `backing.manualBackedAt` as proof of a real cart, so a never-bucketed cart is returned loose on cancel/abort instead of hard-deleted as a synthetic. Barcoded / Unpressed targets unchanged; unknown barcodes still refused. `npm run check`: 14 errors, the pre-existing baseline. |
| _(feat/find-cart-bucket-pills)_ | **Find a cart: bucket nickname + colour-coded pills** (§9.1, §7; user 2026-10-02): `cartStatusLine()` returns structured fields (`status`, `statusLabel`, `home` with `nickname` / `barcode` / `bucketState` / `relation`, `legacyLotId`, `since`) beside the unchanged `line`, reading the home bucket's `ProductionBucket` row for nickname + state; `?/cartLookup` returns the whole object. Board: new `cartHitView` snippet renders cart id · stage-tinted status pill · relation pill (Belongs in / Taken off / Last seen in / On no open pass) · bucket link headlined by nickname · "at <stage>" · bucket-state pill (`regStateTint`) · legacy lot · since; used by the *Find a cart* box and the leftover panel's *Where does this cart belong?*. Plain `line` still shown for not-found / errors. No schema or data change. |

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
  ledger shows one −1 PT-CT-101 against the roll id, `thermoseal.segments` has two entries;
  (c) with PT-CT-101 at 2 rolls, pull one → kanban card appears once, email logged once (see
  `/admin/notifications` audit), a second pull adds no second card; (d) void that pass → cm
  credited, roll count unchanged.

### 12.2 Test data and inventory — voiding a pass

Previews write to the configured Atlas database — **unconfirmed whether that is production.**
`voidCycle()` (admin, reason required) reverses the pass's net consumption + scrap per lot with
negative rows of the same type, credits thermoseal length to its rolls, voids the pass's carts
(never deletes), marks its removals, frees the tub. Refused if any member went past the buckets.
**Not reversed:** roll pulls (the roll is open), sticker assignments. Badge-gated since
2026-10-05 (§6.6, admin badge): the holder is `voidedBy` and the operator on every reversing row.

PT-CT-112 was reset to 1 roll on 2026-09-23 (§3.4). The preview shares the kanban board and the
email list with production — **switching the notifications toggle on** while the shelf is below
the floor creates a real card and sends real mail on the next board load.

### 12.3 Decisions still needed from the floor

1. Stage vocabulary (`unpressed`) — label free, key is a migration. (`pressed` resolved 2026-10-02: removed.)
2. Bucket sizing — unconstrained by design.
3. Cutover — go-forward only: new shells enter buckets; material already on the floor drains
   through the legacy paths.
4. Thermoseal constants — 3.75 cm / 65 m / floor 2 are in `ManufacturingSettings.thermoseal`
   (no UI yet; defaults in code). **Notifications toggle is off** — turn it on when the build is
   ready for real restock cards and mail. Confirm `leadTimeDays` and `supplier` are filled on the
   PT-CT-101 part so the restock card and email carry a real lead time.

### 12.4 Known risks

- **Backed stage is untested end to end** (2026-09-25). Not yet exercised on a preview: advance
  Unpressed → Backed; load a deck from a backed bucket and confirm the pass closes and the tub
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
- **Thermoseal on the live `master` build (updated 2026-09-25).** Production WI-01 on `master`
  still withdraws one PT-CT-112 *unit* per cartridge out of the shared database. Since the
  2026-09-25 overhaul (§3.4) nothing on this branch reads PT-CT-112 — the roll part is
  PT-CT-101 and PT-CT-112 is retired — so that drift no longer shows on the board. It ends when
  this branch ships and replaces WI-01. History: the 2026-09-23 roll model sat on PT-CT-112 and
  went 1 → −23 → −77 → −228 from the production debits; the user's call then was to leave
  production alone, which still stands. PR #60 (production WI-01 → roll length) is superseded by
  this branch shipping.
- **PT-CT-101's count needs a physical count in rolls** after `scripts/migrate-thermoseal-roll-only.ts`
  runs — done by hand first: user reported exactly 1 roll on hand (2026-09-25); the 113 "ea" it
  read before came from the old cut-thermoseal debits. Below the 2-roll floor until a delivery.
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
- Wording sweep "tub" → "bucket" outside the Available card.
- Repo is public (`"private": false`).
