# VALIDATION-06: Optical Confirmation — Group Workspace & Group-vs-Group Comparison

**Author:** Alejandro (via Claude Code)  **Date:** 2026-07-30  **Status:** Draft
**Priority:** P2 — groups shipped without a home; three group actions have no UI at all
**Target branch:** `feat/optical-group-workspace` (off `master` @ `7e6ec7f6`)

---

## 1. Problem Statement

PR #39 shipped optical analysis groups, but a group has nowhere to live. You can create one
from checked rows on the cartridge log, and after that it exists only as a coloured chip.

Concretely, today:

- **There is no route that lists groups.** `src/routes/validation/` contains exactly 13 pages and
  none of them is a groups list. Groups appear only as chips on
  `optical-confirmation/+page.svelte:394-439`, as the Group column at `:496-508`, and as pills on
  the analyze page.
- **Three of the five group actions have no caller.** `renameGroup`
  (`optical-confirmation/+page.server.ts:329-384`), `removeFromGroup` (`:386-428`) and
  `archiveGroup` (`:431-466`) are implemented, permission-checked and audit-logged — and nothing
  in `src/` posts to them. Only `?/saveGroup` is ever called, from `+page.svelte:287` and `:356`.
- **You cannot see what is in a group.** The log page's load deliberately strips `cartridgeIds`
  from the returned `groups[]` (`+page.server.ts:103-109`), and the analyze page never selects
  `description` (`analyze/+page.server.ts:82`), so descriptions are write-only.
- **Analyzing one group means the comparison page**, which leads with a strip plot and per-well
  robust tables. That is the right tool for spotting outliers visually and the wrong one for
  reading numbers off a table.
- **There is no group-vs-group summary.** `compareGroups` emits per-well pairwise deltas on
  *median* (`optical-analysis.ts:514-532`), but nothing anywhere puts Group A's avg / stdev / CV
  next to Group B's with a difference between them.

The need: a place to build groups from cartridges that have already run, read one group's numbers
in a plain table, and put two groups side by side to see the difference — with a button to open up
the per-channel breakdown.

### Decisions locked with the user (2026-07-30)

- **SPU line-up is scrapped.** An earlier draft aligned the two groups row-by-row by SPU. Dropped.
  There is no matching, no paired difference, and no "unmatched SPU" section in this PRD.
- **Headline stats are avg / stdev / CV**, with **median alongside** as a skew check. Outlier
  flagging keeps the robust rule underneath.
- **Tables only. No charts** on the new views.
- **The existing `/analyze` page is untouched** and keeps its strip plot.
- **Compare view** = group totals + difference, expanding to per-well rows.
- **Group analyze view** = one row per cartridge, with a totals row.

---

## 2. Goals

1. A **Groups workspace** at `/validation/optical-confirmation/groups` listing every
   `purpose: 'optical_analysis'` group with name, colour, member count and description.
2. **Build a group from cartridges that have already run** — the picker offers only cartridges
   carrying readings, because those are the only ones any statistic can be computed from.
3. **Analyze one group** at `groups/[groupId]`: a totals row (n / avg / stdev / CV / median) over
   the group, and one row per cartridge showing barcode, SPU and F7/F3 for wells A/B/C. No charts.
4. **Compare two groups** at `groups/compare?a=&b=`: Group A and Group B columns each with
   n / avg / stdev / CV / median, plus a Difference column. One row for the overall F7/F3;
   a button expands it into three rows, one per well.
5. **Give the three orphaned actions a UI** — rename, remove cartridges, archive.

---

## 3. Non-Goals

- **SPU-aligned / paired comparison.** Explicitly scrapped by the user.
- **Any chart** on the new routes.
- **Changing `/validation/optical-confirmation/analyze`.** It keeps the strip plot and the robust
  per-well tables. Two views, two questions.
- **p-values, t-tests or ANOVA.** The reasoning in `optical-analysis.ts:699-710` still holds:
  at n≈5–10 there is no power, and the repo's `tTest` is pooled-variance over an `incompleteBeta`
  its own source labels not production-grade. Everything here is descriptive.
- **Applying `opticalCalibration` factors.** Raw F7/F3 only.
- **Surfacing `purpose: 'assign_batch'` groups.** Created by the assign endpoint; invisible here.
- Comparing more than two groups at once.

---

## 4. Current State

### 4.1 The group model already supports everything this needs

`src/lib/server/db/models/cartridge-group.ts:21-58`:

```ts
purpose: { type: String, enum: ['assign_batch', 'optical_analysis'], default: 'assign_batch' },
cartridgeIds: { type: [String], default: [] },   // cartridge_records._id === the barcode
archivedAt: Date
```

