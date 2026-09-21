# SPU-INV-07 — SPU Status Flow Collapse

**Status:** Approved (Jacob, 2026-09-02)
**Branch:** `feat/spu-tweaks`

## The change

Old enum (12): draft, assembling, **assembled**, validating, **validated**, **released-rnd**,
**released-manufacturing**, **released-field**, **deployed**, servicing, retired, **voided**.

New enum (6): **draft → assembling → validating → released ⇄ servicing → retired**.

Principles (Jacob's framing):
- **Border statuses become transition moments.** `assembled` was the boundary between assembly
  and validation → the e-signature is now captured on the *assembling → validating* transition
  (`assemblyStatus: 'completed'` still records assembly-done). `validated` was the boundary
  between validation and release → passing validation is the *event*; **release stays manual**
  (device sits in `validating` with validation passed until a person transitions it to
  `released`).
- **R&D is a location, not a status.** New free-form `location` field on the Spu model;
  vocabulary starts with `R&D`. The 9 production `released-rnd` devices become
  `{status: 'released', location: 'R&D'}`.
- **Servicing keeps working exactly as intended** over the collapsed vocabulary: intake from any
  status records `previousStatus`; close still offers a return-status choice defaulting to
  `previousStatus`; the dead `'validated'` fallback becomes `'validating'` (re-validate is the
  safe default after service). The inline detail-page service flow keeps forcing
  `validating` + `validationResetAt` on return.
- **`voided` removed** (0 devices). Exits are `retired` or hard-delete. `voidedAt`/`voidReason`
  schema fields removed (nothing writes them; old docs unaffected).

## Production data (scripts/diag-spu-statuses.ts, 2026-09-02)

73 SPUs: draft 37, servicing 26, released-rnd 9, validating 1. Zero devices in any other
removed status (incl. rogue `assigned`). 55 historical statusTransitions entries name
released-rnd (left untouched — immutable history; badge keeps legacy labels renderable).
service_records: 23 open; previousStatus = released-rnd 13, draft 7, assembling 2, validating 1.

## Implementation

1. **`src/lib/server/spu-status.ts` (new)** — single source of truth: `SPU_STATUSES`,
   `LEGAL_TRANSITIONS` map, `RETURNABLE_STATUSES`, `LEGACY_STATUS_MAP`
   (assembled→validating, validated→validating, deployed/released-*→released, voided→retired).
   `transitionStatus` becomes the app-level enforcement point — the Mongoose enum can't be
   (nearly all writes are `updateOne`, which skips validators; that's how `assigned` happened).
2. **Model** — enum → 6 values; add `location: String`; drop voidedAt/voidReason.
3. **Writers** — assembly complete + `updateAssemblyStatus` write `validating` (was
   `assembled`); validation-run pass no longer writes status (stays `validating`, marks the run
   complete; release is a manual transition); dashboard `assignSpu` stops writing the
   out-of-enum `status:'assigned'`; dashboard `updateStatus` allowlist → shared module.
4. **Servicing board** — RETURNABLE_STATUSES from shared module; fallback → `validating`;
   UI default selection likewise.
5. **Delete orphaned `/spu/servicing/**`** (3 server files, pages deleted long ago in 5b93eb47;
   they hard-code 6 dead statuses and write unvalidated form input into spu.status).
   ServiceTicket model left in place (inert).
6. **UI** — SpuStatusBadge: new 6 + `released`, legacy keys kept as render-only aliases for the
   transition-history timeline; detail page STATUS_OPTIONS driven by LEGAL_TRANSITIONS from the
   current status; statusColor updated; `/spu` list STATUS_ORDER → new list; Location shown in
   Device Information.
7. **Filters/gates sweep** — validation pickers drop `voided` from $nin; servicing picker drops
   `$ne: 'voided'`; batches page drops the `status === 'assembled'` OR-fallback.
8. **MCP** — `list_spus` tool-description status vocabulary updated in BOTH surfaces
   (src/lib/server/mcp/bims-mcp.ts and services/bims-mcp/src/server.ts) so agents don't query
   dead values.
9. **Seeds** — scripts/seed-domain-data.ts spuStatuses list rewritten.
10. **Migration `scripts/migrate-spu-status-collapse.ts`** (idempotent, prints before/after):
    - spus: remap status via LEGACY_STATUS_MAP-equivalent $in update; released-rnd additionally
      sets `location: 'R&D'`.
    - service_records: remap previousStatus + returnedToStatus the same way.
    - statusTransitions history untouched.

**Deploy order:** push code → wait for production deploy → run migration against Atlas.
(Window safety: legacy statuses render via the badge's raw-string fallback; a service-close in
the window falls back to `validating`, which is valid new vocabulary.)

## Out of scope / follow-ups

- Location editing UI + location vocabulary beyond `R&D` (display only for now).
- ~15 docs referencing the old chain (list in the 2026-09-02 census; update opportunistically).
- Deleting the stale git-tracked duplicate tree under `OneDrive - Linbeck Group, LLC/...`
  (recommended separately — it pollutes repo-wide greps).
- ask-bims cartridge `'released'` wording ambiguity (flag only).

## Acceptance

- Fresh flow works end-to-end: create draft → start assembly (`assembling`) → complete with
  e-signature (`validating`, signature captured) → validation run passes (stays `validating`) →
  manual transition to `released` → service intake (`servicing`) → close back to `validating`
  → retired.
- The 9 released-rnd devices show `Released` + location `R&D`; the 13 stale service-record
  previousStatus values are remapped; closing them returns devices to `released`.
- `transitionStatus` rejects illegal transitions server-side.
- `npm run check` at or below the 11-error baseline.
