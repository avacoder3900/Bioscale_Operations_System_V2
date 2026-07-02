# PRD: Quick Reagent Fill Test — bulk-convert any cartridge to reagent-fillable

## Problem
Running a **reagent-fill test** repeatedly requires a supply of cartridges at the reagent
intake state (`wax_ready`, with no prior `reagentFilling`). In practice the operator grabs
whatever carts are on hand — at any status, including ones already `reagent_filled` from a
previous test — and today the only way to reset them is a manual DB script (done ad-hoc all
through the 2026-07-01 test session). That is slow, error-prone (hand-typed UUIDs), and not
self-service.

There is already a clean pattern for exactly this shape of bulk-scan utility: **Quick Seal**
(`/manufacturing/cart-mfg/quick-seal`) — bulk-scan barcodes in a textarea, flip status, report
accepted/rejected per cart.

## Change
Add a new sibling page **Quick Reagent Fill Test** at
`/manufacturing/cart-mfg/quick-reagent-test`, UI-identical to Quick Seal, that takes
**any cartridge at any status** and makes it **reagent-fillable**:

- Sets `status = 'wax_ready'` (the reagent-fill intake gate — see
  `reagent-filling/+page.server.ts`).
- Clears `reagentFilling` back to `{ tubeRecords: [] }` so a cart that was already
  reagent-filled passes the "already reagent-filled" guard on the next scan.
- Records `priorStatus` (the status it came from) for traceability.
- Appends a note **"Used for test fill"** to the cartridge's `notes[]` (phase `test-fill`),
  and sets a queryable `usedForTestFill: true` marker for easy cleanup/filtering.
- Writes one `AuditLog` row per cart (`action: 'quick_reagent_test'`,
  `newData: { from, to: 'wax_ready' }`).

Per-cart accept/reject like Quick Seal: only **not-found** barcodes are rejected and kept in
the box to re-scan; **every existing cart, at any status, is accepted** (that is the point of
the tool). Finalized carts are still converted (test tool, explicit intent) but the note +
`priorStatus` + audit row leave a full trail.

## Files
- **New** `src/routes/manufacturing/cart-mfg/quick-reagent-test/+page.server.ts` — `load`
  (counts) + `convert` action. Mirrors `quick-seal/+page.server.ts`.
- **New** `src/routes/manufacturing/cart-mfg/quick-reagent-test/+page.svelte` — copy of
  `quick-seal/+page.svelte` with relabelled copy and `?/convert`.
- **Edit** `src/routes/manufacturing/cart-mfg/+layout.svelte` — add a nav item
  "Quick Rgt Test" next to "Quick Seal".

## Permissions
`manufacturing:read` (load) / `manufacturing:write` (action), same as Quick Seal.

## Non-goals
- Does not run an actual reagent fill — it only puts carts into the state from which the real
  Reagent Filling page can scan them.
- No change to the reagent-fill gate, models, or Quick Seal.

## Acceptance
- Scanning a mix of barcodes at `reagent_filled`, `sealed`, `wax_stored`, `backing`, etc. flips
  all existing ones to `wax_ready` with `reagentFilling` cleared; not-found barcodes are
  reported and retained in the box.
- Each converted cart gains a "Used for test fill" note, `usedForTestFill: true`, `priorStatus`,
  and an AuditLog row.
- A converted cart immediately scans clean on the Reagent Filling page (no "already
  reagent-filled" / "not wax_ready" rejection).
- `npm run check` stays at the existing error baseline (0 new); build green.

## Deployment note
Reaches operators only once the production alias tracks current `master` (same stale-prod
caveat as the rest of the 2026-07 cart-mfg work).
