# PRD: CV Cartridge Induct — deliberate cartridge origination

**Document:** CV-CARTRIDGE-INDUCT.md
**Route:** `/cv/induct`
**Status:** Implemented
**Date:** 2026-07-09

---

## 1. Why induct died

An "induct mode" toggle once lived on the CV capture page: any scan that didn't
match an existing cartridge silently `create`d a new `cartridge_record`
(`POST /api/cv/induct-cartridge`, status hard-coded to `wax_filled`). The
cartridge-first refactor (commit `398f02c2e` — "induction is dead") deleted it.
It minted **ghost records**: no chosen destination, no lineage, no operator
intent — just a bare id at an arbitrary status. Capture was then tightened to
**orphan-reject** (photos of unknown cartridges are refused), so there was no
longer any accidental back door to origination either.

## 2. Why it's back — deliberately

Operators still need to bring a never-before-seen cartridge into BIMS so it can
be photographed/inspected without walking it through the whole wax → backing →
fill line first (the same real need the quick-reagent-test "originate a
not-found barcode" branch, `2ddab20c9`, serves for reagent test fills). Induct
returns as a **first-class, explicit flow** rather than a capture-page side
effect.

### Deliberate differences from the old auto-induct

| Old auto-induct (dead) | New `/cv/induct` |
| --- | --- |
| Side effect of any unknown capture scan | Its own page; you go there on purpose |
| Status hard-coded to `wax_filled` | Operator **picks the readiness** → mapped status |
| No record of how/why it was made | `notes[]` phase `induct` + `cartridge_induct` AuditLog row |
| Re-scan could clobber / re-create | Existing cartridge is **never mutated** — re-scan just reports it |
| No lineage or intent | Marked induct-sourced and distinguishable/queryable |

## 3. Status mapping

The operator chooses which inspection the cartridge should be ready for. Each
maps to the exact status that makes a cartridge "ready" for that inline
inspection, derived from where each inspection statuses a cart:

| Ready for | Created status | Why that status | Derivation |
| --- | --- | --- | --- |
| Wax inspection | `wax_stored` | Wax Inspect photographs a `wax_stored` cart and advances it `wax_stored → wax_qc` | `POST /api/cv/capture` transition block (scoped to `wax_stored`); `wax-verdict` hint expects `wax_qc` |
| Reagent inspection | `sealed` | Reagent Inspect (post top-seal) photographs a `sealed` cart and advances it `sealed → reagent_qc` | `POST /api/cv/capture` transition block (scoped to `sealed`); `reagent-verdict` hint expects `reagent_qc` |
| Post-mortem inspection | `completed` | Post-Mortem Inspect photographs a ran (`completed`) cart; no status change | `post-mortem-inspect` header ("status `completed`"), no transition in capture |

## 4. Behavior

- **Auth:** `cv:write` OR `manufacturing:write` (mirrors `POST /api/cv/capture`).
- **Load:** returns the three ready-for options (key/status/label/blurb) and the
  20 most recent inductions, sourced from `cartridge_induct` AuditLog rows joined
  to each cartridge's current status (so the list reflects reality even if a cart
  has since moved on).
- **Action `induct`:** validates `barcode` (trim + non-empty, exactly like the
  quick-reagent-test origination — no `generated_barcodes` lookup, no UUID format
  check, the scanned string IS the cartridge `_id`) and `readyFor` (one of the
  three keys). If the cartridge already exists → returns an informational result
  with current status + phase-history summary, **no mutation**. Otherwise
  `create`s it at the mapped status with an `induct`-phase note and writes a
  `cartridge_induct` AuditLog row. Duplicate-key races fall back to a re-scan
  message.
- **UX (wedge-scanner-first):** barcode input autofocused, Enter submits, focus
  returns to the cleared input after every submit (scan-scan-scan a stack). The
  ready-for selection is sticky between submits.

## 5. Distinguishability

Induct records are marked two ways, both schema-declared: a `notes[]` entry with
`phase: 'induct'` on the cartridge, and a `cartridge_induct` AuditLog row
(`newData: { from: 'new', to, readyFor, source: 'induct' }`). The AuditLog row is
also the source of the "recently inducted" list.
