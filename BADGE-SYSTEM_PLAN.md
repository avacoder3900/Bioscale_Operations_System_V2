# Badge System — Operator Identity for the Bucket System (design discussion)

**Status:** Part 1 = design discussion (2026-09-23). Part 2 = v1 build layout (2026-09-30), **built the same day on `feat/badge-system`** — see §20 for what changed between layout and code.
**Date:** 2026-09-23
**Sibling doc:** `BUCKET-SYSTEM_PLAN.md` (lives on `feat/bucket-system`). This file is deliberately
separate — the badge/custody primitive is not bucket-specific, and the bucket system is only its
first consumer.

This is a record of a working session, not a spec. It captures the question as posed, what the
current code actually does, the analysis, and a recommendation. Sections 11 and 12 are the parts
that need a human answer before anything gets built.

---

## 1. The question as posed

> Currently, changes are logged via whichever individual is logged in at the time, but in the
> future we may want to use a keycard system to track cart movement through the bucket system.
> Two possible models:
>
> 1. **Scan in at each stage and advancement** — more consistency, more friction.
> 2. **Required scan in at bin creation, optional scan in / scan out at every other stage** —
>    less friction because someone working a bucket start-to-finish doesn't rescan after every
>    step, but prone to error if someone doesn't scan out / in when taking over a bucket.

---

## 2. What exists today

Grounded in the bucket system as built on `feat/bucket-system`:

- **Attribution plumbing already exists, with one weak source.** Every mutation writes
  `operator: { _id, username }` onto `BucketTransaction`, taken from `locals.user` — i.e. whoever
  owns the browser session at that terminal. The ledger is append-only
  (`applyImmutableMiddleware`), so attribution can never be retro-edited. That last property is
  worth a lot and should be preserved.
- **Scanning is already one unified input with no modes.** `resolveScan()` in
  `src/lib/server/services/bucket-service.ts` takes a code, resolves an exact bucket id or
  sticker, and otherwise degrades to a short search. A badge can become another resolution kind
  on that same path — no new client surface, no mode toggle for the operator to get wrong.
- **There is no concept of "who holds this bucket right now."** `BucketCycle` has `openedBy` and
  `stageEnteredAt`, but nothing in between. The system knows who *clicked*; it has never known
  who was *on* the bucket.
- **Supporting models already in the repo:** `ElectronicSignature` (with `meaning` / `dataHash`),
  `User.trainingRecords`, and `ManufacturingSettings` (already holds the thermoseal constants,
  so it is the established home for tunable floor policy).

---

## 3. The framing problem

Model 1 and Model 2 look like two systems. They are one system with a knob.

Both require the same underlying record: **a custody claim** — who is responsible for this bucket
right now. Model 1 says that claim lives for exactly one action. Model 2 says it lives until
someone replaces it.

**Recommendation: don't pick a model. Build the custody record, and make the model a policy
value.** Then Model 1, Model 2, and any hybrid are the same code with different settings, and the
choice can be changed from the floor's experience instead of guessed at up front.

---

## 4. Data model

### 4.1 `OperatorBadge` — separate collection, not a field on `User`

Badges are lost, reissued and revoked on a different cadence than accounts, and they need a
history. A field on `User` gives you neither.

| Field | Notes |
|---|---|
| `_id` | nanoid |
| `userId` | `User._id` |
| `credentialHash` | **hash of the card id — never the raw value** (see §9) |
| `display` | `"BADGE ---4417"` for UI only |
| `type` | `keycard` / `qr` / `pin` |
| `issuedAt` / `issuedBy` | |
| `revokedAt` / `revokedBy` / `revokeReason` | revoke, never delete |
| `active` | |

Unique index on `credentialHash`.

### 4.2 `Custody` — one row per stint, append-only

Written generically so it is not bucket-only, but **scoped to the cycle** for buckets — the bucket
pass is the unit of work, and it already has the uniqueness machinery this needs.

| Field | Notes |
|---|---|
| `_id` | nanoid |
| `resourceType` / `resourceId` | `bucket_cycle` / `BucketCycle._id` — generic on purpose |
| `bucketId` | denormalized for the board query |
| `stage` | stage at claim time |
| `operator` | `{ _id, username }` |
| `badgeId` | which credential was presented |
| `method` | `badge` / `login` / `pin` / `override` |
| `stationId` | optional — where the scan happened |
| `claimedAt` / `releasedAt` | |
| `releaseReason` | `scan_out` / `takeover` / `expired` / `cycle_closed` |
| `supersededBy` | the custody `_id` that took over |

