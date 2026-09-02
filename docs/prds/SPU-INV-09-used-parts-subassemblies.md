# SPU-INV-09 — Used Parts + Subassemblies in SPU Part Inventory

**Status:** Approved (Jacob, 2026-09-02)
**Branch:** `feat/spu-tweaks`

## Concepts

1. **Used parts** — electronics pulled from service that are probably good but not pristine.
   Tracked as *variants* of existing parts, on their own **"Used SPU Parts" tab** between SPU
   Parts and Cartridge Parts on `/parts`. Created by picking a base part from a dropdown
   (on demand — mostly electronics, not every part gets a variant). **Counts start at 0 and are
   adjusted manually; creating a variant never touches the pristine part's count** (Jacob).
2. **Subassemblies** — a special grouping of parts living on the SPU Parts tab. Created via a
   **"Create Subassembly"** button next to "+ Add Part": pick child parts from a dropdown
   (qty each, default 1). A subassembly has its own count.
   **Counts are never double-reported**: 10 loose MSOMs + 10 in subassemblies → the MSOM part
   still says 10; each part instead shows a small **"N tied up in subassemblies"** figure
   (Σ over pristine subassemblies of subCount × childQty).
3. **Used subassemblies** — a used variant can be created from a subassembly too (appears on
   the Used tab). Variant subassemblies do NOT contribute to the tied-up math (their component
   list is informational).

## Build semantics (Jacob: "ability to do both")

- **Add de novo** — increment the subassembly count without touching child loose counts
  (for units built from parts never inducted into inventory).
- **Build from stock** — increment the subassembly count AND deduct qty×childQty from each
  child's loose count (guard: fails if any child would go negative).
- **Disassemble to stock** — decrement + return the parts to loose counts.
- **Remove (no return)** — decrement only (scrapped/lost).

## Data model (`PartDefinition`)

- `usedVariantOf: String` — set on used variants (base part `_id`); one variant per base
  (enforced in the action). Variant partNumber = `<base>-USED`, name = `<base name> (Used)`.
- `isSubassembly: Boolean` + `components: [{ partDefinitionId, partNumber, name, quantity }]`
  (`_id: false` snapshot subdocs).
- All are `bomType: 'spu'` docs — used variants are excluded from the SPU tab list;
  subassemblies are included (cost derived from children when children have costs, and the
  no-cost filter doesn't drop them).

## Server actions (all `inventory:write`, all audit-logged)

`createUsedVariant`, `createSubassembly`, `adjustUsedCount` (±, floor 0),
`buildSubassembly` (qty + mode denovo|stock), `unbuildSubassembly` (qty + mode return|discard).

## UI

- New **Used SPU Parts** tab (`?tab=used`): "+ Used Part" (dropdown of parts without a variant,
  subassemblies included), table with base part, count, per-row −/+ adjusters.
- SPU tab: **Create Subassembly** button + form; subassembly rows get a `SUB` badge and an
  expandable panel (components + the four build/unbuild controls); parts referenced by
  subassemblies show "N in subs" under their inventory count.

## Acceptance

- Creating a used MSOM variant leaves MSOM count untouched; the variant appears on the Used
  tab at 0 and can be adjusted.
- Build-from-stock of a sub with an MSOM child drops loose MSOM by 1 and MSOM shows
  "+1 in subs"; de novo build changes only the sub count. Disassemble returns parts.
- Loose counts never double-report subassembly contents.
- `npm run check` at or below the 11-error baseline.
