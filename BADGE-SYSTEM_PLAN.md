# Badge System — Operator Identity for the Bucket System (design discussion)

**Status:** design only. Nothing built, no schema written, no decision locked.
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
| Badge per **stage transition** | create, raw to unpressed, unpressed to pressed, WI-01 draw = **4** |
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