**Uniqueness:** partial unique index on `{ resourceType, resourceId }` where `releasedAt: null`.
Same trick the bucket system already uses for the one-open-cycle-per-bucket guarantee — two people
claiming one bucket becomes a duplicate-key write error, not a silent double-book. Do not rely on
an application-level check.

**Free win:** dwell-time-per-person falls straight out of this table. That cannot be computed
today at all.

### 4.3 Transaction attribution — additive, nothing downstream breaks

Added to `BucketTransaction` (and reusable on any other ledger):

- `operator` — **unchanged.** The effective actor. Everything that reads this keeps working.
- `enteredBy` — the web session that submitted the request (`locals.user`).
- `attribution: { method, badgeId, custodyId, sessionAgeSec, stationId }` where `method` is
  `badge` / `session` / `login` / `override`.

**`enteredBy` separate from `operator` is the single most valuable field in this design.** "Jane's
badge did this at Bob's logged-in terminal" is the actual shared-terminal reality on a floor, and
today the system can only record Bob. When there is no badge, `operator === enteredBy` and
`method: 'login'` — which is exactly the current behaviour, so the migration is non-breaking and
historical rows stay meaningful.

`method` is what makes Model 2's weakness **measurable instead of theoretical**. Ship with
everything at `login`, then watch what fraction of events per stage stay weakly attributed, and
tighten where the number is bad.

### 4.4 Policy lives in settings, not in code

```
ManufacturingSettings.badge = {
  mode: 'off' | 'optional' | 'required',   // global rollout switch
  requireBadgeFor: ['create', 'advance', 'scrap', 'void', 'quarantine', 'residual_disposition'],
  inheritFor:      ['scan_in', 'unscan', 'consume', 'merge_in', 'merge_out'],
  custodyTtlMinutes: 240,
  idleTimeoutMinutes: 60,
  expireAtShiftBoundary: true,
  allowSelfWitness: false
}
```

Same home as the thermoseal constants. Rollout becomes a settings flip, not a deploy.

---

## 5. The friction math

Counting badge taps for a 50-cartridge pass under Model 1 depends entirely on what "advancement"
means:

| Reading | Taps per pass |
|---|---|
| Badge per **transaction** | `create` + 50x `scan_in` + 2 advances = **53** — untenable |
| Badge per **stage transition** | create, Barcoded to Unpressed, Unpressed to Pressed, Pressed to Backed = **4** |
| Model 2 | **1** guaranteed, rest optional |

So the real delta is **4 taps vs 1**, spread across hours of work. The friction argument for
Model 2 is considerably weaker than the framing suggests — but the tap count was never the real
cost of Model 1 (§6).

---

## 6. What actually makes "required" expensive

Not the taps. The failure mode when the badge isn't there.

A hard requirement with no designed escape means either work stops, or people start sharing
badges. **A shared badge is worse than the login attribution in place today, because it looks
authoritative.** Bad data that presents as good data is the expensive outcome here.

Any `required` policy therefore needs a designed, logged bypass: `method: 'override'`, a reason,
and ideally a second person. If the bypass is not designed, the floor will design one, and theirs
will be a badge taped to the wall.

---

## 7. Recommendation

**Model 1's rule at stage transitions only; Model 2's inheritance for everything in between.**

- Fresh badge required for the small, fixed set of consequential events: cycle create, each stage
  advance, scrap / void / quarantine, residual disposition.
- Inherited custody for the routine high-volume ops: the ~50 cartridge scan-ins, un-scans,
  consumes, merges.
- Both behaviours come from the same custody record, so this is a settings list, not an
  architecture commitment.

---

## 8. Defusing the takeover problem

Model 2's stated weakness — "prone to error if someone doesn't scan out / in when taking over" —
has four cheap structural answers:

1. **Never require scan-out.** A different badge scanning in auto-releases the prior custody with
   `releaseReason: 'takeover'`. One tap, not two. This removes most of Model 2's friction *and*
   its main error mode at the same time — it is the highest-leverage single decision in this doc.
2. **TTL on custody.** Expiry forces a fresh badge on the next action, which bounds wrong
   attribution to a single window instead of letting it run indefinitely. Force expiry at shift
   boundaries if they are known — silent overnight inheritance is the most common bad case.
