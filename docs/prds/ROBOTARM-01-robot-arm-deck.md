# ROBOTARM-01: Robot Arm Deck — single-cartridge deck for the calibration studio

**Author:** Alejandro Vasquez (via Claude Code)  **Date:** 2026-08-18  **Status:** Draft
**Priority:** P2 — unblocks robot-arm bring-up without tying up a 24-cartridge production deck
**Target branch:** `feat/robot-arm-deck` (off master)

---

## 1. Problem Statement

The deck-calibration studio only knows about the four 24-cartridge production decks
(`gen4deck_gen7cartridge_001`…`_004`). Every one of them exposes **576 holes**. The robot-arm
work needs a deck that holds **exactly one cartridge** — 24 holes — so that:

- an operator can walk a complete calibration pass in minutes instead of hours,
- a mis-jog cannot silently corrupt 23 other cartridges' coordinates on a shared production
  artifact, and
- the arm can be exercised against a deck whose geometry is *provably identical* to production
  cartridge 1, rather than a hand-made approximation.

There is no single-cartridge deck definition today, and no documented, repeatable way to derive
one from production geometry.

## 2. Goals

1. Ship a **schemaVersion-2 Opentrons labware definition** containing exactly the 24 wells of
   production **cartridge 1** (rows `A`,`B`,`C` × columns `1`–`8`).
2. Preserve **absolute deck coordinates**: the new deck drops into OT-2 **slot 1** and every hole
   sits at the same physical x/y/z as it does on `gen4deck_gen7cartridge_001`.
3. Derive every coordinate **by script, from the backup artifact** — no hand-typed numbers.
4. Appear in the deck-calibration studio and be fully calibratable **with zero application-code
   changes**.
5. Give operators a runbook that covers generate → validate → upload → calibrate → roll back.

## 3. Non-Goals

- No changes to the calibration studio, its actions, or `apply-edit.ts`. (§7.1 shows why none are
  needed.)
- No new Mongo collection, model, or migration. The deck is a row in `labware_definitions` like
  any other labware.
- No script or artifact writes performed by this PRD's author — the operator uploads through the
  UI (§7.4).
- No re-derivation of cartridges 2–24, and no changes to the four production decks.
- No robot-arm motion planning, gripper, or protocol work. This PRD delivers **geometry only**.

## 4. Current State

### 4.1 A deck is just a labware row

`src/lib/server/db/models/labware-definition.ts` stores the whole Opentrons JSON in a `Mixed`
field, keyed by a unique triple:

```ts
// labware-definition.ts:23
labwareDefinitionSchema.index({ namespace: 1, loadName: 1, version: 1 }, { unique: true });
```

Collection: `labware_definitions`. Fields: `namespace`, `loadName`, `version`, `displayName`,
`category`, `fileName`, `definition`, `uploadedBy`.

### 4.2 The studio selects decks by a name regex

`src/routes/manufacturing/cart-mfg/deck-calibration/+page.server.ts`:

```ts
// :36
const DECK_RE = /(gen4deck|cartridge_deck)/i;
// :41
const SLOT_FOR_KIND: Record<string, string> = { deck: '1', tube: '10', tip: '11' };
// :50
const decks = defs.filter((d) => DECK_RE.test(d.loadName)).map(toOpt).sort(...);
```

The selected definition is then read for **only two** sub-objects — `wells` and `dimensions`:

```ts
// :72-74
const def = (await LabwareDefinition.findOne({ loadName: selected }).lean()) as any;
const wmap = def?.definition?.wells ?? {};
const dim  = def?.definition?.dimensions ?? {};
```

`load()` is gated by `requirePermission(locals.user, 'manufacturing:read')` (`:45`); the write
actions `applyBatch` (`:115`) and `applyPerWell` (`:169`) require `manufacturing:write`.

### 4.3 Hole role is column parity, computed client-side

`+page.svelte:85` — the studio does not read a role from the definition; it infers it:

```ts
function roleOf(name: string): Role { return colOf(name) % 2 === 0 ? 'wax' : 'reagent'; }
```

with `waxCount` / `reagentCount` derived at `:88-89`.

### 4.4 Safe-arc height comes from `dimensions.z`, not from the wells

`+page.svelte:609`:

```ts
const safeArcZ = $derived(Math.min(Math.round((dim.z || 12.7) + ARC_CLEARANCE_MM), ARC_CEILING_MM));
```

(`ARC_CLEARANCE_MM = 80`, `ARC_CEILING_MM = 115`.) The in-code comment records why: a deck whose
wells had crept to 82 mm produced `safeArcZ` 162 and the "Arc out of bounds in Z" gantry error.

### 4.5 Upload is an upsert on the triple

`src/routes/api/opentrons-lab/labware/+server.ts` — `POST`, multipart field `labwareFile`:

