# PRD: Wax inspection status flow — wax_stored → wax_qc → wax_ready / wax_rejected

**Status:** Approved (discussion 2026-06-17). Implement.
**Replaces:** the pre-storage wax-QC accept/reject step + the `wax_filled/wax_stored/wax_qc`
reagent allow-list.

## The flow (locked)
```
wax fill done → deck removed → cartridges stored in a fridge   → status wax_stored
wax_stored  → a photo is captured at /wax-inspect              → status wax_qc
wax_qc      → verdict (human OR CV)                            → status wax_ready | wax_rejected
reagent filling barcode scan accepts ONLY wax_ready
```
`wax_qc` is **repurposed**: it now means "photographed, awaiting verdict" (the
middle state), NOT the old pre-storage accept/reject.

### Verdict paths
- **CV (future, model not deployed yet):** inference runs ~automatically after the
  photo; its result maps wax_qc → wax_ready/wax_rejected. Wire the mapping hook now;
  it activates when a CvProject is deployed.
- **Human (now):** the operator must **physically scan the cart's QR** to act on it,
  then taps Ready or Rejected. The scan is the gate — only a `wax_qc` cart that is
  scanned can be moved to wax_ready/wax_rejected.

## Status model (cartridge-record.ts)
- Add `wax_ready`, `wax_rejected` to the status enum (keep `wax_qc`; keep all legacy
  values so historical records / DHR / stats don't break).
- New status order: `… wax_filling → wax_filled → wax_stored → wax_qc → wax_ready/wax_rejected → reagent_filling …`.

## Changes
1. **Status enum + status-order arrays** — add the two statuses; update the lifecycle
   ordering used by cartridge-admin / dashboard / stats / DHR so the new states render
   in order (wax_rejected as an off-ramp).
2. **Capture → wax_qc.** When a photo (CvImage/CvInspection) is captured for a cart at
   `/wax-inspect`, transition that cart `wax_stored → wax_qc` (+ AuditLog). Only
   wax_stored carts are eligible to be photographed; capturing for a non-wax_stored
   cart is surfaced, not silently re-statused.
3. **Human verdict (scan-gated).** On `/wax-inspect`, a verdict surface: operator scans
   a cart QR → it must be `wax_qc` → shows its latest photo → **Ready** / **Rejected**
   (reason) buttons → sets `wax_ready`/`wax_rejected` + AuditLog + an inspection record.
   No scan ⇒ no transition.
4. **CV verdict hook.** Where CV inference results land (CvInspection result), if the
   cart is `wax_qc`, map result → wax_ready/wax_rejected automatically (guard: only when
   a model is actually deployed; manual override always allowed).
5. **Drop pre-storage QC.** Remove the wax-fill flow's accept/reject step that wrote
   `waxQc.status` before storage; wax fill ends at `wax_stored`. (Keep the `waxQc`
   field/photos as the inspection record going forward, or migrate to CvInspection —
   confirm during build; do not break DHR which reads waxQc + wax_qc photos.)
6. **Reagent gate.** `validate-equipment` (context=reagent) accepts ONLY `wax_ready`
   (was `[wax_filled, wax_stored, wax_qc]`). Error message: "must be wax-inspected
   (wax_ready) before reagent filling."

## Affected surfaces to keep consistent
- `src/lib/server/db/models/cartridge-record.ts` (enum)
- `src/routes/api/dev/validate-equipment/+server.ts` (reagent gate)
- `/manufacturing/cart-mfg/wax-inspect/{+page.server.ts,+page.svelte}` (capture→wax_qc, verdict)
- wax-fill flow QC removal (`wax-filling/+page.server.ts`, `opentron-control/wax/[runId]`)
- status-order lists: `cartridge-admin/*`, `routes/+page.*`, `cartridge-dashboard`, stats, DHR
- `ask-bims-tier1.ts` status-enum doc string

## Acceptance
- A wax_stored cart photographed at /wax-inspect becomes wax_qc.
- Scanning that wax_qc cart + tapping Ready → wax_ready (Rejected → wax_rejected); both
  audited; no transition without the scan.
- Reagent barcode scan rejects anything not wax_ready; accepts wax_ready.
- `npm run check` no new errors over baseline; build green.
- DHR / cartridge-admin still render historical wax_qc carts.

## Later (not this PRD)
- CV model deployment at the inspection phase (auto-verdict) — infra exists
  (`/api/cv/capture`, CvProject/CvInspection); this PRD only wires the mapping hook.
- wax_rejected disposition (scrap workflow).