3. **Show it on the board.** "Held by Jane - 12m" on the bucket card, with tap-to-claim. Visible
   attribution self-corrects because the wrong name is sitting in front of the person who can fix
   it. Hidden attribution never corrects. Best value per unit of effort in the whole design.
4. **Flag, don't block, during rollout.** Under `optional`, an action arriving with stale or
   absent custody is written with `method: 'login'` and a weak-attribution flag — never refused.
   That flag feeds the report that tells you where tightening is actually warranted.

---

## 9. Security notes

- **A card id is a bearer token.** Anyone who photographs a badge, or reads it with a cheap
  reader, can replay the number. Store `credentialHash`, never the raw id; keep only a display
  suffix. Treat badge lookup as credential verification, not as a database `find`.
- **Badge tap is not an electronic signature.** The repo already has `ElectronicSignature` with
  `meaning` and `dataHash`. A single-factor tap is generally not sufficient under 21 CFR Part 11,
  which expects ID + password/PIN for signature-bearing acts. Recommendation: **badge =
  attribution; e-signature stays a separate, deliberate step.** This needs deciding before it is
  built, not after it ships.
- All new routes and actions follow `SECURITY.md` and keep `requirePermission()` — custody is an
  attribution layer, never a substitute for permission checks.

---

## 10. Rollout

| Phase | Mode | What happens |
|---|---|---|
| 1 | `off` | Ship `OperatorBadge` + `Custody` + the attribution fields. Everything writes `method: 'login'`. Zero behaviour change on the floor. |
| 2 | `optional` | Badge readers on the bench. Scans recorded, nothing blocked. Board shows "Held by". Measure the weak-attribution rate per stage. |
| 3 | `required` | Turn on `requireBadgeFor` for the consequential events once the phase-2 numbers justify it. Override path live and logged from day one. |

The point of phase 2 is that the Model 1 vs Model 2 argument gets settled by data from the actual
floor rather than by prediction.

---

## 11. Decisions needed before building

1. **Reader hardware.** A USB keyboard-wedge reader emits a string straight into the scan field
   that already exists — near-zero client work. WebNFC is Chrome-on-Android only. A dedicated
   station app is a different project entirely. *This choice is the difference between a small
   feature and a large one.*
2. **Building keycard, or a new printed QR badge?** Reusing the access card inherits HR's
   issue/revoke lifecycle (good) but requires a reader that can read that card technology, which
   may not be cheap depending on the card. A printed QR/Code128 badge costs nothing and works with
   the scanners already on the floor today.
3. **Is any of this signature-bearing under the QMS?** See §9. Decide explicitly.
4. **Can one person hold custody of several buckets at once?** Leaning yes — custody is per cycle,
   and one person genuinely does work several tubs.
5. **Does custody gate permission, or only record it?** `User.trainingRecords` exists, so custody
   at a stage someone isn't trained on *could* be refused. Recommendation: **record only at
   first.** Gating is a second phase and a much larger political question.
6. **Shift boundaries** — are they defined anywhere the system can read, or does TTL have to be a
   flat duration?

---

## 12. Deferred / explicitly out of scope

- Gating custody on training records (§11.5).
- Station identity as a first-class model — `stationId` is a field for now, not a collection.
- Badge self-service enrollment; assume admin issues badges initially.
- Extending custody beyond buckets (SPU assembly, cleaning records, Opentrons runs). The
  `resourceType` / `resourceId` shape in §4.2 is there so this is possible later, not so it
  happens now.
- Anything involving a second-person witness beyond reserving the `witness` field.

---
---

# Part 2 — v1 build layout (2026-09-30)

**Branch:** `feat/badge-system`, cut from `feat/bucket-system` (the bucket system exists only
there). PR target is `feat/bucket-system`, not master.
**Status:** layout agreed in conversation, nothing coded yet.
**Scope, in the user's words:** bucket system is the testing ground, extend to other applications
later. Badge Portal under user manager, admin only, generates badges (name + QR). Each user can
be assigned a badge. Creation is manual. Badges are printed and carried in badge holders.
**Minting a bucket and starting a pass require a badge scan. Subsequent steps do not.**

Part 1 stays as the design record. Where Part 2 narrows or overrides it, Part 2 wins for v1.
Stage names in Part 1 predate the `raw` to `barcoded` rename; the stages are now
Barcoded, Unpressed, Pressed, Backed.

---

## 13. System audit — where badges could go (2026-09-30)