```ts
// :37-39
const namespace = def?.namespace;
const loadName  = def?.parameters?.loadName;
const version   = Number(def?.version ?? 1);
// :43-44
const displayName = def?.metadata?.displayName ?? loadName;
const category    = def?.metadata?.displayCategory ?? 'Other';
// :46-52
await LabwareDefinition.findOneAndUpdate({ namespace, loadName, version }, {...}, { upsert: true, new: true });
```

Note `version` is read from the JSON's **top-level** `version`, while `loadName` comes from
**`parameters.loadName`**. `DELETE /api/opentrons-lab/labware?namespace=&loadName=&version=`
removes a row. Both paths write an `AuditLog` row with
`resourceId = \`${namespace}/${loadName}/${version}\``.

### 4.6 Calibration writes — and the two traps

`src/lib/server/services/deck-calibration/apply-edit.ts` exposes `applyDeckEditBatch` (`:187`),
`applyDeckEditsPerWell` (`:314`) and `deckEditHistory` (`:421`). Each edit appends a
`DeckCalibrationEdit` row (append-only correction history) plus a summary `AuditLog` row, then
updates the live coords.

**Trap 1 — lookup is by `loadName` alone.** Not the unique triple:

```ts
// :195 (and :325)
const def = (await LabwareDefinition.findOne({ loadName: deckLoadName }).lean()) as any;
// :253 (and :371)
await LabwareDefinition.updateOne({ loadName: deckLoadName }, { $set: setOps });
```

If two rows ever share a `loadName` (different `namespace`, or a bumped `version`), the write
target is arbitrary.

**Trap 2 — edits are mirrored back onto disk.** `LABWARE_DIR` (`:22`,
`process.env.OPENTRONS_LABWARE_DIR` with a local Opentrons-directory fallback) is scanned and the
**first file whose `parameters.loadName` matches is overwritten in place** (`:270-292`):

```ts
if (json?.parameters?.loadName === deckLoadName) {
  for (const r of results) { if (json.wells?.[r.wellName]) { json.wells[r.wellName].x = r.after.x; /* y, z */ } }
  fs.writeFileSync(fp, JSON.stringify(json, null, 2));
}
```

So a calibrated deck's on-disk JSON diverges from generator output **by design**. Mongo is the
source of truth; the file mirror is best-effort.

## 5. Reference / Prior art

- Geometry source of truth (read-only, never edited):
  `backups/labware-defs-backup-2026-07-28-pre-waxwell-restore.json` — a 4-element array; **index
  0** is `cosmas_damian` / `gen4deck_gen7cartridge_001` / v1, 576 wells.
- Related PRDs: `docs/prds/DECK-CALIBRATION-STUDIO.md`,
  `docs/prds/CALIB-1-DECK-JSON-HOLE-TUNER.md`,
  `docs/prds/DECK-CAL-ALIGN-CARTRIDGE-TO-HOLE.md`,
  `docs/prds/DECK-CAL-REBASELINE-WHOLE-DECK.md`.
- Operator-runbook tone precedent: `docs/LAB-MAC-RUNBOOK-OT2-BRIDGE.md`.

## 6. Data Model & Source

### 6.1 Deck grid, as verified in the backup

Row 0's 576 wells form a **24 × 24** grid: rows `A`–`X` (24 letters) × columns `1`–`24`. That is
8 cartridge-rows × 3 channels vertically, and 3 X-column-groups × 8 columns horizontally.
**Cartridge 1 = rows `A`,`B`,`C` × columns `1`–`8` = 24 wells.**

### 6.2 Verified cartridge-1 facts

Read from the backup, not asserted:

| Property | Value |
|---|---|
| Wells | 24 (`A1`–`A8`, `B1`–`B8`, `C1`–`C8`) |
| Odd columns 1,3,5,7 | **reagent** holes |
| Even columns 2,4,6,8 | **wax** gates (Gate4/3/2/1) |
| `z`, row A odd | `8.700000000000001` |
| `z`, rows B/C odd | `8.200000000000001` |
| `z`, all even (wax) | `3.3` |
| Every well | `shape: "circular"`, `diameter: 1.8`, `depth: 3.75`, `totalLiquidVolume: 18` |
| Per-well keys | `depth, totalLiquidVolume, shape, diameter, x, y, z` |

Distinct x values are shared down each column (e.g. col 1 = `52.827`, col 5 =
`64.82699999999998`); y varies by row and by role.

### 6.3 Why coordinates must be script-copied

The stored values carry IEEE-754 representation artifacts — `1.8000000000000003`,
`8.700000000000001`, `64.82699999999998`. Hand-typing or "tidying" these to `1.8` / `8.7` /
`64.827` produces a deck that is *visually* right and *numerically* different from production.
**Rule: coordinates are copied by script and compared by deep equality; never retyped, never
rounded.**

