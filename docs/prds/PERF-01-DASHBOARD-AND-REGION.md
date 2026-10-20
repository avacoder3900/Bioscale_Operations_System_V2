# PERF-01 — Dashboard counts, region, and per-request overhead

Written 2026-10-19. Cross-app context and the decision table are in
`brevitest-research-v2/docs/prds/DOMAIN-37-PERF.md`. BIMS is third in priority (after the
consumer app and research), but BM-02 is the one BIMS change that makes the *other* apps faster,
so it goes first within this PRD.

## Findings (read-only audit of `master` @ 5fddd11f, plus production Atlas stats)

- Functions pinned to `pdx1` since the initial commit (`63124154`, no rationale). Atlas is
  us-east-1; R2 is region-less; Anthropic/OpenAI/Box/Particle are national. Every DB round trip
  pays ~60–70 ms; the home page makes ~21 of them.
- Home page (`src/routes/+page.server.ts`) and `cartridge-dashboard/+page.server.ts` run ~11
  count/group aggregations each with `_id: {$nin: checkedOutIds}`. `$nin` on `_id` defeats the
  `status` index: each aggregation FETCHes all 18,616 cartridge docs (explain: 18,250 examined → 1
  returned, 1.8 s; group-by-status 18,616 → 14, 0.5 s). ~660 MB through a 512 MB cache per page
  load, in parallel. This evicts the research and consumer apps' working set.
- `storageCounts` (home L189–205, two aggregations) is never rendered.
- `ManualCartridgeRemoval` is append-only: created in scrap / wax-filling / bucket-service, never
  deleted, no return flow; `getCheckedOutCartridgeIds()` ignores `voidedAt` (preserve that).
  Therefore `count(P) − count(P ∧ _id ∈ S) ≡ count(P ∧ _id ∉ S)` for every predicate P.
- `capture_stations` READ is audited: 8,177 `audit_log` rows in October from a read path.
- `ot2_direct_calls`: 129,590 `run.get` rows for one run in October — a poll that also logs.
- `connection.ts` leaves `autoIndex`/`autoCreate` at defaults: 156 models fire `createCollection` +
  `createIndexes` on every cold start, competing with first requests for the 10-socket pool.
- `auth.ts`: `Session.findById` then `User.findById` sequentially per request; roles are embedded,
  so one `$lookup` aggregate is equivalent.
- Usage (6 months): route dirs untouched since spring — `api/opentrons`, `invite`, `api/bom`,
  `api/inventory`, `api/r2`, `api/coc`, `api/parts`, `api/device`, `api/receiving-lot`, `bom`,
  `test-results`, `_receiving`, `devices`. Not deleted here; noted for a cleanup PRD.

## Stories

### BM-01 — Run in iad1
**Status:** done (2026-10-19, master 085deba4) · **Files:** `svelte.config.js`
Change `regions: ['pdx1']` → `['iad1']` with a comment naming the Atlas region. Own commit, own
deploy. **Cons:** on-prem devices on the Pacific coast gain a few ms to the Vercel edge; every DB
RTT loses ~60 ms. Reversible in one line.
**Acceptance:** `x-vercel-id` on production shows `iad1`; `/login` TTFB median recorded before/after.

### BM-02 — Dashboard counts without `$nin`
**Status:** done (2026-10-19, branch perf/dashboard-and-region; helper is src/lib/server/checked-out-counts.ts) · **Files:** `src/routes/+page.server.ts`, `src/routes/cartridge-dashboard/+page.server.ts`, `src/lib/server/checkout-utils.ts` (new helper)
- New helper `subtractCheckedOut(pipelineResults, checkedOutIds)` pattern: run each count/group
  query **without** `$nin` (index-only on `status`, `waxQc.status`, `reagentInspection.status`,
  `createdAt`, `reagentFilling.assayType._id`), then **one** aggregation over
  `{_id: {$in: checkedOutIds}}` with `$facet` producing the same group keys, and subtract.
  Net: ~11 collection scans → ~11 index scans + 1 point-lookup aggregate.
- Keep `$nin` on the two sorted/limited list queries (recentActivity, expiringSoon) — the index walk
  stops early there.