Swept all 120 models, 156 `AuditLog.create` sites, every scan surface. Ranked by value per effort.

### 13.0 Custody already exists here, twice, and disagrees with itself

| Where | What | Why it matters |
|---|---|---|
| `capture-station.ts` `currentOperator` + `api/cv/stations/[id]/lock` | **stored** lock with claim/release endpoints | already ~80% of the `Custody` record in §4.2 |
| `robot-arm-lock.ts` | **derived** holder — no lock field, release = the run's terminal event | its header names `capture_stations.currentOperator` as *"the cautionary tale in this codebase: it has no expiry and has to be cleared out of Mongo by hand"* |

Two incompatible custody designs shipped; one is documented as a mistake. §4.2 would be the third.
v1 builds `Custody` with an explicit release on every cycle-close path (§16.3) so it cannot strand
the way `currentOperator` does. Folding the other two into it is deferred (§19).

### 13.1 Attribution is free text today (a string anyone can type)

`inventory-transaction.performedBy`, `cleaning-record.performedBy` (free text on purpose — cleaners
are not BIMS users, so a badge is the *only* fix), `reagent-inventory.inspectedBy`,
`equipment-location.currentPlacements.placedBy`, `assembly-session.fieldRecords.capturedBy`.

### 13.2 Worst attribution in the system

`opentrons-clone/operator-login`: one shared env password (`OT_OPERATOR_PASSWORD`), an 8-hour
cookie, **no user identity at all**. Clearest badge win after buckets.

### 13.3 Long-running work where one name covers hours

`assembly-session`, `opentrons-run-record`, `wax-filling-run`, `reagent-batch-record`,
`lot-record`, `validation-run`, `protocol-execution`, `service-record`, `spu.assembly`. All are
future `Custody` consumers via `resourceType` / `resourceId`.

### 13.4 Near-free because the plumbing exists

- 21 scan inputs already live; a keyboard-wedge badge needs no new client surface at any of them.
- Barcode printing already built: `GeneratedBarcode` counter, `bwip-js` in the browser at
  `/manufacturing/print-barcodes`. A printed QR badge is one new prefix.
- `AuditLog` is immutable, has `sessionId` / `ipAddress` / `userAgent`, and is written at 156
  sites — one `attribution` block there instruments every mutation in the app. Deferred (§19).
- `workstationId` already exists on `spu.assembly` and `assembly-session` — precedent for `stationId`.

### 13.5 Signature points — badge is the ID half, never the signature

`assembly/complete`, `documents/[id]/approve`, `documents/[id]/train`, `spu/[spuId]`. Note
`assembly/complete` writes `dataHash: ''` — a separate Part 11 gap, not this project.

### 13.6 Skip

Kanban assignment, CV projects/labels, Opentrons protocol authoring — desk work, no traceability gain.

---

## 14. v1 decisions (made here — say if you disagree)

| # | Decision | Why |
|---|---|---|
| 1 | **Badge code is random and stored in plaintext**, not hashed (revises §9) | The portal must reprint a badge at any time. A hash only defends against a DB dump, which already exposes everything else; the real defence is that the code is unguessable. Switching to hash-only later is contained to `resolveBadge()` + "reissue instead of reprint". |
| 2 | Code format `BDG-` + 10 chars from `ABCDEFGHJKLMNPQRSTUVWXYZ23456789` (no 0/O/1/I) | Prefix lets every scan box recognise a badge by regex; alphabet survives keyboard-wedge guns and human reading. |
| 3 | **One active badge per user** — partial unique index | "Each user can be assigned a badge." Reissue revokes the old one first. |
| 4 | Portal gate is `isAdmin()` (`admin:full` or `admin:users`) — no new permission string | That is already the repo's definition of admin; avoids touching the PERM-02 registry. |
| 5 | Badge holder must also hold `manufacturing:write`; the web session still passes `requirePermission` as today | Custody is attribution, never a substitute for permission (§9). Both people in the shared-terminal case must be allowed. |
| 6 | Session user is always recorded as `enteredBy`; `operator` = badge holder on badge-gated events, = session user everywhere else | Nothing downstream that reads `operator` changes meaning; `enteredBy` is the new fact. |
| 7 | **Subsequent steps do not inherit the badge holder as `operator`** | Attributing Jane's scan-ins to Bob because Bob started the pass is exactly the "bad data that looks good" failure in §6. They link to the pass's custody by id instead. |
| 8 | Enforcement is a settings switch `ManufacturingSettings.badge.mode` = `off` or `required`, **default `required`**. The switch is a toggle in the Badge Portal, **admin only** (§17.5) | User asked for required, with an admin-only way to turn it off; flippable without a deploy. |
| 9 | Mint writes attribution only; **start-pass also opens a `Custody` row**, released when the pass closes | Mint is instantaneous. A pass is the unit of work and is what "extend to other applications" will copy. |
| 10 | No TTL, no takeover, no board "Held by" in v1 | Not needed for "scan at mint + start". Fields are reserved so they are additive later. |

