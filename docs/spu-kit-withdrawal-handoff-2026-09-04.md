# SPU Kit Withdrawal — session handoff (2026-09-04)

A "Withdraw SPU Kit" button on `/inventory/transactions` that deducts the full standard
parts kit consumed by building one SPU, in one action.

**Status: built, type-clean, deployed to preview, never executed against real data.**
No withdrawal has actually been run. The deduction path is proven by type-checking and an
offline aggregation test only.

---

## Where things are

| | |
|---|---|
| Branch | `feat/spu-kit-withdrawal` |
| HEAD | `62c0bd31` |
| Worktree | `C:\Users\aleja\.worktrees\spu-kit-withdraw` |
| Base | branched off `origin/master` at `3c7625ee` |
| Latest preview | https://bioscale-operations-system-mongodb-479dfol4u-brevitest.vercel.app |

### Commits (oldest first)

```
79db6d41  feat(inventory): "Withdraw SPU Kit" button on the transactions page
76a9d934  fix(inventory): restrict kit withdrawal to units still being built
adaf350c  docs(progress): log preview deployment for SPU kit withdrawal
62c0bd31  fix(inventory): correct PT-SPU-104 collision; revise kit contents
```

### Preview deployments

| Commit | URL |
|---|---|
| `76a9d934` | https://bioscale-operations-system-mongodb-5e5fzt49f-brevitest.vercel.app |
| `62c0bd31` | https://bioscale-operations-system-mongodb-479dfol4u-brevitest.vercel.app |

Use the `-brevitest` alias. The bare deployment URL Vercel also returns
(`...-479dfol4u.vercel.app` without the suffix) sits behind Vercel SSO and 302s to
`vercel.com/sso-api`. The git-branch alias never resolved — the branch name is long
enough that Vercel truncates and hashes it — so the immutable URLs above are the ones to
share.

---

## ⚠️ Branch is 13 commits behind master

`origin/master` moved during this work (parts-page changes, thermocouple verdict work, an
SPU drift audit, magnetometer failure rollup). **4 ahead, 13 behind.**

Before opening a PR:

1. Merge or rebase master in. `progress.txt` **will** conflict — both sides appended.
2. Master touched `src/routes/parts/*`; this branch touches `/inventory/transactions`, so
   code conflict risk is low but not zero.
3. Watch for the known Vercel dedup trap: if merging master produces a tree identical to
   something already built, Vercel silently skips the build and reports no statuses at
   all. Confirm a build actually ran rather than assuming.

---

## What was built

### Files

| File | What |
|---|---|
| `src/lib/server/services/spu-kit-withdrawal.ts` | new — kit aggregation, preview, apply |
| `src/lib/server/services/inventory-resolve.ts` | new — shared SPU/part reference resolvers |
| `src/lib/server/services/spu-component-parts.ts` | kit contents + new `kitExclusion` field |
| `src/lib/server/spu-status.ts` | added `IN_BUILD_STATUSES` / `isInBuild()` |
| `src/routes/inventory/transactions/+page.server.ts` | load + `withdrawSpuKit` action |
| `src/routes/inventory/transactions/+page.svelte` | button + confirmation/result modal |
| `src/routes/api/agent/inventory/reassembly/+server.ts` | now imports the shared resolvers |

### Design decisions and why

**Deducts the full standard kit, not just un-deducted parts.** Assembly scans only deduct
parts carrying a scannable barcode (`-1` per scan). Screws, washers, magnets and labels
are consumed on every build but never leave the books. Operator chose full-kit semantics
over "kit minus already-deducted", accepting that the few barcode-scanned parts get
deducted twice.

**Only units still being built.** `IN_BUILD_STATUSES = ['draft', 'assembling']`. The
cutoff is `assembling → validating`, where the assembly e-signature is captured — past
that the unit is built and its parts already left the shelf. Enforced in two places: the
picker lists only in-build units, **and the action re-checks server-side**, because the
form also accepts a typed or wedge-scanned SPU ref.

**Not all-or-nothing.** Parts that can't be deducted are skipped and the withdrawal
proceeds. Each skip surfaces its curated work-instruction note verbatim, in the
pre-withdrawal table and again in the result panel.

**Shared resolvers.** `resolveSpuRef` / `resolvePartRef` were lifted out of the agent
reassembly endpoint into `inventory-resolve.ts`, which that endpoint now imports. Both
flows must resolve "SPU 203" and a part number identically; duplicating the rules is a
silent wrong-unit deduction waiting to happen.

**`kitExclusion` rather than deletion.** Excluded parts stay in `SPU_COMPONENT_PARTS`
because that map doubles as the agent reassembly knowledge base — deleting the antennas
would break *"what lives in the antennas component?"*. Only withdrawal skips them.
Excluded (a decision) is kept distinct from unresolved (missing data).

