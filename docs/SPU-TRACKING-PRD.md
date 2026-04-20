# PRD: SPU & Inventory Tracking Hardening

**Status:** Draft
**Owner:** Alejandro Valdez (alejandrov@fannininnovation.com)
**Created:** 2026-04-16
**Source audit:** `docs/SPU-TRACKING-AUDIT.md`
**Working branch:** `spu-tracking-hardening` (to be created off `dev`)

---

## 1. Background

The audit in `SPU-TRACKING-AUDIT.md` surfaced seven gaps in how the BIMS tracks SPUs, inventory changes, and lot consumption. The underlying data models are sound; the weaknesses are in the *paths* that mutate state — some of them skip the canonical audit logging, some race each other, some silently drop bad input, and there is no automatic reconciliation to catch any of it.

This PRD describes a phased, low-risk remediation plan. Each phase ships independently, behind its own PR, and is verifiable on its own.

---

## 2. Goals

- **G1.** Make every inventory mutation atomic: either the live count and the ledger both update, or neither does.
- **G2.** Detect ledger-vs-live drift within one hour of its occurrence.
- **G3.** Log every write to `PartDefinition` — no silent mutations.
- **G4.** Eliminate the race condition on wax lot partial consumption; create a per-event ledger.
- **G5.** Centralize status enums and enforce valid state transitions at the code boundary.
- **G6.** Surface invalid barcode scans (currently swallowed) so operator errors are visible.

---

## 3. Non-goals

- UI redesign of SPU, assembly, validation, or parts pages. All changes here are server-side except for one small admin surface for the drift dashboard.
- New SPU phases or workflow changes.
- Replacing MongoDB / Mongoose, or migrating off nanoid IDs.
- Back-porting historical drift. We will *flag* existing mismatches; manual reconciliation by ops is a separate project.

---

## 4. Scope & Phases

Each phase is shippable on its own behind a small PR. Phases are sequenced so early phases reduce the cost of later phases.

### Phase 1 — Atomic Inventory Service (Goal G1)
**Estimated effort:** ~1 day

**Deliverables**
- Rewrite `src/lib/server/services/inventory-transaction.ts` so `recordTransaction` wraps the `PartDefinition.updateOne` and `InventoryTransaction.create` calls in a single Mongo session (`startSession` + `withTransaction`). Either both persist or both abort. The low-inventory notification check stays the same.
- Replace every direct `PartDefinition.updateOne({ $inc: { inventoryCount: ... } })` call with `recordTransaction()`. Target paths (from audit):
  - `src/routes/assembly/[sessionId]/+page.server.ts:230-231`
  - `src/routes/assembly/[sessionId]/+page.server.ts:257` (retraction)
  - `src/routes/parts/accession/+page.server.ts:306`
  - Any other grep hits for `PartDefinition.updateOne` not already using the service.
- Retraction path: instead of manually reversing counts, call `recordTransaction({ transactionType: 'adjustment', quantity: previousTx.quantity })` and mark the old transaction with a `retractedAt` field plus a `retractionTxId` pointer.

**Acceptance criteria**
- `grep -r "PartDefinition.updateOne" src/ | grep -v services/inventory-transaction.ts` returns zero hits (all callers go through the service).
- Unit or integration test exercises the happy path and the failure-in-second-write path; a forced failure leaves both collections unchanged.
- Existing contract tests (`npm run test:contracts`) still pass.
- Manual smoke: complete an assembly session, verify `PartDefinition.inventoryCount` drops and `InventoryTransaction` count increases by the same delta, then retract — both return to prior state.

---

### Phase 2 — Inventory Reconciliation Cron (Goal G2)
**Estimated effort:** ~0.5 day

**Deliverables**
- New route `src/routes/api/cron/reconcile-inventory/+server.ts`. Auth via `x-api-key` / `x-agent-api-key` matching `process.env.AGENT_API_KEY`. Accepts an optional `dryRun=true` query param.
- New model `src/lib/server/db/models/inventory-drift.ts`: `{ _id, partDefinitionId, partNumber, liveCount, ledgerSum, delta, detectedAt, severity ('minor' | 'major') }`. Indexed on `partDefinitionId` and `detectedAt` desc.
- Endpoint logic: `InventoryTransaction.aggregate([$group: { _id: '$partDefinitionId', sum: { $sum: '$quantity' } }])`, joined against `PartDefinition.inventoryCount`. Any mismatch > 0 writes a drift record. Severity: `major` if `|delta| > 5 || |delta| / liveCount > 0.05`.
- Add a cron entry in `vercel.json` that hits this endpoint once per hour (`0 * * * *`). Hobby-plan note: if Vercel rejects hourly, degrade to daily (`0 0 * * *`) and document the tradeoff in `CLAUDE.md` or release notes.
- Lightweight admin view at `/spu/admin/drift` (server-side only; use existing admin auth). Lists recent drift entries; no mutation actions.