---

## 15. Data model (v1)

### 15.1 `OperatorBadge` — new, collection `operator_badges`

```
_id           nanoid
code          'BDG-XXXXXXXXXX'   unique index — the value in the QR
userId        User._id
username      snapshot
displayName   the name printed on the badge (default: first + last, editable at issue)
status        'active' | 'revoked'
issuedAt / issuedBy { _id, username }
revokedAt / revokedBy { _id, username } / revokeReason
lastUsedAt    bumped by resolveBadge()
printCount    bumped by the print page
```
Indexes: `{ code: 1 }` unique · `{ userId: 1 }` unique, partial `status: 'active'` · `{ status: 1, issuedAt: -1 }`.
Revoke, never delete — block deletes the way `user.ts` does.

### 15.2 `Custody` — new, collection `custody`

```
_id            nanoid
resourceType   'bucket_cycle'          (generic on purpose — §4.2)
resourceId     BucketCycle._id
bucketId       denormalised for the board
operator       { _id, username }       badge holder
badgeId        OperatorBadge._id
method         'badge'                  (enum reserved: 'login' | 'override')
enteredBy      { _id, username }       web session that submitted the scan
claimedAt
releasedAt     null while open
releaseReason  'cycle_closed' | 'voided' (enum reserved: 'scan_out' | 'takeover' | 'expired')
```
Index: `{ resourceType: 1, resourceId: 1 }` unique, partial `releasedAt: null` — same trick as
one-open-cycle-per-bucket. `{ bucketId: 1, claimedAt: -1 }` for history.

### 15.3 `BucketTransaction` — two additive fields

```
enteredBy    { _id, username }                          // always the session
attribution  { method: 'badge' | 'login', badgeId, custodyId }
```
`operator` unchanged. Rows written before this change have neither field; readers treat missing
`attribution` as `{ method: 'login' }`, which is what they were.

### 15.4 `BucketCycle` — one additive field

`custodyId` — the `Custody` row opened at start. `openedBy` becomes the badge holder (it was the
session user); the session user is on the custody row as `enteredBy`, not duplicated here.

### 15.5 `ManufacturingSettings.badge`

```
badge: {
  mode:      { type: String, enum: ['off', 'required'], default: 'required' },
  changedAt: Date,                        // last flip (§17.5)
  changedBy: { _id: String, username: String }
}
```
Lives beside `thermoseal`. `requireBadgeFor` from §4.4 is **not** a setting in v1 — the gated set
is hard-coded to `mint` + `create` in `bucket-service.ts` until a second consumer needs the list.

---

## 16. Server logic

### 16.1 `src/lib/server/services/badge-service.ts` — new

```
isBadgeCode(code)                       /^BDG-[A-Z0-9]{10}$/i
resolveBadge(code) -> BadgeHolder       { badgeId, user: { _id, username }, displayName }
                                        throws BadgeError: unknown code / revoked / user inactive
                                        bumps lastUsedAt (fire-and-forget)
issueBadge({ userId, displayName, issuedBy })
                                        refuses if the user already has an active badge (11000 -> BadgeError 409)
revokeBadge({ badgeId, reason, by })
reissueBadge({ badgeId, by })           revoke + issue, one call, one audit row
listBadges()                            for the portal table
badgeMode()                             reads ManufacturingSettings.badge.mode, default 'required'
```
`BadgeError` mirrors `BucketError` (message, status, code) so the bucket page's `wrap()` needs no
change beyond catching both.

### 16.2 `bucket-service.ts` — gated entry points

```
createBucket({ qr, badge, user })   // badge: scanned code; user: session (= enteredBy)
startCycle({ ..., badge, user })
```
Both do, in order: `requireBadge(badge, user)` — a private helper that