**Repeat guard.** SPUs with an existing kit withdrawal are marked in the picker and
require an acknowledgement checkbox. Detection is via the `SPU kit withdrawal` prefix
this flow writes into transaction notes.

---

## Current kit — 45 distinct parts, 41 deducted, 4 excluded

Parts recurring across components are summed: **PT-SPU-030 → 11**, **PT-SPU-009 → 9**,
**PT-SPU-003 → 4**, **PT-SPU-004 → 4**.

Deducted: PT-SPU-002 (2), 003 (4), 004 (4), 005 (4), 006 (2), 007 (2), 009 (9), 010 (1),
012 (1), 013 (1), 014 (1), 015 (1), 016 (1), 018 (1), 019 (4), 020 (1), 021 (1), 022 (1),
024 (4), 027 (1), 028 (1), 029 (2), 030 (11), 031 (1), **032 (351, mm)**, 033 (2), 036 (1),
041 (2), 044 (1), 051 (2), 052 (2), 056 (1), 057 (1), 058 (1), 059 (1), 070 (1), 072 (1),
**104 (3)**, **105 (1)**, SBA-SPU-003 (1), SBA-SPU-004 (1).

Excluded (listed, never deducted):

| Part | Reason |
|---|---|
| PT-SPU-099 Aluminum Tape | consumed by length in mm; per-SPU length not yet set |
| PT-SPU-101 GNSS Antenna | not withdrawn; no part definition exists |
| PT-SPU-102 Cellular Antenna | not withdrawn; no part definition exists |
| PT-SPU-103 Wi-Fi/BLE Antenna | not withdrawn; no part definition exists |

---

## Open items — pick up here

### 1. WIMF-SPU-01 v18 still prints the wrong pulley part number

`PT-SPU-104` was listed in the map as the *40 Tooth GT-2 Pulley*, but in
`part_definitions` it is **"Nickel plated Neodymium magnets"** (Critical, *"Spherical
magnet. Supersedes PT-SPU-008"*, qty 3). The number was reassigned after the WI was
written. A withdrawal would have deducted a magnet believing it was a pulley, skipped the
3 spherical magnets actually needed (PT-SPU-008 no longer resolves), and never touched the
real pulley.

Corrected in code against `part_definitions`, since that is what deductions resolve
against:

- PT-SPU-008 → **PT-SPU-104** (nickel plated magnets, qty 3)
- pulley → **PT-SPU-105** ("40 T 5mm bore pulley", supersedes PT-SPU-017, qty 1)

**The WI document itself still needs correcting.** The code now deliberately disagrees
with it and says so in a note.

### 2. PT-SPU-104 stock is already negative

`inventoryCount` was **−3** before this button existed, and PT-SPU-105 is at 0. Something
else has been deducting magnets. Worth investigating independently of this feature.

### 3. Timing belt unit of measure is unreconciled

PT-SPU-032 deducts **351 (mm)**, per operator decision. But `inventoryCount` is 7, which
is almost certainly 7 × 3000 mm spools, not 7 mm. First withdrawal drives it to **−344**.
The operator accepted this knowingly. The real fix is reconciling the unit of measure on
the part definition.

### 4. Aluminum tape needs its mm figure

Excluded pending a per-SPU length. `part_definitions` carries `quantityPerUnit 60`, which
the operator has **not** confirmed, so it is deliberately unused. Set the real number,
then drop the `kitExclusion` on PT-SPU-099.

### 5. Work instructions will eventually deduct this too

The operator noted the WIs will be doing this. When that lands, every SPU gets **two** full
kits deducted, and the repeat guard won't catch it — `alreadyWithdrawn` only detects this
button's own marker, not WI-side deductions. Fix then, not now: either switch to
"kit minus already-deducted", or have the WI write the same marker so the guard fires
across both paths.

### 6. Never executed

No withdrawal has been run. Next step is one throwaway in-build SPU on preview, then
verify the resulting `inventory_transactions` rows and the `AuditLog` entry
(`operation: spu_kit_withdrawal`).

---

## Resuming work

```bash
cd ~/.worktrees/spu-kit-withdraw
git fetch origin master
npm ci          # required — see note below
npm run check   # baseline is 10 errors / 434 warnings
```

**`npm ci` matters.** Borrowing another worktree's `node_modules` inflates the error count
to ~119 through missing packages and makes the baseline unreadable. A local
`npm run build` is not possible on this machine (OOMs around 30 GB) — Vercel's branch
build is the gate.

**Deploy by pushing the branch only.** Never `vercel deploy` locally. Vercel builds from
the GitHub push; log every deployment's branch/commit/URL in `progress.txt`.

**Heredoc caution.** In this environment `cat > file <<'EOF'` did not reliably preserve
`$` and `\` — it silently corrupted a regex into `/[.*+?^${}()|[\]\]/g` with `'\$&'`.
Prefer the Write tool for files containing regexes or template literals.
