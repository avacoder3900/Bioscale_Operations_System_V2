# Morning catch-up — 2026-04-24

Yesterday (2026-04-23) in this terminal:

1. **Audited scrap tracking** end-to-end against Atlas. Found and fixed: missing scrap `InventoryTransaction` on both `rejectAtSeal` actions, a double-submit idempotency gap in WI-01 `confirmComplete` (4 duplicate txns retracted on lot `KnvhBjHKSC0jStX1rQw4s`), and 90 cleanup-script cartridges missing inventory + audit trails (backfilled). Scrap audit now returns `ERRORS: 0 / WARNINGS: 0`.
2. **Built a manual checkout feature** at `/manufacturing/scrap` (labeled "Checkout" in the sidebar). Scan wax-stored cartridges, stage them (single or grouped), provide a reason, submit. History table shows the last 50 checkouts.
3. **Important semantics correction mid-session**: checkout is a physical-possession event and is *orthogonal to scrap*. A scrapped cartridge stays scrapped when checked out; a completed cartridge stays completed. The action no longer mutates `status`, no longer stamps `voidedAt`/`voidReason`, and no longer writes a scrap `InventoryTransaction`. It only creates a `ManualCartridgeRemoval` doc + one `AuditLog` per cartridge (`action='CHECKOUT'`). Wax-stored UI guard kept strict.
4. **Backfilled 30 historical cartridges** into the checkout system (IDs in `scripts/data/manual-removal-backfill-2026-04-23.txt`). Initial run wrongly flipped them to `status='scrapped'`; fully reverted. Their `ManualCartridgeRemoval` docs remain, their `status='completed'` restored, the 30 incorrect scrap txns marked retracted.

`origin/dev` tip is `2e57e80 refactor(checkout): manual removal is a checkout event, orthogonal to scrap`. Uncommitted and waiting on your call: `scripts/diag-checkout-connectivity.ts` (the cross-collection verification diag).

Handoff doc for a fresh auditor conversation is at `docs/scrap-tracking-and-manual-removal-handoff-2026-04-23.md` — note that doc was written *before* the checkout semantics correction, so two sections describe the old scrap-based behavior and should be read alongside this catch-up.