1. reads `badgeMode()`; if `off`, returns `{ operator: user, attribution: { method: 'login' } }`;
2. else refuses an empty scan (`Scan your badge.`, 400, `BADGE_REQUIRED`);
3. `resolveBadge()`; loads the holder's roles; refuses unless `hasPermission(holder, 'manufacturing:write')`;
4. returns `{ operator: holder, badgeId, attribution: { method: 'badge', badgeId } }`.

`createBucket` writes `createdBy` = operator, `logTx` with `operator` + `enteredBy` + `attribution`.
`startCycle` additionally creates the `Custody` row (before `BucketCycle.create`, inside the same
try so an 11000 on either unwinds cleanly), sets `openedBy` = operator and `custodyId`.

**Guards — a badge must never become a cartridge or a sticker.** `scanCartIn`, `assertStickerFree`
and `auditScan` reject `isBadgeCode()` with *"That is a badge, not a cart."* `resolveScan()` gains
`kind: 'badge'` so the board's main scan box answers *"That is Jane's badge — scan a bucket."*

### 16.3 Custody release — every close path, no exceptions

| Path | `releaseReason` |
|---|---|
| `closeCycle()` (consumed / scrapped — reached from scrap-to-zero, consumeCarts, moveToOven, overrideCartStage) | `cycle_closed` |
| `voidCycle()` | `voided` |

One private `releaseCustody(cycleId, reason)` called from both. `forceBucketPhase` (Master
Override) goes through `closeCycle` when it closes, so it is covered. This table is the difference
between `Custody` and the stranded `currentOperator` in §13.0 — keep it complete.

### 16.4 Every non-gated step

`scanCartIn`, `unscanCart`, `advanceCycle`, `scrapCarts`, `consumeCarts`, `moveToOven`,
`returnCarts`, residual, audit, retire, void: **unchanged behaviour**. `logTx` gains
`enteredBy = operator = session user` and `attribution: { method: 'login', custodyId }` where the
cycle has one. That is the whole change to them.

---

## 17. UI

### 17.1 Badge Portal — `/admin/badges` (admin only)

- Tab **Badges** in `admin/+layout.svelte`, shown when `canManageBadges` (`isAdmin()`), placed
  after **Users**. `admin/+layout.server.ts` adds the flag and lets it satisfy the layout's
  "at least one" redirect check.
- `load`: `isAdmin()` check, 403 otherwise; returns badges (joined display) and the users without
  an active badge for the picker.
- **Issue badge** form: user select · display name (prefilled first + last) · Issue. On success
  the new row is highlighted and the *Print* link is offered immediately.
- Table: name · user · code (mono) · status · issued · last used · actions **Print** / **Revoke**
  (reason required) / **Reissue**.
- Actions: `issue`, `revoke`, `reissue`, `setBadgeMode` (§17.5). Each writes `AuditLog` (`tableName: 'operator_badges'`; `setBadgeMode` writes `manufacturing_settings`).
- **Require badge** switch at the top of the page, admin only — §17.5.

### 17.2 Print — `/admin/badges/[badgeId]/print`

Standalone page, print stylesheet, one CR80 card (85.6 x 54 mm) per badge: display name large,
QR (`bwip-js/browser`, `qrcode`, code as the payload) centred, code in small mono under it,
"BIMS" wordmark. `window.print()` button; the load bumps `printCount`. Revoked badges render with
a red REVOKED band so a stale print cannot be confused for a live one.

**Batch print** (added the same day): a *Batch print* panel on the portal builds a list from a
dropdown of active badges, a name/user/code search (Enter adds the top match), or *Add all
active*; *Print N badges* opens `/admin/badges/print?ids=a,b,c` — a cut sheet of CR80 cards, two
across and four down per Letter/A4 page (`break-inside: avoid`). The card itself is one shared
component, `src/lib/components/admin/BadgeCard.svelte`, used by both print pages. Opening the
sheet bumps `printCount` once for each active badge on it; revoked ones still print with the band.

### 17.3 `/manufacturing/cart-mfg/buckets/new` — mint

Two scan fields, in scan order: **1. Scan your badge**, then focus jumps to **2. Scan the tub's
QR sticker**, then submit. Enhance keeps the badge value after success so one operator can mint
several tubs in a row (the sticker field clears, the badge does not). Error strings come straight
from `BadgeError` / `BucketError`. Success line: *"Bucket created — sticker X, minted by Jane."*

### 17.4 Board start-pass form (`?/start`)