**Acceptance criteria**
- Hitting the endpoint with a correct API key returns `{ ok, checked, mismatches, drifts: [...] }` within 30 s on current data volumes.
- Forcing a drift (manually set `inventoryCount` to a different value than the ledger sum) and hitting the endpoint creates an `InventoryDrift` record.
- Endpoint is idempotent — running it twice in a row does not create duplicate drift records for the same part unless the drift value changes.

---

### Phase 3 — Audit Every PartDefinition Mutation (Goal G3)
**Estimated effort:** ~0.5 day

**Deliverables**
- Inside the rewritten `recordTransaction`, also write an `AuditLog` entry (`tableName: 'part_definitions'`, `action: 'UPDATE'`, `oldData: { inventoryCount: previousQuantity }`, `newData: { inventoryCount: newQuantity }`, `reason: notes ?? transactionType`).
- For non-inventory `PartDefinition` writes (e.g. name / cost edits in `/parts` create / cartridge-part create), ensure each write site calls `AuditLog.create` with old+new snapshots. This is a straightforward wrap; add any missing sites.

**Acceptance criteria**
- After one wax-fill, querying `AuditLog.find({ tableName: 'part_definitions' }).sort({changedAt:-1}).limit(1)` returns the expected `oldData`/`newData`.
- No remaining `PartDefinition.updateOne` / `findByIdAndUpdate` / `.save()` call is missing a corresponding `AuditLog.create`.

---

### Phase 4 — Lot Consumption Ledger (Goal G4)
**Estimated effort:** ~1 day

**Deliverables**
- New model `src/lib/server/db/models/lot-consumption.ts`: `{ _id, receivingLotId, transactionType ('partial' | 'full'), volumeUl, quantity, manufacturingStep, manufacturingRunId, operatorId, operatorUsername, performedAt, notes }`. Immutable.
- Update wax-filling consumption path (`src/routes/manufacturing/wax-filling/+page.server.ts:~1022-1059`) to append to `LotConsumption` inside the same Mongo session as the `ReceivingLot.quantity` decrement and the `recordTransaction` call. Remove the `$set: { consumedUl }` write; compute remaining at read time instead.
- Update `/api/wax-batch/validate/+server.ts` to compute `remainingVolumeUl` from `totalTubes * 12000 - sum(LotConsumption.volumeUl where receivingLotId = lot._id)`.
- Migration helper (a one-shot `scripts/migrate-consumed-ul.ts` or a write on first-read) to seed `LotConsumption` with a single "migration" entry for each existing `consumedUl > 0` lot, preserving history.
- Mark `ReceivingLot.consumedUl` as deprecated in a comment but do not remove the field yet — keep it populated to match the ledger for at least one release cycle.

**Acceptance criteria**
- Two simultaneous wax fills on the same lot produce two `LotConsumption` entries with the correct sum; neither overwrites the other.
- `remainingVolumeUl` returned by the validate endpoint equals `initial − sum(ledger)` to the microliter.
- Existing partially-consumed lots show the same remaining volume before and after the migration.

---

### Phase 5 — Invalid Scan Logging (Goal G6)
**Estimated effort:** ~0.25 day

**Deliverables**
- New model `src/lib/server/db/models/invalid-scan.ts`: `{ _id, context ('assembly' | 'wax_filling' | 'cv' | ...), rawValue, sessionId?, runId?, operatorId, operatorUsername, occurredAt, reason }`. Non-immutable (we may want to mark "resolved" later; not in this phase).
- Update `/assembly/[sessionId]/+page.server.ts` scanPart action (line 202+): if `partDefinitionId` lookup returns null, create an `InvalidScan` entry and return `fail(400, { error: 'Unknown barcode — logged for review' })` instead of silently accepting.
- Same pattern for wax-fill tube scan and cartridge scan endpoints where applicable.

**Acceptance criteria**
- Scanning a nonsense string during assembly returns the 400, shows an error, and creates an `InvalidScan` row.
- Existing good-scan flows are unaffected (contract tests pass).

---

### Phase 6 — Centralized Status Enums + Transition Guard (Goal G5)
**Estimated effort:** ~0.5 day