Indexes at `:52-54` (`{purpose,name}`, `{cartridgeIds}`, `{archivedAt}`) — none unique, deliberately
(`:48-51`). **No schema change is required by this PRD.**

### 4.2 The actions exist and are audit-logged

`saveGroup` (`+page.server.ts:202-327`) handles create and append, enforces one-group-per-cartridge
via `$pull` from other groups (`:274-294`), and returns 409 with `existingGroupId` on a name clash
(`:236-255`) rather than silently merging. `renameGroup` `:329-384`, `removeFromGroup` `:386-428`,
`archiveGroup` `:431-466` (soft delete, `$set: {archivedAt}`, AuditLog action `RETIRE`).

All five follow the house pattern: `requirePermission(locals.user, 'cartridge:write')` →
`connectDB()` → validate → mutate → `AuditLog.create({tableName, recordId, action, oldData,
newData, changedBy, changedAt, reason})`.

### 4.3 The engine already computes almost every number needed

`robustStats(values, threshold): RobustStat` (`optical-analysis.ts:209`) returns **both** families:

- classic, flagged display-only at `:54`: `mean`, `sd`, `cv`, `bandLow`, `bandHigh`, `mode`
- robust: `median`, `mad`, `madScaled`, `q1`, `q3`, `iqr`, `scale`, `scaleEstimator`, `robustCv`,
  `robustLow`, `robustHigh`, `degenerate`

So **avg / stdev / CV / median all already come out of one call.** `analyzeGroupRobust` (`:563`)
already produces these per well across a group's cartridges, and retains the full
`CartridgeAnalysis` per row (`GroupCartridgeRow2.analysis`, `:492`).

### 4.4 What is genuinely missing

There is **no across-well "overall" value**. `ChannelAnalysis` is per well; `ratioByChannel` is
`{A, B, C}`. Nothing combines a cartridge's three wells into one number, so nothing can produce the
single top-level row the compare view needs.

`GroupComparisonDelta` (`:514-532`) is per-channel and compares **medians only** — no avg, stdev or
CV difference.

### 4.5 Routing note

`src/routes/validation/+layout.svelte:34-37` — `isActive()` uses `currentPath.startsWith(href)`, so
any new sub-route under `/validation/optical-confirmation/` keeps the Optical Confirmation tab lit
for free. No nav change is strictly required, though this PRD adds an in-page link.

---

## 5. Reference / Prior art

- **VALIDATION-04** — the F7/F3 analysis profile this all sits on.
- **VALIDATION-05** — the SPU validation run model, for tone.
- **PR #39** (`feat/optical-group-comparison`, master `7e6ec7f6`) — the group model, `saveGroup`,
  the robust engine, and the components this reuses.
- `src/routes/validation/runs/+page.svelte` — closest in-repo precedent for a list-of-things page
  with per-row actions.

---

## 6. Data Model & Source

**No schema changes.**

| Need | Source | Notes |
|---|---|---|
| Group identity + membership | `cartridge_groups` → `{_id, name, description, color, cartridgeIds, archivedAt}` | filter `purpose:'optical_analysis', archivedAt:null` |
| Readings | `cartridge_records.rawData.readings[]` | **undeclared on the schema** — `.lean()` is mandatory or a strict doc drops it |
| Which cartridges are optical | `OPTICAL_CARTRIDGE_FILTER` (`optical-constants.ts:21-23`) | `assayCategory:'optical_test'` OR `assayId:'A9EB41AD'` |
| "Has already run" | `rawData.readings.0` exists | Prefer this over the checkpoint-derived `ran` flag: readings presence is what actually makes a cartridge analyzable |
| SPU that ran it | `cartridge_records.device.name` (UDI), `device.id` (Particle id) | both undeclared; join verified 32/32 in prod |

**Probed against production 2026-07-30 (read-only):** 193 optical cartridges carry readings across
32 distinct SPUs; 26 SPUs have ≥2 such cartridges and 20 have ≥4, spanning 49–110 days. Building two
meaningful groups from already-run cartridges is well supported by the real data.

---

## 7. Design / Architecture

### 7.1 Derive-on-read, as before

Nothing in this feature writes a computed statistic. `cartridge_records` is never touched. The only
writes are to `cartridge_groups`, through the five existing actions, each already audit-logged.

### 7.2 Defining the "overall" F7/F3

The compare view's top row needs one number per cartridge across the three wells.

> **A cartridge's overall F7/F3 is the mean of its available well ratios (A, B, C).**
> Wells with no usable ratio are skipped, not treated as zero. A cartridge with no usable well at
> all contributes nothing and is listed as excluded.