### 6.4 New identity (decided; not open)

| Field | Value |
|---|---|
| `namespace` | `cosmas_damian` |
| `parameters.loadName` | `robotarm_cartridge_deck_001` |
| `version` (top level) | `1` |
| `metadata.displayName` | `Robot Arm Deck 1 Cartridge Gen7 v1 001` |
| `metadata.displayCategory` | `wellPlate` |
| `dimensions` | `{ xDimension: 454.8, yDimension: 276.4, zDimension: 12.7 }` — unchanged |
| `cornerOffsetFromSlot` | `{ x: 0, y: 0, z: 0 }` — unchanged |
| `schemaVersion` | `2` |

`ordering` and `groups` must be narrowed to the 24 retained wells so the definition stays valid
Opentrons labware, even though the studio reads neither (§4.2).

## 7. Design / Architecture

### 7.1 Why zero code changes are required

Three independent mechanisms line up:

1. **Discovery.** `DECK_RE = /(gen4deck|cartridge_deck)/i` matches `robotarm_cartridge_deck_001`
   on the `cartridge_deck` alternative. The deck appears in the picker with no regex edit.
2. **Roles.** `roleOf` is pure column parity, so columns 2,4,6,8 classify as wax and 1,3,5,7 as
   reagent automatically: **12 wax / 12 reagent**.
3. **Slot + arc.** `SLOT_FOR_KIND.deck = '1'` is already correct, and keeping `zDimension` at
   `12.7` keeps `safeArcZ` at `Math.round(12.7 + 80) = 93` mm — byte-identical arc behaviour to
   the production decks, well under the 115 mm ceiling.

This is the core design bet: **the deck is data, not code.**

### 7.2 Why absolute coordinates are kept (not re-origined to 0,0)

Re-basing cartridge 1 to the slot origin would make the definition "tidier" but would break
physical equivalence: the deck plate is the same plate, in the same slot, and the arm must reach
the same points. Keeping the footprint and absolute coords means a calibration learned on this
deck transfers to production cartridge 1 by inspection, and vice-versa.

### 7.3 Generator / validator split

- `scripts/generate-robotarm-deck.ts` — reads the backup, selects the 24 wells, rewrites identity
  and `ordering`/`groups`, emits the artifact. Referenced **by path only**; owned elsewhere.
- `labware/robotarm_cartridge_deck_001.json` — the emitted artifact.
- `scripts/verify-robotarm-deck.ts` — re-reads backup + artifact and asserts equivalence.

The generator is deterministic and re-runnable; the validator is the gate.

### 7.4 Nothing writes to Mongo from a script

The operator uploads the artifact through the existing UI, which hits
`POST /api/opentrons-lab/labware`. That path already upserts on the unique triple and writes an
`AuditLog` row (§4.5). A direct `mongosh`/script insert would bypass the audit trail and the
`displayName`/`category` derivation, so it is **prohibited**.

### 7.5 `loadName` uniqueness is a hard constraint

Because calibration writes key on `loadName` alone (§4.6, Trap 1), `robotarm_cartridge_deck_001`
must remain globally unique across every namespace and version in `labware_definitions`.
Corollary: **never publish a v2 under the same `loadName`.** A revision ships as a new
`loadName` (`…_002`) or replaces v1 in place.

## 8. UX Spec

No new UI. The deck appears in the existing studio at
`/manufacturing/cart-mfg/deck-calibration?kind=deck&deck=robotarm_cartridge_deck_001`.
Expected header line (`+page.svelte:1027`): `24 holes · 454.8×276.4 mm · slot 1`. The hole map
renders 24 circles clustered in the lower-left of the full-size footprint — that empty expanse is
**correct**, not a rendering fault, and the runbook says so explicitly. Existing tron tokens,
role filter, selection, undo and re-baseline controls all work unmodified.

## 9. Stories

- **ROBOTARM-01-S1 — Generate the artifact.**
  **AC:** `scripts/generate-robotarm-deck.ts` writes
  `labware/robotarm_cartridge_deck_001.json` with exactly 24 wells, and running it twice produces
  byte-identical output.
- **ROBOTARM-01-S2 — Geometry equivalence.**
  **AC:** for each of the 24 names, artifact well deep-equals backup row-0 well on
  `x, y, z, shape, diameter, depth, totalLiquidVolume` — strict equality, no epsilon, no rounding.
- **ROBOTARM-01-S3 — Envelope preserved.**
  **AC:** `dimensions` = `454.8 / 276.4 / 12.7`, `cornerOffsetFromSlot` all zero,
  `schemaVersion` 2, and `ordering`/`groups` reference exactly the 24 retained wells and nothing
  else.
- **ROBOTARM-01-S4 — Identity correct.**
  **AC:** `namespace` `cosmas_damian`, `parameters.loadName` `robotarm_cartridge_deck_001`,
  top-level `version` 1, `metadata.displayName` / `displayCategory` as §6.4 — and `loadName`
  matches `DECK_RE`.
