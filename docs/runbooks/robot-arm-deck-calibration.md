# Runbook — Robot Arm Deck: generate, upload, calibrate, roll back

Operator checklist for `robotarm_cartridge_deck_001`, the single-cartridge deck used for
robot-arm bring-up. It holds **24 holes** — production cartridge 1 (rows `A`,`B`,`C` ×
columns `1`–`8`) — at the same absolute coordinates as the 576-hole production decks.

Spec: `docs/prds/ROBOTARM-01-robot-arm-deck.md`.
Geometry source of truth: `backups/labware-defs-backup-2026-07-28-pre-waxwell-restore.json`
(4-element array; **index 0** = `gen4deck_gen7cartridge_001`).

---

## ⚠ Read before you touch anything

- **Do not hand-edit coordinates.** Ever. In any file. The stored values carry floating-point
  artifacts (`8.700000000000001`, `64.82699999999998`, `1.8000000000000003`). Retyping them as
  `8.7` / `64.827` / `1.8` gives you a deck that looks right and is physically wrong. All
  coordinates are **script-copied from the backup and compared by strict equality**.
- **Do not run scripts against Mongo.** No `mongosh`, no ad-hoc `updateOne`, no seed script. The
  only supported write path is uploading the `.json` through the BIMS UI, which upserts *and*
  writes an `AuditLog` row. A direct DB write bypasses the audit trail.
- **Do not regenerate the artifact after the deck has been calibrated.** See §6 — this is the
  one mistake that silently destroys field calibration.
- **Never publish a v2 under the same `loadName`.** Calibration looks the deck up by `loadName`
  alone; two rows sharing a `loadName` make the write target arbitrary.

---

## 0. Pre-flight checklist

- [ ] You are in the worktree: `C:/Users/aleja/.worktrees/robot-arm-deck`, branch
      `feat/robot-arm-deck`.
- [ ] `git status` is clean enough that you can tell what you changed.
- [ ] The backup file exists and is **unmodified**:
      `backups/labware-defs-backup-2026-07-28-pre-waxwell-restore.json`.
- [ ] You know **which BIMS you are pointing at** — preview URL vs production. Uploads go to the
      Mongo behind whatever URL is in your browser. Confirm before step 3.
- [ ] You have `manufacturing:write` permission (the studio's jog actions require it;
      `manufacturing:read` only gets you the view).
- [ ] If a robot will actually move: the OT-2 is powered, homed, and has a tip on the pipette you
      intend to jog with.

---

## 1. Regenerate the artifact

Only for a **first-time build** or a deliberate re-baseline (see §6 first).

```bash
cd C:/Users/aleja/.worktrees/robot-arm-deck
npx tsx scripts/generate-robotarm-deck.ts
```

Writes `labware/robotarm_cartridge_deck_001.json`.

- [ ] The command exits 0.
- [ ] `git diff --stat labware/robotarm_cartridge_deck_001.json` — on a clean regenerate of an
      uncalibrated deck this should be **empty** (the generator is deterministic). A non-empty
      diff means either the generator changed or the file was calibrated — **stop and read §6**.

## 2. Run the validator and read its output

```bash
npx tsx scripts/verify-robotarm-deck.ts
```

**A good result** — exit code 0, and every check passes:

- 24 wells, named exactly `A1`–`A8`, `B1`–`B8`, `C1`–`C8`.
- Each well deep-equals backup row 0 on `x, y, z, shape, diameter, depth, totalLiquidVolume`.
- `dimensions` = `xDimension 454.8`, `yDimension 276.4`, `zDimension 12.7`.
- `cornerOffsetFromSlot` = `{x:0, y:0, z:0}`; `schemaVersion` 2.
- `namespace` `cosmas_damian`; `parameters.loadName` `robotarm_cartridge_deck_001`; top-level
  `version` 1; `displayName` `Robot Arm Deck 1 Cartridge Gen7 v1 001`; `displayCategory`
  `wellPlate`.
- `ordering` and `groups` reference the 24 retained wells and nothing else.

**A bad result** — non-zero exit with a per-field diff. Common causes:

| Symptom | Cause | Fix |
|---|---|---|
| `z` differs in the last decimal place | someone rounded a coordinate | re-run §1; never patch by hand |
| well count ≠ 24 | wrong rows/columns selected | fix the generator, not the artifact |
| `ordering`/`groups` name a well that isn't in `wells` | narrowing missed | fix the generator |
| `loadName` mismatch | identity edited by hand | fix the generator |

**Do not "fix" a validator failure by editing the JSON.** Fix the generator and re-run §1.

Sanity spot-check you can do by eye (these are the expected values, not values to type in):
row A odd columns `z = 8.700000000000001`; rows B/C odd columns `z = 8.200000000000001`; all even
columns `z = 3.3`; every well `diameter 1.8`, `depth 3.75`, `totalLiquidVolume 18`.

## 3. Upload via the BIMS UI

**Never** insert into Mongo directly.

- [ ] Confirm the environment in the URL bar one more time.
- [ ] Open the Opentrons labware manager in BIMS and use the labware upload control. It posts
      multipart to `POST /api/opentrons-lab/labware`, field name `labwareFile`.
- [ ] Select `labware/robotarm_cartridge_deck_001.json`.
- [ ] Expect **201** with
      `{ namespace: "cosmas_damian", loadName: "robotarm_cartridge_deck_001", version: 1, displayName: "Robot Arm Deck 1 Cartridge Gen7 v1 001" }`.

**Upsert semantics — worth understanding before you rely on rollback.** The endpoint keys on the
triple `(namespace, parameters.loadName, version)` and upserts:

- Same three values → **overwrites the existing row's `definition` in place.** Any calibration
  already applied to that row is gone.
- Any one of the three different → **creates a new row.** In particular a bumped `version`
  creates a *second* row sharing the `loadName`, which is the ambiguity trap called out above.

Note the endpoint reads `loadName` from `parameters.loadName` but `version` from the JSON's
**top-level** `version`.

- [ ] Confirm an `AuditLog` row exists with
      `resourceId = cosmas_damian/robotarm_cartridge_deck_001/1`.

## 4. Confirm it appears in the deck-calibration studio

Go to `/manufacturing/cart-mfg/deck-calibration` (kind = `deck`).

- [ ] `robotarm_cartridge_deck_001` is in the deck picker. (It matches the studio's deck filter
      on the `cartridge_deck` substring — no code change was needed.)
- [ ] Select it. The header reads **`24 holes · 454.8×276.4 mm · slot 1`**.
- [ ] Role counts read **12 wax / 12 reagent**. Wax = even columns 2,4,6,8; reagent = odd columns
      1,3,5,7. The studio infers this from column parity, not from the file.
- [ ] The hole map shows 24 circles clustered in **one corner of a large empty rectangle**.
      **This is correct.** The footprint is deliberately the full production deck
      (454.8 × 276.4 mm) so the cartridge sits at its true absolute position in slot 1. Empty
      space is not a bug — do not "fix" it.

If the deck does **not** appear: it's almost always the environment (you uploaded to a different
Mongo than you're browsing), not the file. Re-check §3.

## 5. Walk a calibration pass, hole by hole

Work one hole at a time and verify against the physical deck. The studio arcs between holes at a
safe height derived from the deck's own `zDimension` (12.7 mm + 80 mm clearance = **93 mm**),
clamped to a 115 mm ceiling — the same arc behaviour as the production decks.

- [ ] Pick the robot, then select a single hole (start with `A1`, a reagent hole).
- [ ] Jog X/Y until the tip is centred over the hole. Small deltas — jog, look, jog again.
- [ ] Jog Z down to the reference height for that hole's role.
- [ ] Apply. Confirm the on-screen coordinates updated and the edit appears in the history panel.
- [ ] Repeat for the remaining holes. Use the role filter (wax / reagent) to work in two passes —
      the two roles need different fill accuracy, which is why the studio separates them.
- [ ] Group operations: if the whole cartridge is offset by a constant, use the batch/uniform
      apply rather than 24 individual jogs. If the deck itself moved, use the re-baseline control.

**What good looks like**