**Deliverables**
- New file `src/lib/server/db/constants/status-enums.ts`: exports `SPU_STATUS`, `ASSEMBLY_STATUS`, `VALIDATION_STATUS`, `RECEIVING_LOT_STATUS` as `as const` string-literal arrays, with derived TypeScript types.
- Refactor each model to import its enum from this file instead of defining inline.
- New file `src/lib/server/db/constants/status-transitions.ts`: maps each SPU/Assembly/Validation status to its allowed successor statuses. Export `isValidTransition(kind, from, to): boolean`.
- Every code path that writes a new status (SPU, AssemblySession, ValidationSession) calls `isValidTransition` first and returns `fail(400, ...)` on rejection. Include in `AuditLog.create`'s `reason` field if a transition is forced via admin override (future work).

**Acceptance criteria**
- Attempting to jump an SPU from `draft` directly to `deployed` returns a 400 and does not mutate the DB.
- All four enums live in one file; `grep -n "type: String, enum: \[" src/lib/server/db/models/` shows no literal enum arrays for these four models.

---

## 5. Sequencing & Dependencies

```
Phase 1 ──┐
          ├── Phase 3 (audit log in the wrapper)
Phase 2 ──┘
Phase 4 (depends on Phase 1's atomic pattern)
Phase 5 (independent — can ship anytime)
Phase 6 (independent — can ship anytime)
```

Ship Phase 1 + 2 together as a single PR; they're the highest impact. Phase 3 is a small follow-up PR. Phases 4–6 are independent and can be interleaved.

---

## 6. Success Metrics

- **Drift incidents detected:** after 30 days of Phase 2 running, we have a historical record of any drift the system *did* produce.
- **Zero direct inventory mutations:** grep check in CI or a one-time review confirms nothing bypasses the service.
- **Lot consumption race incidents:** none observable (no "lost fill" reports from the line).
- **Invalid scan surface:** operators get immediate feedback on bad barcodes; ops team can review weekly.

---

## 7. Risks & Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| MongoDB Atlas session/transaction support requires replica set | Phase 1 could fail in dev | Atlas default cluster is a replica set; verify the dev URI supports transactions before coding |
| Vercel Hobby plan daily-cron limit | Phase 2 may need to degrade cadence | Accept daily if blocked; document the downgrade in the PR |
| Migrating `consumedUl` to ledger could double-count if run twice | Phase 4 data issue | Migration script idempotent: checks for existing migration entry per lot before inserting |
| Changing retraction semantics (Phase 1) may break an existing UI | Phase 1 regression | Keep `retractedAt` + `retractionTxId` pointer fields; UI that reads old retracted txns keeps working |

---

## 8. Out-of-scope (tracked for future)

- Admin override workflow for forced status transitions (Phase 6 leaves the hook but no UI).
- Per-operator invalid-scan dashboards / rate-limits (Phase 5 only logs; analytics come later).
- Historical drift reconciliation (requires ops sign-off on any corrections).
- Converting `AuditLog` entries to protobuf / cheaper storage (data-volume project).

---

## 9. Task breakdown (for the Ralph loop)

The loop will implement phases sequentially on branch `spu-tracking-hardening`, creating one commit per coherent unit of work and one PR per phase against `dev`.

**Phase 1 checklist** (tackle first):
- [ ] Create branch `spu-tracking-hardening` off `dev`
- [ ] Verify MongoDB supports transactions (dry-run `session.withTransaction` in a one-off script)
- [ ] Rewrite `recordTransaction` with `withTransaction` wrapper
- [ ] Update `src/routes/assembly/[sessionId]/+page.server.ts` scan + retraction paths
- [ ] Update `src/routes/parts/accession/+page.server.ts` quick-scan path
- [ ] Grep for any remaining direct `PartDefinition.updateOne` calls; migrate each
- [ ] Add an integration test that forces the second-write-failure path
- [ ] Run `npm run check` + `npm run test:contracts`
- [ ] Commit + open PR titled "feat(inventory): atomic recordTransaction (Phase 1 / PRD §4.1)"

**Phase 2 checklist:**
- [ ] Create `InventoryDrift` model with indexes
- [ ] Implement `/api/cron/reconcile-inventory/+server.ts`
- [ ] Add `/spu/admin/drift` admin view
- [ ] Wire cron entry in `vercel.json`
- [ ] Test: force a drift, hit endpoint, confirm record + idempotency
- [ ] Commit + open PR "feat(inventory): hourly drift reconciliation (PRD §4.2)"

Later phases follow the same pattern.

**Stopping conditions for the loop:**
- Contract tests fail — stop, report.
- TypeScript `npm run check` new errors — stop, report.
- A phase's PR is opened — stop that phase; don't auto-merge. Human merges, then loop picks up the next phase.