Chosen over pooling every well reading into one bag because wells legitimately differ from one
another; pooling would fold that real between-well spread into the stdev and blunt exactly the
run-to-run signal the comparison is for.

### 7.3 Two new engine functions — purpose-built, not contorted

`compareGroups` is load-bearing for the shipped `/analyze` page. It is **not** modified. Instead add
to `src/lib/server/optical-analysis.ts`:

```ts
export interface GroupReportRow {
  id: string; label: string; spuUdi: string | null;
  ratioByChannel: { A: number|null; B: number|null; C: number|null };
  overallRatio: number | null;       // mean of available wells
  wellsUsed: number;                 // how many of A/B/C contributed
  hasReadings: boolean;
  cartridgeWarning: boolean;         // its own readings were noisy
  outlierChannels: Array<'A'|'B'|'C'>;
}

export interface GroupReport {
  groupId: string; groupName: string;
  n: number;                         // cartridges in the group
  windowK: number;
  overall: RobustStat;               // over per-cartridge overallRatio
  wells: Array<{ channel: 'A'|'B'|'C' } & RobustStat>;
  rows: GroupReportRow[];
  excluded: ExcludedCartridge[];
  flags: string[];
}

export function reportGroup(group: GroupInput, config?: Partial<OpticalConfig>): GroupReport;

export interface StatDiff {
  a: RobustStat | null; b: RobustStat | null;
  avgDiff: number | null;            // a.mean - b.mean
  avgPctDiff: number | null;         // relative to b
  sdDiff: number | null;
  cvDiffPp: number | null;           // PERCENTAGE POINTS, not a ratio of ratios
  medianDiff: number | null;
  medianPctDiff: number | null;
  underpowered: boolean;             // either side below minGroupN
}

export interface GroupDiffReport {
  computedAt: string; windowK: number; config: OpticalConfig;
  a: GroupReport; b: GroupReport;
  overall: StatDiff;
  wells: Array<{ channel: 'A'|'B'|'C' } & StatDiff>;
  notes: string[];
}

export function diffGroups(a: GroupInput, b: GroupInput, config?): GroupDiffReport;
```

Both are thin: `reportGroup` calls the existing `analyzeCartridge` per member and `robustStats` per
value set; `diffGroups` calls `reportGroup` twice and subtracts. No new statistics are invented.

**`cvDiffPp` is named for a reason.** CV is already a percentage; subtracting one CV from another
gives percentage *points*, not a percentage change. Labelling it `%` would invite a real
misreading, so the field, the column header and the CSV all say **pp**.

### 7.4 Statistical honesty carried forward

`diffGroups` reuses the `notes[]` mechanism from `compareGroups:784-801`, emitting from the engine
so the view cannot render without them:

- the raw-F7/F3 / no-calibration caveat when the two groups span more than one SPU;
- "Descriptive statistics only — no statistical test is performed and no p-values are computed";
- **new:** when a group's `mean` and `median` diverge by more than ~10%, a note that the average is
  being pulled by an extreme cartridge and the CV should be read with that in mind. This is the
  point of showing median next to avg, and it should be stated, not left for the reader to notice.

### 7.5 Routes

| Route | Purpose |
|---|---|
| `groups/+page.svelte` | list, create, select two to compare |
| `groups/[groupId]/+page.svelte` | one group: totals + per-cartridge rows |
| `groups/compare/+page.svelte` | `?a=<id>&b=<id>` |

SvelteKit resolves the static `groups/compare` ahead of the dynamic `groups/[groupId]`, so the two
coexist — but that is a subtle precedence rule, so the compare route carries a comment saying why it
must not be renamed to something a group id could collide with.

Cap: reuse `MAX_COMPARE_CARTRIDGES` (60, `optical-constants.ts:45`) per group, since each cartridge
drags ~126 readings.

---

## 8. UX Spec

Tron tokens throughout (`var(--color-tron-*)`), reusing `GroupPill`, `OutlierMark` and `csv.ts`
from `src/lib/components/validation/optical/`.

### 8.1 `groups` — the workspace

**New group panel** (collapsed, opened by `+ New group`): name · colour select · a searchable
checkbox picker of **cartridges that have already run**, showing `Barcode · SPU · A/B/C F7/F3 ·
Run date`, with an "N selected" count. Posts to the existing `?/saveGroup`.

**Group list** — one card per group:
`GroupPill (name, colour) · N cartridges · description · created`, with row actions **Analyze** →
`groups/[groupId]`, **Rename**, **Archive**, and a **compare checkbox**. A sticky bar appears once
exactly two are checked: `Compare "A" vs "B" →`. Checking a third replaces the oldest, so the
control can never be in an uncomparable state.

