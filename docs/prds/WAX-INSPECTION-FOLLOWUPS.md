# PRD: Wax-inspection follow-ups (1 & 2)

Follow-ups to WAX-INSPECTION-READY-REJECTED. Now that judging happens at
`/wax-inspect` (wax_stored → wax_qc → wax_ready/wax_rejected), clean up the
leftovers.

## FU1 — Drop the pre-storage QC accept/reject; wax fill ends at wax_stored
Today the wax-fill flow does an accept/reject **before** storage:
- `confirmCooling` → status `QC`
- `completeQC` → bulk-writes `waxQc.status='Accepted'` for non-rejected carts, sets
  carts `wax_filled`, run → `Storage`
- `rejectCartridge` → `waxQc.status='Rejected'` during the QC stage
- `recordBatchStorage` → carts `wax_stored`, fridge chosen

That accept/reject is now redundant (and confusing) — all judging moved to wax
inspection. Change:
- **`completeQC`:** stop writing `waxQc.status='Accepted'`. It still cools-confirm →
  sets carts `wax_filled` → run `Storage`. No pre-verdict. (Keep the action +
  stage transitions so the run state machine is unchanged — lowest risk.)
- **`rejectCartridge`:** retire the pre-storage reject. Remove (or neutralize) the
  per-cart reject UI in the QC stage; the stage becomes "carts cooled → confirm →
  store," not a pass/fail gate. Rejection now happens at `/wax-inspect`.
- **UI/copy:** the QC stage + the "QC" timeline bubble reframe from a judging step
  to a "ready to store" confirmation (rename bubble label if it reads as QC).
- Net: wax fill ends at `wax_stored`; the only verdict surface is `/wax-inspect`.

**Guardrails:** keep the run stage machine (Setup→…→QC→Storage) intact to avoid
breaking the working flow; only remove the *cartridge verdict* writes + reject UI.
Don't touch the `waxQc` field shape (the inspection verdict still mirrors into it).

## FU2 — Status colors + order for wax_ready / wax_rejected
The two new statuses render with default styling and out of order in the lifecycle
views. Add them to the status-order arrays + color maps so they display correctly
(wax_ready as a "good" green-ish state, wax_rejected as a red off-ramp), in order:
`… wax_filled → wax_stored → wax_qc → wax_ready → reagent_filled …` (wax_rejected
as a terminal/off-ramp). Surfaces:
- `src/routes/cartridge-admin/+page.svelte` (STAGES + color map)
- `src/routes/cartridge-admin/statistics/+page.server.ts` (phase order)
- `src/routes/+page.{server.ts,svelte}` (phaseOrder + color map)
- `src/routes/cartridge-dashboard/+page.server.ts` (phaseOrder)
- `src/routes/cartridge-admin/dhr/[cartridgeId]/+page.{server.ts,svelte}` (phase list/colors)
- `src/lib/server/services/cartridge-admin/queries.ts` (status union/list)

## Acceptance
- After a wax run + storage, carts are `wax_stored` with NO `waxQc.status` set
  (verdict only comes from inspection).
- No pre-storage reject path remains in the wax-fill QC stage.
- `wax_ready`/`wax_rejected` render with sensible colors + correct lifecycle order
  in cartridge-admin, home dashboard, stats, and DHR.
- `npm run check` no new errors over baseline; build green.
