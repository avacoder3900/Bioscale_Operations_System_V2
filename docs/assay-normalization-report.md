# Assay Document Normalization — Post-Fix Audit

**Date:** 2026-04-16
**Scope:** Re-audit of `assay_definitions` after the BIMS write-path fix. This report focuses narrowly on bringing the 32 outlier documents into structural agreement with the 206-document majority.

---

## 1. Current state

| Signature | Doc count | Status |
|---|---|---|
| #1 — canonical legacy | **206** | Treat as the target shape |
| #2 — clinical assays | 3 | Outlier (different `BCODE` shape + extra clinical fields) |
| #3 — `useSingleCost` added | 5 | Minor outlier (one extra field) |
| #4 — `useSingleCost` + empty `lockedBy` | 24 | Minor outlier (two extra fields, one is a stray empty object) |
| **Total** | **238** | **32 docs need normalization** |

Re-running the BIMS-shape scanner (`scripts/find-bims-assays.ts`) confirms zero documents bear the BIMS-creation fingerprint — every one of the 238 still carries the legacy markers (`A########` ID, `BCODE`, `hidden`, `protected`). The write-path changes are dormant until someone actually creates an assay through BIMS. Nothing in mongo has been altered.

### What "match the majority" means

The 206-doc canonical shape (signature #1) is exactly:

```
keys: BCODE, __v, _id, corrections, createdAt, description, duration,
      hidden, isActive, name, protected, reagents, updatedAt, versionHistory
```

with `BCODE` shaped as `{ deviceParams: {...}, code: [...] }`. The 32 outliers diverge from this on a handful of specific keys. The fix per cluster is below.

---

## 2. Per-signature normalization plan

### Signature #2 — clinical assays (3 docs)

**Affected docs:**
- `A1A2B3C4` — "CRP Quantitative"
- `A5E6F7D8` — "IL-6 Quantitative"
- `A9B0C1D2` — "TNF-alpha Semi-Quantitative"

**Divergences from canonical:**
1. `BCODE` is a **bare array** — should be wrapped as `{ deviceParams: DEFAULT, code: <array> }`.
2. Has 7 extra fields not in the canonical shape: `cartridgeLife`, `diluent`, `functions`, `lotLife`, `matrix`, `version`, `useSingleCost`.

**Recommendations (decision required):**

| Field | Sample value | Recommendation |
|---|---|---|
| `BCODE` (array) | `[{command:"START",…},…]` | **Wrap** in `{ deviceParams: DEFAULT_DEVICE_PARAMS, code: <array> }`. Required for shape parity. |
| `cartridgeLife` | `180` | **Decision needed** — drop, or migrate to `shelfLifeDays` (already in schema)? |
| `lotLife` | `365` | **Decision needed** — drop, or stash under a new `lifecycle: { lotLife, cartridgeLife }` block? |
| `diluent` | `"PBS-T"` | **Decision needed** — discard, or move to `metadata.diluent`? |
| `matrix` | `"Serum"` | Same as `diluent`. |
| `functions` | `{ standard: {...}, cutoff: {...} }` | **Likely worth preserving** — looks like a calibration/scoring spec. |
| `version` | `"1.0"` | Drop. The schema's `versionHistory.length` already serves this purpose. |
| `useSingleCost` | `false` | Drop (it's the schema default — see signature #3 discussion). |

The clinical commands inside the `BCODE` array (`START`, `DELAY`, `MOVE`, `READ`, `FINISH`) **also differ** from the canonical Title-Case vocabulary (`Start Test`, `Delay`, `Move Microns`, `Read Sensor`, `Finish Test`). Bringing these to full firmware-compatible parity is a separate effort — wrapping the array gets the *structure* right but not necessarily the *content*. Flag for firmware review before promoting these 3 to production use.

### Signature #3 — extra `useSingleCost` (5 docs)

**Affected docs:**
- `AA812E34` — "Exp 256 6 -> 7"
- `A3DAD9AE` — "B code transition the big yank COPY"
- `A0A85E21` — "Gen 5 Optical Scan Test"
- `A11A0CFE` — "Bait Assay"
- `AB024599` — "Bait Assay COPY"

**Divergence from canonical:** has the field `useSingleCost: false`.

**Recommendation:** **Leave as-is.** `useSingleCost` is declared in the current Mongoose schema with `default: false`, so it's a legitimate field that just happens to have been written explicitly on these 5 docs. Removing it would only hide it from the doc; the value would still be `false` to any reader. If absolute key-set parity is desired, run `$unset: { useSingleCost: 1 }` against these 5; otherwise no action.

### Signature #4 — extra `useSingleCost` + empty `lockedBy` (24 docs)

**Divergences from canonical:**
1. `useSingleCost: false` — same as signature #3. Same recommendation: optional `$unset`.
2. **`lockedBy: {}`** — an empty object on every one of these 24. Misleading: it implies the assay was locked by someone, but `lockedAt` is absent on all 24, so they were never actually locked. The empty `{}` is a Mongoose schema artifact — when the schema declares `lockedBy: { _id: String, username: String }`, Mongoose can instantiate it as an empty subdoc on `.create()` even when no value is supplied.

**Recommendation:** **`$unset` the empty `lockedBy`** on all 24 docs (and drop `useSingleCost` if you want full parity). This is safe — none of these were ever locked, and a reader checking `if (assay.lockedAt)` would already give the right answer; the empty `lockedBy` only causes problems for code that checks `if (assay.lockedBy)` (which would currently be true even though the assay isn't locked).

To prevent future occurrences, the `AssayDefinition` schema's `lockedBy` field should be wrapped or made conditional so Mongoose doesn't auto-instantiate it on `.create()`. The simplest fix is to declare it with a sub-schema and `_id: false`, or to use `Schema.Types.Mixed`.

---

## 3. Suggested migration script

A single migration would handle all 32 outliers. Sketch:

```js
// scripts/normalize-assay-shapes.ts (proposed — NOT YET WRITTEN)
const DEFAULT_DEVICE_PARAMS = {
  delayBetweenSensorReadings: 100, integrationTime: 128, gain: 0, ledPower: 300
};

// Sig #2: wrap bare-array BCODE
db.assay_definitions.find({ BCODE: { $type: 'array' } }).forEach(d => {
  db.assay_definitions.updateOne(
    { _id: d._id },
    { $set: { BCODE: { deviceParams: DEFAULT_DEVICE_PARAMS, code: d.BCODE } } }
  );
});

// Sig #4: drop empty lockedBy
db.assay_definitions.updateMany(
  { lockedBy: {}, lockedAt: { $exists: false } },
  { $unset: { lockedBy: 1 } }
);

// (optional) Sig #3 + #4: drop useSingleCost when it equals the default
db.assay_definitions.updateMany(
  { useSingleCost: false },
  { $unset: { useSingleCost: 1 } }
);

// Sig #2 clinical fields: handle individually based on the decisions in §2.
```

Same dry-run-first / `--apply` pattern we used for the equipment label migration. The script itself is not written yet — pending the field-by-field decisions in §2.

---

## 4. Summary of recommended actions

| Action | Affects | Risk | Decision-required? |
|---|---|---|---|
| Wrap signature #2's array `BCODE` as `{deviceParams, code}` | 3 docs | Low | No |
| Decide fate of clinical fields (`cartridgeLife`, `lotLife`, `diluent`, `matrix`, `functions`, `version`) | 3 docs | Low–Med | **Yes** |
| Re-translate signature #2's `BCODE` commands to canonical Title-Case vocabulary | 3 docs | Med (firmware) | **Yes** — needs firmware review |
| `$unset` empty `lockedBy` on signature #4 | 24 docs | Very low | No |
| `$unset` `useSingleCost: false` (cosmetic key-parity) | 29 docs | Very low | Optional |
| Tighten `lockedBy` schema declaration to prevent future stray `{}` | All future writes | Low | No |

Once the decisions in §2 are made, the migration script can be written and run in one pass. Estimated end-state: a single signature for all 238 docs.

---

## 5. What this report does *not* cover

This is a narrow normalization pass. The broader recommendations from `docs/assay-shape-report.md` (read-path fixes, dead-field cleanup, reagent backfill, firmware vocabulary lock-down, hidden/protected semantics, etc.) are still open and orthogonal to this normalization.
