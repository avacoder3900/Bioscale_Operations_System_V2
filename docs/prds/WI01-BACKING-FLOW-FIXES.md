# PRD: WI-01 Backing Flow Fixes

**Status:** In progress
**Date:** 2026-06-16
**Route:** `src/routes/manufacturing/cart-mfg/wi-01/` (`+page.svelte`, `+page.server.ts`)
**Model:** `src/lib/server/db/models/lot-record.ts`

Three minor-but-annoying fixes to the cartridge backing flow (WI-01). Backing is
the **genesis** of every `CartridgeRecord` in the system — each scan into the
oven originates the record (status `backing`).

---

## Change 1 — Remove the redundant second oven selection

**Problem.** The operator picks the oven in "Set up batch" (config step). The
oven is only persisted onto the `LotRecord` per-cartridge at scan time, never at
setup — so any path that loses client state (notably **Resume**) presents an
oven `<select>` again in the scan session. Selecting the oven twice is redundant.

**Fix.**
- `checkAndStart` accepts `ovenId`, validates the oven, and stores it on the
  `LotRecord` as `backingOven: { ovenId, ovenName }`.
- `resumeLot` returns `ovenId` + `ovenName` (from `backingOven`, falling back to
  the first already-scanned cartridge's `backing.ovenLocationId`).
- Client: config form submits a hidden `ovenId`; on resume the client sets
  `ovenId` from the returned value.
- The scan session shows the oven as a **locked, read-only** value. The inline
  `<select>` is removed for all normal/resume paths (kept only as a last-resort
  fallback for legacy lots that have neither a stored oven nor any scans yet).

**Result.** Oven is chosen exactly once, in setup, for every new batch.

---

## Change 2 — Free / continuous scanning mode

**Problem.** In the scan session the operator must click into the barcode field
before each scan. The field auto-refocuses after a scan but (a) is `disabled`
during the async round-trip — which blurs it — and (b) has no blur-refocus, so
any stray click or the busy cycle drops focus and the next scan is lost.

**Fix.** A "scanning mode" the operator arms once:
- A **Start scanning / Pause** toggle (`scanArmed`). Entering the session arms
  it automatically and focuses the field.
- While armed: the field **auto-refocuses on blur** (and after every scan), and
  is **not disabled** during the async scan (re-entrancy is still guarded by
  `cartScanBusy`), so focus never drops between rapid scans.
- A clear "● Scanning active" indicator; clicking the scan card re-arms/refocuses.

**Result.** Click once → scan many cartridges back-to-back, hands-free.

---

## Change 3 — Reject a barcode that already exists at ANY status

**Requirement.** Because backing is the genesis of `CartridgeRecord`s, scanning
a barcode that already exists (at any status) must be rejected — a barcode can
only be born once.

**Status.** `scanBackedCartridge` already rejects any existing `CartridgeRecord`
(409). This PRD **hardens** it: keep the any-status check and make the error
message explicit about the genesis semantics so the operator understands why.
(`removeBackedCartridge` deletes the record, so a mis-scan removed in the same
session can still be re-scanned — correct.)

---

## Validation
- `npm run check` (no new errors over the 11 baseline), `npm run build` green.
- Manual: new batch (oven once → locked in session), resume (oven locked, not
  re-asked), rapid back-to-back scanning, re-scan of an existing barcode rejected.