Empty state points back to the cartridge log, since groups can also be made from checked rows there.

### 8.2 `groups/[groupId]` — analyze one group

**Totals card** — a single row: `n · avg F7/F3 · stdev · CV % · median`, with a muted second line
naming the well count and the endpoint window.

**Cartridge table** — one row per cartridge:

| Barcode | SPU | A | B | C | Overall | Flags |
|---|---|---|---|---|---|---|

Barcode links to `/validation/optical-confirmation/[id]`. Outlier cells keep the amber `⚠` via
`OutlierMark` with its server-authored reason. A cartridge with no readings renders at `opacity-60`
with a `NO READINGS` chip and dashes, never a silent blank.

**Excluded card** below, listing anything that contributed nothing and why.

**No chart.** A short legend states the overall = mean-of-wells definition and that these are raw
ratios with no calibration applied.

### 8.3 `groups/compare` — two groups side by side

**Header:** `GroupPill A` vs `GroupPill B`, with n for each.

**Main table**, one row until expanded:

| Metric | Group A | Group B | Difference |
|---|---|---|---|
| Overall F7/F3 | n · avg · stdev · CV% · median | same | Δ avg (abs + %), Δ stdev, Δ CV (pp), Δ median |

A `▸ Show channels` button expands three further rows — **Well A**, **Well B**, **Well C** — each
with the identical five stats per group and the same four differences. Collapsed by default.

Engine `notes[]` render directly beneath the table. A `Download CSV` button emits one row per metric
(overall + 3 wells) × both groups with all differences, reusing `csv.ts` (which already quotes
correctly and defuses formula injection).

Underpowered groups (n < `minGroupN` = 5) show the stats but mark the Difference column
`underpowered`, since a difference between two tiny groups is not worth reading as a result.

---

## 9. Stories

**VALIDATION-06-S1 — engine: overall ratio + group report**
Add `GroupReportRow`, `GroupReport`, `reportGroup()`. Overall = mean of available wells.
**AC:** unit tests prove overall is the mean of present wells only; a cartridge with one usable well
yields that well's value with `wellsUsed: 1`; a cartridge with none is excluded with a stated
reason; `robustStats` supplies avg/stdev/CV/median unchanged; `JSON.parse(JSON.stringify(report))`
deep-equals the report (no `Infinity`/`NaN`).

**VALIDATION-06-S2 — engine: group difference**
Add `StatDiff`, `GroupDiffReport`, `diffGroups()`, and the mean-vs-median divergence note.
**AC:** two identical groups give all-zero differences; a 2× offset gives `avgPctDiff ≈ 100`;
`cvDiffPp` is a subtraction of CVs, asserted in percentage points; a group of n=2 sets
`underpowered`; groups spanning two SPUs emit the calibration caveat; a group whose mean is pulled
>10% off its median emits the skew note. `compareGroups` and the existing analyze page are untouched
— verified by the existing suite still passing.

**VALIDATION-06-S3 — groups workspace route**
`groups/+page.{server.ts,svelte}` — list, create panel with a run-only cartridge picker, compare
selection.
**AC:** every non-archived `optical_analysis` group is listed with its true member count; the picker
offers only cartridges carrying readings; a duplicate name surfaces the existing 409 with its "add
to existing" choice; exactly two selections enable the compare bar.

**VALIDATION-06-S4 — group analyze view**
`groups/[groupId]/+page.{server.ts,svelte}` — totals + per-cartridge table + excluded card.
**AC:** totals match `reportGroup` exactly; one row per member; a no-readings member is visibly
marked and excluded from the totals; no chart renders; 404 on an unknown or archived group.

**VALIDATION-06-S5 — compare view**
`groups/compare/+page.{server.ts,svelte}` — `?a=&b=`, overall row, expandable wells, CSV.
**AC:** both groups' n/avg/stdev/CV/median render; the Difference column matches `diffGroups`; the
channels button expands exactly three well rows; engine notes render; CSV opens intact in Excel with
a group name containing a comma.

**VALIDATION-06-S6 — wire the orphaned actions**
Rename and Archive from the group list; Remove-cartridge from the group analyze view.
**AC:** each posts to its existing action; each writes an AuditLog row with the correct
`tableName`/`recordId`/`action`; archiving hides the group from the list and from the log page chips
without deleting anything; a rename clash returns 409 and is shown inline.

---

## 10. Open Questions / Risks

