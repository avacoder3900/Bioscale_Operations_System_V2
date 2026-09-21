# WAX-SIMPLIFY-3 — Reagent deck scan accepts `wax_filled` OR `wax_ready`

**Date:** 2026-08-17 · **Owner:** Jacob · **Status:** Approved (conversation 2026-08-17)
**Supersedes:** WAX-INSPECTION-READY-REJECTED §6 (reagent gate = `wax_ready` only)
**Series:** WAX-SIMPLIFY-1 · WAX-SIMPLIFY-2 · WAX-SIMPLIFY-3 (this)

## Intent (Jacob)

"For reagent filling, the status wax filled or wax ready are acceptable statuses for now for
being scanned onto a reagent deck to be filled."

## Decision

The reagent-filling gate accepts any status in `WAX_STAGE_STATUSES = ['wax_filled','wax_ready']`
(shared constant from WAX-SIMPLIFY-1). `wax_rejected` is refused with a clear message. Legacy
unmigrated `wax_stored` / `wax_qc` rows are refused with "run the WAX-SIMPLIFY migration" hint
(they should not exist after deploy day; the message makes it obvious if they do).

## Changes (two gates, keep them identical — extract one helper)

Add `isReagentEligible(status): { ok: boolean; hint?: string }` in
`src/lib/shared/cartridge-wax-status.ts` and use it from both:

1. `api/dev/validate-equipment/+server.ts` (context=reagent, ~L70-93) — the live per-scan check
   the reagent-filling deck-scan UI calls. Message on refusal:
   `Cartridge "<id>" can't be reagent-filled — <hint>.` with hints:
   `wax_rejected` → "it was rejected at wax inspection";
   `backing`/`wax_filling` → "it hasn't finished wax filling";
   `reagent_*`/later → "it is already past wax (status=<x>)";
   `wax_stored`/`wax_qc` → "legacy status — run scripts/migrate-wax-simplify.ts";
   default → `it is in phase "<x>"`.
2. `manufacturing/cart-mfg/reagent-filling/+page.server.ts` `startRun` hard gate (~L623-636) —
   same helper, same wording. Update the stale comment block.

Also sweep: `ask-bims.ts` rule 9 / tool descriptions ("how many can I reagent-fill right now" =
count of `WAX_STAGE_STATUSES`), `ask-bims-tier1.ts` status doc string, `REAGENT-FLOW-WAX-PARITY`
/ `WAX-FLOW-1` docs if they state the gate, and the MCP tool descriptions in `bims-mcp.ts` if
any mention `wax_ready`-only.

## Acceptance

- Scanning a `wax_filled` cart onto a reagent deck passes validate-equipment and startRun.
- `wax_ready` still passes. `wax_rejected` refused with the "rejected at wax inspection" message.
- A `reagent_filled` cart is refused (already past wax).
- Both gates produce identical decisions for the same status (unit-style check via the helper).
- `npm run check` baseline, build green.