- **ROBOTARM-01-S5 — Validator gate.**
  **AC:** `scripts/verify-robotarm-deck.ts` exits non-zero with a per-field diff on any S2–S4
  breach, and zero on a clean artifact.
- **ROBOTARM-01-S6 — Studio round-trip.**
  **AC:** after UI upload the deck is selectable, header reads `24 holes`, role counts show
  12 wax / 12 reagent, and one jog on one hole writes a `DeckCalibrationEdit` row plus an
  `AuditLog` row.
- **ROBOTARM-01-S7 — Docs.**
  **AC:** this PRD and `docs/runbooks/robot-arm-deck-calibration.md` exist, and the runbook's
  rollback section matches the upsert-key semantics in §4.5.

## 10. Open Questions / Risks

**Risks**

| # | Risk | Mitigation |
|---|---|---|
| R1 | **Regenerating after calibration silently reverts field work.** Calibration overwrites the on-disk artifact (§4.6 Trap 2); re-running the generator restores pristine geometry and the next upload would push stale coords over calibrated ones. | Runbook: generate **only** before first upload. After go-live, Mongo is truth; never re-upload a regenerated artifact without an explicit re-baseline decision. |
| R2 | **`loadName` collision makes calibration writes ambiguous** (§4.6 Trap 1). | §7.5 constraint; validator asserts the exact `loadName`; never ship v2 under the same name. |
| R3 | Operator uploads the artifact to the wrong environment (dev vs prod Mongo). | Runbook pre-flight: confirm the BIMS URL before upload; check `AuditLog` afterwards. |
| R4 | Rounded/retyped coordinates pass visual review but fail physically. | §6.3 rule + S2 strict deep-equality AC. |
| R5 | A future edit to `DECK_RE` that drops the `cartridge_deck` alternative would silently hide this deck. | Documented dependency here and in the runbook; S6 is the regression check. |

**Open questions — need the user**

- **Q1.** Should the robot-arm deck be excluded from the production decks list once robot-arm work
  ends, or left permanently in the picker? (Affects whether we ever `DELETE` the row.)
- **Q2.** Is a physical single-cartridge deck plate actually machined, or is this deck exercised
  on the production plate with only cartridge 1 populated? This changes whether calibration
  results should be copied back to `gen4deck_gen7cartridge_001`.
- **Q3.** Should `brand.brandId` stay `["BT-042","BT-042-101"]` (inherited from gen4deck) or get a
  robot-arm-specific id?

## 11. Test / Validation Plan

1. `npx tsx scripts/verify-robotarm-deck.ts` — must exit 0 (S2–S4).
2. `npm run check` — TypeScript/Svelte clean. No `.svelte` files change, so no UI regression
   surface.
3. Vercel preview on `feat/robot-arm-deck`; upload the artifact via the UI on the preview first.
4. Real-data parity: open the studio on `gen4deck_gen7cartridge_001`, note cartridge-1 hole
   coordinates, compare against the new deck's — they must read identically.
5. One jog on one hole; confirm `deck_calibration_edits` and `AuditLog` rows; undo it.

## 12. Out of Scope

Robot-arm kinematics, gripper control, protocol generation, cartridges 2–24, any change to the
four production decks, and any automated Mongo write.

---

## Appendix A — File change map

| Action | Path | Owner |
|---|---|---|
| Add | `docs/prds/ROBOTARM-01-robot-arm-deck.md` | this PRD |
| Add | `docs/runbooks/robot-arm-deck-calibration.md` | this PRD |
| Add | `scripts/generate-robotarm-deck.ts` | separate unit — referenced by path only |
| Add | `labware/robotarm_cartridge_deck_001.json` | separate unit — generated artifact |
| Add | `scripts/verify-robotarm-deck.ts` | separate unit — referenced by path only |
| Modify | *(none)* | zero application-code changes — §7.1 |

## Appendix B — Reference pointers

- `backups/labware-defs-backup-2026-07-28-pre-waxwell-restore.json` (index 0) — geometry truth
- `src/lib/server/db/models/labware-definition.ts`
- `src/lib/server/db/models/deck-calibration-edit.ts`
- `src/lib/server/services/deck-calibration/apply-edit.ts`
- `src/routes/manufacturing/cart-mfg/deck-calibration/+page.server.ts` / `+page.svelte`
- `src/routes/api/opentrons-lab/labware/+server.ts`
- PRDs: `DECK-CALIBRATION-STUDIO.md`, `CALIB-1-DECK-JSON-HOLE-TUNER.md`,
  `DECK-CAL-ALIGN-CARTRIDGE-TO-HOLE.md`, `DECK-CAL-REBASELINE-WHOLE-DECK.md`