- Delete the dead `storageCounts` block.
- Apply the same pattern to `cartridge-dashboard` (seven counts + occupancy). Other dashboards
  (`manufacturing/cart-mfg`, `cart-mfg-dev`, `consumables`) only if they use the same aggregations;
  otherwise leave for a follow-up.
**Cons:** two reads instead of one are not a single snapshot — a cart mutated between them can be
off by one for that load (the 21 parallel queries already have this race). Counts are otherwise
identical by construction.
**Verification before switching:** read-only script runs old and new pipelines against production
and asserts equality for every key; output pasted into `progress.txt`.
**Acceptance:** contract test `tests/contracts/13-dashboard-counts.test.ts` loads `/` and
`/cartridge-dashboard` and asserts `totalMfg + totalVoided` equals the sum of pipeline buckets, and
that the page returns in < 2 s locally. Fix the wrong path in `10-cartridges.test.ts:21`.

### BM-03 — Stop auditing `capture_stations` reads
**Status:** blocked — needs Jacob (2026-10-19): the rows are not reads. Every one is `reason: jwt_mint`, a 5-minute station token issued at `api/cv/stations/[id]/token` (8,292 in October, one user). Dropping the audit removes a credential-issuance trail; the cheaper fix is the client reusing its token until near expiry. · **Files:** wherever `AuditLog` is written with `tableName: 'capture_stations', action: 'READ'` (find via grep at implementation)
Reads are not mutations; remove the audit write on the read path (or sample 1-in-100 if someone
relies on it for presence). **Cons:** loses a "who looked at the station" trail — check the
consumer first; if it is the kanban/capture polling, no one reads it.
**Acceptance:** no new `capture_stations`/`READ` rows after deploy (checked next day).

### BM-04 — Tame the OT-2 run polling
**Status:** done (2026-10-19) — the 132k `run.get` rows came from EmbeddedRunController via direct-client.ts, not the clone run page; the trace now skips successful GETs · **Files:** `src/routes/opentrons-clone/[robotId]/runs/[runId]/+page.svelte` (and the `ot2_direct_calls` logger)
The run page polls with `invalidateAll()` (reruns auth + every load) and each `run.get` is logged
to Mongo. Change to `depends('ot2:run')` + `invalidate('ot2:run')`, and stop persisting `run.get`
polls (keep errors and mutations). **Cons:** less diagnostic history for polls — the existing rows
are 98% identical `run.get` lines.
**Acceptance:** polling a run page for 60 s produces 0 new `ot2_direct_calls` rows for `run.get`.

### BM-05 — Explicit index management
**Status:** done (2026-10-19) — report: all 156 models + permission_shadow_log already indexed in Atlas · **Files:** `src/lib/server/db/connection.ts`, new `scripts/ensure-indexes.ts`
`autoIndex: false, autoCreate: false` in production; script calls `Model.createIndexes()` per
model (per-model try/catch; import `PermissionShadowLog` from `route-policy.ts` explicitly; expect
`IndexOptionsConflict` on changed TTLs and report them rather than fail). **Never** `syncIndexes()`
— `users/sessions/roles/cartridge_records/assay_definitions/audit_log` are shared with research.
**Cons:** a new `schema.index()` is not live until the script runs; add the rule to CLAUDE.md.
**Pre-check:** read-only diff of declared indexes vs Atlas `getIndexes()`; create missing ones with
the script before merging.
**Acceptance:** unit tests pass; cold start no longer issues `createIndexes` (verified locally once).

### BM-06 — One auth round trip
**Status:** done (2026-10-19) · **Files:** `src/lib/server/auth.ts`
`Session.aggregate([$match _id, $lookup users, $unwind, $project -passwordHash])`; keep the
expiry/inactive post-checks and the ≤15-day renewal write as they are. **Cons:** none; identical data.
**Acceptance:** `01-auth.test.ts` passes.

### Deferred (noted, not scheduled)
- SPU page: 12 sequential awaits → `Promise.all` + one `User.find` over the union of ids. Worth ~20 ms after BM-01.
- OT-2 bridge long-poll re-queries Mongo every 250 ms per device (8.6M ops / 12 days). Change streams or 500 ms would halve it; operator-latency trade-off, decide with the robot team.
- Drop/hide the 26 unused `cartridge_records` indexes (hide first, 30 days, then drop).
- Dead route cleanup (list above).