- Tip visually centred on every hole; consistent Z touch-off across holes of the same role.
- Deltas are small and in a consistent direction (a real mechanical offset), typically well under
  a millimetre after the first hole is dialled in.
- Every apply writes a `deck_calibration_edits` row (append-only history: `wellName`, `delta`,
  `before`, `after`, `robotId`, who/when) plus a summary `AuditLog` row.
- Wax holes end near `z ≈ 3.3`, reagent holes near `z ≈ 8.2`–`8.7`, ± your real correction.

**What bad looks like — stop and investigate**

- Deltas that grow hole to hole, or flip sign across the cartridge → the deck is rotated or the
  wrong deck is selected; re-baseline instead of chasing individual holes.
- A single hole needing a correction many times larger than its neighbours → likely a mis-jog or
  a mis-selected hole. Undo it.
- **"Arc out of bounds in Z"** → a well's `z` has been inflated far beyond the deck height. Do
  not raise the ceiling; find the bad edit in the history and undo it.
- Applies that report success but nothing changes on screen → confirm you're on the deck you think
  you are, and that no second row shares this `loadName`.

Use **undo** for a mistake made in the current session — it applies the inverse delta and is
recorded like any other edit. The history is append-only by design; nothing is erased.

## 6. Rollback

**First, understand what you're rolling back.** Once uploaded, **Mongo is the source of truth.**
Calibration also mirrors edits back into the on-disk labware file (best-effort: it scans the
labware directory, `OPENTRONS_LABWARE_DIR` or the local Opentrons fallback, and rewrites the
first file whose `parameters.loadName` matches). So after any calibration the on-disk artifact
**intentionally differs** from generator output.

> **The trap:** re-running `scripts/generate-robotarm-deck.ts` restores pristine geometry and
> discards the mirrored calibration. If you then upload that file, the upsert overwrites the
> calibrated row and **every calibration is lost with no warning.** Never regenerate-then-upload
> unless a full re-baseline is exactly what you intend.

Choose the smallest rollback that works:

1. **Undo one bad jog** — use the studio's undo. Preferred. Nothing else is disturbed.
2. **Revert several holes** — read the edit history for the deck and apply inverse deltas via the
   per-well path. Still fully audited.
3. **Restore the deck to pristine geometry (full re-baseline)** — deliberate, destructive:
   - [ ] Record why, and confirm with whoever owns the robot-arm work.
   - [ ] Regenerate (§1) and validate (§2).
   - [ ] Re-upload with the **same** `namespace` / `loadName` / `version` — the upsert replaces
         the row's `definition` in place.
   - [ ] Note that `deck_calibration_edits` history is **not** deleted; it remains as the record
         of what was undone.
4. **Remove the deck entirely** — `DELETE /api/opentrons-lab/labware?namespace=&loadName=&version=`
   (all three required; audited). Only if the deck should stop appearing in the studio.

Rolling back must **not** be done by bumping `version` to 2 — that leaves two rows sharing one
`loadName` and makes every subsequent calibration write ambiguous.

---

## Quick reference

| Thing | Value |
|---|---|
| Collection | `labware_definitions` |
| Upsert key | `(namespace, parameters.loadName, version)` |
| `namespace` | `cosmas_damian` |
| `loadName` | `robotarm_cartridge_deck_001` |
| `version` | `1` (top-level in the JSON) |
| Wells | 24 — `A1`–`A8`, `B1`–`B8`, `C1`–`C8` |
| Roles | even cols = wax (12), odd cols = reagent (12) |
| Footprint | 454.8 × 276.4 × 12.7 mm, slot 1 |
| Safe arc Z | 93 mm (ceiling 115 mm) |
| Upload | `POST /api/opentrons-lab/labware`, multipart `labwareFile` |
| Delete | `DELETE /api/opentrons-lab/labware?namespace=&loadName=&version=` |
| Generator | `scripts/generate-robotarm-deck.ts` |
| Artifact | `labware/robotarm_cartridge_deck_001.json` |
| Validator | `scripts/verify-robotarm-deck.ts` |
| Geometry truth | `backups/labware-defs-backup-2026-07-28-pre-waxwell-restore.json` (index 0) |