One new input at the top of the existing form: **Scan your badge** (`name="badge"`, required
when `data.badgeMode === 'required'`). Lots unchanged. The pass card afterwards shows the opener
as it does now (`openedBy`), which is now the badge holder.

### 17.5 "Require badge" toggle — Badge Portal, admin only

One switch, one place. It lives at the top of `/admin/badges`, above the issue form:

```
Require badge at mint and start-pass     [ ON ]     changed 2026-09-30 by alejandro
```

- **Gate:** the `setBadgeMode` action checks `isAdmin(locals.user)` and returns 403 otherwise —
  the same gate as the rest of the portal, so a non-admin can neither see the page nor POST to it.
  The switch is not rendered anywhere a non-admin can reach.
- **Write:** `ManufacturingSettings.updateOne({ _id: 'default' }, { $set: { 'badge.mode': m,
  'badge.changedAt': now, 'badge.changedBy': { _id, username } } })`. `badge.changedAt` /
  `badge.changedBy` are two extra fields in §15.5 so the portal can show who last flipped it.
- **Audit:** every flip writes `AuditLog` (`tableName: 'manufacturing_settings'`,
  `action: 'BADGE_MODE'`, `oldData: { mode }`, `newData: { mode }`, `reason` optional text field on
  the switch). Turning enforcement *off* is the flip that matters for traceability, so it is never
  silent.
- **Effect is immediate:** `badgeMode()` reads the setting per request (no cache), so the next
  mint or start-pass honours the new value with no deploy and no restart.
- **Board:** `/manufacturing/cart-mfg/buckets` shows a one-line read-only note in the mint / start
  area — *Badge required: on* / *off* — so operators know why the field is or is not there. The
  board does **not** get a switch; the thermoseal *Development settings* card is unrelated and
  stays as it is.

The previous draft of this section put the switch on the board's development-settings card;
moved here so the gate is one `isAdmin()` check in one route rather than two.

---

## 18. Files

| File | Change |
|---|---|
| `src/lib/server/db/models/operator-badge.ts` | **new** |
| `src/lib/server/db/models/custody.ts` | **new** |
| `src/lib/server/db/models/index.ts` | export both |
| `src/lib/server/db/models/bucket-transaction.ts` | + `enteredBy`, `attribution` |
| `src/lib/server/db/models/bucket-cycle.ts` | + `custodyId` |
| `src/lib/server/db/models/manufacturing-settings.ts` | + `badge.mode` |
| `src/lib/server/services/badge-service.ts` | **new** — §16.1 |
| `src/lib/server/services/bucket-service.ts` | `requireBadge`, `releaseCustody`, gated `createBucket` / `startCycle`, badge guards, `resolveScan` badge kind, `logTx` attribution |
| `src/routes/admin/+layout.server.ts`, `+layout.svelte` | Badges tab |
| `src/routes/admin/badges/+page.server.ts`, `+page.svelte` | **new** — portal + **Require badge** toggle (`setBadgeMode`, `isAdmin` gate) |
| `src/routes/admin/badges/[badgeId]/print/+page.server.ts`, `+page.svelte` | **new** — print |
| `src/routes/admin/badges/print/+page.server.ts`, `+page.svelte` | **new** — batch print sheet (`?ids=`) |
| `src/lib/components/admin/BadgeCard.svelte` | **new** — the CR80 card, shared by both print pages |
| `src/routes/manufacturing/cart-mfg/buckets/new/+page.server.ts`, `+page.svelte` | badge field |
| `src/routes/manufacturing/cart-mfg/buckets/+page.server.ts`, `+page.svelte` | badge on `?/start`, `badgeMode` in load, read-only "Badge required" note on the board |
| `BUCKET-SYSTEM_PLAN.md` | one build-history row + §6.1 / §9.4 notes, same commit as the bucket-side code |

Not touched: `src/lib/stores/`, `src/lib/utils/`, `app.html`, `app.css`, `static/`, `hooks.server.ts`, `permissions*.ts`.

### 18.1 Build order (each step leaves `npm run check` at the 12-error baseline)

1. Models + index exports + `badge-service.ts`. No behaviour change.
2. Badge Portal + print page + admin tab. Badges can be issued and printed; nothing consumes them yet.
3. `bucket-service.ts`: `requireBadge`, custody, guards, attribution — with `badge.mode` read but the
   two UI forms not yet sending a badge, so run this step with mode `off` in the dev DB.