**OQ-1 — should the run-only rule be enforced server-side?** The picker filters to cartridges with
readings, but `saveGroup` stays permissive (it only validates that ids are optical cartridges), so
the existing inline "Save as group" flow on the log page keeps working unchanged. Making it a hard
server rule would change that shipped behaviour. **Recommend leaving it a UI filter — needs the
user's call.**

**OQ-2 — does the log page's inline "Save as group" stay?** This PRD keeps it. It works, it is
shipped, and it is the fastest path when you are already looking at the log. The workspace is the
place to *manage* groups, not the only place to make one.

**RISK-1 — CV is outlier-sensitive, and this view leads with it.** That is the deliberate answer to
the request, mitigated by the median column and the engine's skew note. The robust rule still drives
the ⚠ flags; the CV is for reading, not for gating.

**RISK-2 — a difference is not a result.** With n≈5–10 per group and no significance testing, two
groups differing by 10% may be noise. The view says so, and `underpowered` is surfaced. This must not
become a release criterion.

**RISK-3 — route precedence.** `groups/compare` only works because SvelteKit prefers static segments
over `[groupId]`. Documented in the file; do not rename it to something dynamic-looking.

**RISK-4 — the parity check is still open.** BIMS vs research-app F7/F3 has never been confirmed on
the same barcodes. Unchanged from VALIDATION-04; these numbers remain review signals.

---

## 11. Test / Validation Plan

**Unit** — extend `src/lib/server/optical-analysis.test.ts` (22 tests today, all passing via
`npm run test:unit`): overall-ratio definition and its edge cases, `reportGroup` totals,
`diffGroups` zero/offset/underpowered/skew-note cases, `cvDiffPp` in percentage points, and a JSON
round-trip guard. Existing `compareGroups` tests must still pass untouched — that is the regression
gate proving the shipped page is unaffected.

**Real-data check** — a throwaway `tsx` script (deleted after) building two groups from the 193 real
optical cartridges: confirm `reportGroup` totals match a hand calculation on a small group, and that
`diffGroups` produces sane differences between two SPUs' cartridge sets.

**End-to-end on the Vercel preview** — never a local `vercel deploy`; `npm run build` OOMs on this
machine, so `npm run check` locally and the branch build is the gate:
1. Create a group from the workspace picker; confirm only already-run cartridges are offered.
2. Analyze it — totals match the cartridge rows, no chart renders.
3. Create a second group, select both, compare — differences populate; expand channels.
4. Download the CSV, open in Excel, confirm a comma in a group name survives.
5. Rename a group, remove a cartridge, archive a group; confirm each updates correctly and check
   `audit_log` for the three rows.
6. Confirm `/validation/optical-confirmation/analyze` is unchanged and still shows its strip plot.

**Typecheck** — `npm run check` against the master baseline (77 errors / 434 warnings as measured
2026-07-30), zero new errors in touched files.

Log the deployment in `progress.txt` per the mandatory format.

---

## 12. Out of Scope

SPU-aligned comparison · charts on the new routes · changes to `/analyze` · significance testing ·
calibration-factor normalisation · `assign_batch` group management · comparing >2 groups ·
cross-assay comparison.

---

## Appendix A — File change map

**Add**
```
src/routes/validation/optical-confirmation/groups/+page.server.ts
src/routes/validation/optical-confirmation/groups/+page.svelte
src/routes/validation/optical-confirmation/groups/[groupId]/+page.server.ts
src/routes/validation/optical-confirmation/groups/[groupId]/+page.svelte
src/routes/validation/optical-confirmation/groups/compare/+page.server.ts
src/routes/validation/optical-confirmation/groups/compare/+page.svelte
```

**Modify**
```
src/lib/server/optical-analysis.ts          reportGroup, diffGroups + types (additive only)
src/lib/server/optical-analysis.test.ts     new cases; existing ones unchanged
src/routes/validation/optical-confirmation/+page.svelte   add a "Groups" link to the workspace
```

**Remove** — nothing.

## Appendix B — Reference pointers

- Engine: `src/lib/server/optical-analysis.ts` — `robustStats:209`, `analyzeCartridge:306`,
  `analyzeGroupRobust:563`, `compareGroups:711`
- Constants: `src/lib/server/optical-constants.ts` — `OPTICAL_CARTRIDGE_FILTER:21`,
  `MAX_COMPARE_CARTRIDGES:45`
- Model: `src/lib/server/db/models/cartridge-group.ts:21-58`
- Actions to wire: `optical-confirmation/+page.server.ts:329` (rename), `:386` (remove),
  `:431` (archive)
- Components to reuse: `src/lib/components/validation/optical/{GroupPill,OutlierMark,csv}`
- Shipped feature this builds on: PR #39, master `7e6ec7f6`