4. `buckets/new` + board `?/start` forms; flip mode to `required`.
5. `BUCKET-SYSTEM_PLAN.md` row; `progress.txt` entry; push; PR to `feat/bucket-system`.

### 18.2 Verification checklist

- Issue a badge for a user with `manufacturing:write`, print it, scan it into the mint page: bucket
  created, `BucketTransaction.mint` has `operator` = holder, `enteredBy` = session, `attribution.method = 'badge'`.
- Start a pass with the badge: `Custody` row open, `BucketCycle.custodyId` set, `openedBy` = holder.
- Scan the badge into the cart scan-in box: refused, no `CartridgeRecord` created.
- Scan the badge as a sticker at mint: refused.
- Revoke the badge: mint and start refuse with the revoke message; the print page shows REVOKED.
- A badge whose user lacks `manufacturing:write`: refused even though the session is allowed.
- Close the pass by every path in §16.3: `Custody.releasedAt` set, `releaseReason` correct. **Void too.**
- Toggle **Require badge** off in the portal as an admin: both forms accept an empty badge; rows carry `method: 'login'`; the board note reads *Badge required: off*. A non-admin session POSTing `?/setBadgeMode` gets 403.
- A second active badge for the same user: 409 from the portal.

---

## 19. Deferred from v1 (ordered by the audit in §13)

1. Fold `capture_stations.currentOperator` and `robot-arm-lock` into `Custody` (§13.0).
2. `AuditLog.attribution` — one change, every mutation (§13.4).
3. Opentrons operator login to badge (§13.2).
4. Free-text `performedBy` fields to badge (§13.1), cleaning records first.
5. Optional scan-in at later stages, custody TTL, takeover, board "Held by" (Part 1 §8).
6. `requireBadgeFor` as a settings list once a second consumer exists (§4.4).
7. Badge + PIN as the two Part 11 components at the four signature routes (§13.5).

---

## 20. Build notes — where the code differs from the layout (2026-09-30)

Built on `feat/badge-system` in the §18.1 order. Deviations, all small:

1. **`Custody.open` boolean instead of a `releasedAt: null` partial index** (§15.2). A boolean
   equality is the unambiguous partial-filter shape; `releasedAt` is still written on release.
   `releaseCustody()` matches on `open: true` and sets `open: false`.
2. **Custody is created after the cycle, not before** (§16.2). The cycle id is fresh, so the
   custody row cannot collide, and a failed cycle create leaves no orphan custody. Simpler than
   unwinding.
3. **Non-gated ledger rows do not carry `custodyId`** (§16.4). Looking it up would add a read to
   the scan-in hot path (§6.2.1 of the bucket plan) for a value that is already on
   `BucketCycle.custodyId`. They carry `enteredBy = operator = session` and `{ method: 'login' }`.
4. **A badge scanned while enforcement is off is still honoured.** `requireBadge()` only falls back
   to the session when the scan is *empty*; a present badge is resolved and attributed. Better
   data for free during rollout, no behaviour change for anyone who does not scan.
5. **Badge errors surface as `BucketError`** so the two route files' existing `wrap()` /
   `try` blocks need no change. Codes: `BADGE_REQUIRED`, `BADGE_INVALID`, `BADGE_UNKNOWN`,
   `BADGE_REVOKED`, `BADGE_INACTIVE`, `BADGE_FORBIDDEN`, `BADGE` (a badge scanned as a sticker
   or cart). The mint page clears the badge field on any `BADGE*` failure and the sticker field
   otherwise.
6. **`resolveBadge()` bumps `lastUsedAt` fire-and-forget**; the print page bumps `printCount` on
   load (active badges only).
7. **Print page uses `bwip-js/browser` `qrcode` at scale 8 with default error correction** — the
   `eclevel` option is not in the package's `RenderOptions` typing.
 8. **Batch print added after the first push** (§17.2): `getBadges(ids)` keeps selection order and
   drops unknown ids; `bumpPrintCount` takes one id or a list (`updateMany`).

`npm run check`: 14 errors before, 14 after — all pre-existing (`research-proxy.ts` ×2,
`r2.ts`, `AskBimsWidget.svelte`, `assembly/[sessionId]` ×8, `validation/magnetometer/[sessionId]` ×2 —
the two `research-proxy.ts` errors are new on master since the bucket plan recorded 12). None in any file this branch touches.

**Not yet done from §18.1:** step 5 push / PR, and the §18.2 checklist has not been run against a
live database — a dev DB with at least one issued badge is needed for that.
