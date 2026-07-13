# BIMS V2 — Architecture Rundown

*Surveyed 2026-07-12 from the home-root clone at `C:\Users\aleja` (branch `spudashchange-stalefork`, SPU/thermocouple line of work).*

> **Scoping note:** The CV/capture-station work — Cloudflare R2 photo storage, Pi camera
> agents, `STATION_AGENT_KEY` — lives in the OneDrive clone and is **not** in this
> checkout. It is mentioned where relevant, but all code references below are from this
> repo.

---

## 1. Data Structures

The heart of the system is **58 Mongoose models** in `src/lib/server/db/models/`,
organized into an explicit **three-tier trust model** in the barrel file
(`models/index.ts`):

### Tier 1 — Sacred documents
`User`, `CartridgeRecord`, `Spu`, `AssayDefinition`, `ReagentBatchRecord`.

These are the regulated system-of-record documents. Middleware in
`db/middleware/sacred.ts` lets them be edited freely until `finalizedAt` is set, then
blocks all updates and all deletes. Post-finalization changes must go through an
append-only `corrections[]` array (previous value, new value, reason, who corrected,
who approved).

### Tier 2 — Operational
Everything workflow-shaped:

- **SPU manufacturing**: assembly sessions, work instructions, BOM items, batches,
  production runs, wax-filling runs, laser-cut batches, routing patterns,
  manufacturing materials
- **Receiving & inspection**: receiving lots, inspection results/procedures, tool
  confirmations
- **Equipment / devices**: equipment + locations, Particle devices, firmware devices,
  Opentrons robots, consumables (decks, cooling trays)
- **Validation / test**: validation sessions (magnetometer, thermocouple, lux,
  spectrophotometer), test results
- **Barcodes / logistics**: generated barcodes, shipping lots/packages, inventory,
  customers
- **Documents / QMS**: documents, repositories, files, QMS state, approval requests
- **Kanban**: projects, tasks, workflow violations
- **Agent/AI integration**: agent queries, agent messages, integrations, system
  dependencies

### Tier 3 — Immutable logs
`AuditLog`, `ElectronicSignature`, `InventoryTransaction`, `DeviceEvent`,
`ManufacturingMaterialTransaction`.

Middleware (`db/middleware/immutable.ts`) throws on any update or delete — true
append-only collections.

### Key modeling decisions

- **IDs are nanoid strings everywhere** (`generateId()` in `db/utils.ts`), never
  ObjectIds. References between documents are plain string IDs — there is **zero use
  of Mongoose `ref`/`populate`**; joins are done by hand or avoided via
  denormalization.
- **Heavy embedding and snapshotting.** An SPU document embeds its assembly step
  records, validation results, status transitions, Particle link, and even file
  attachments inline. Who-did-what is captured as `{ _id, username }` snapshots at
  action time (the shared `operatorRef` pattern), so history stays accurate even if a
  user is renamed. Users are never deleted, only deactivated
  (`deactivatedAt`/`deactivatedBy`/`deactivationReason`).
- **Audit logging** is a generic change-capture model (`audit-log.ts`): old data / new
  data / changed fields as `Mixed`, plus session ID, IP, and user agent, indexed by
  record (`{tableName, recordId}`) and by actor (`{changedBy, changedAt}`).
- **Typing is split into two worlds.** The schemas themselves are untyped JS objects
  (no `InferSchemaType`, middleware uses `this: any`), while hand-written flattened
  view-model interfaces live in `db/schema.ts` and `app.d.ts`. The two are kept in
  sync manually. This is the biggest structural weak point in the data layer — strict
  mode silently dropping schema-absent fields already broke CV on main once.
- **Ten unique indexes** are the E11000-prone spots: `generated_barcodes.barcode` (the
  classic collision point), `spu.udi`, `user.username`, `user.email` (sparse),
  `assay-definition.skuCode`, `invite-token.token`, `lot-record.qrCodeRef`,
  `part-definition.partNumber`, `receiving-lot.lotId`, `role.name`.

### Known issue found during survey
`validation-session.ts` declares `spuId` **twice** in the same schema literal (lines 6
and 9) — the second silently wins. Latent bug.

---

## 2. Storage Systems

Three distinct storage tiers in this clone (R2 is a fourth tier, in the CV clone only):

### MongoDB Atlas — primary store
- Lazy connection singleton (`db/connection.ts`) reading `MONGODB_URI` from
  `$env/dynamic/private`; `maxPoolSize: 10`, `minPoolSize: 1`, 5s connect/selection
  timeouts, 10s socket timeout — tuned for serverless.
- Sessions live here too: the `Session` model stores `sha256(token)` as its `_id` (raw
  tokens never persisted), 30-day sliding expiry with renewal inside the last 15 days.

### Box.com — document/photo object store
- OAuth 2.0 client in `src/lib/server/box.ts`; tokens stored in the Mongo
  `Integration` collection with auto-refresh and 401-retry.
- Files referenced from Mongo as Box file IDs / `app.box.com/files/<id>` URL strings
  (e.g. receiving CoCs, `photos: [String]` on receiving lots).
- Env: `BOX_CLIENT_ID`, `BOX_CLIENT_SECRET`, `BOX_REDIRECT_URI`,
  `BOX_ROOT_FOLDER_ID`. Routes under `api/box/*`; sync helper in `box-sync.ts`.

### Inline-in-Mongo attachments — small files
- Thermocouple CSVs stored as string content on `spu.attachments[]`
  (`spu.ts:100-112`) with mime type and row count.
- A `File` model exists for metadata (`storagePath`, checksum, versioning) but no
  GridFS is used.

---

## 3. Cloud Infrastructure

| Piece | Platform | Notes |
|---|---|---|
| SvelteKit app | Vercel serverless | `adapter-vercel`, `nodejs22.x`, region `pdx1`, `maxDuration: 30` |
| bims-mcp MCP server | Fly.io | app `bims-mcp-fannin`, scale-to-zero, `/healthz` check |
| Device cloud | Particle Cloud | token in `Integration` collection, webhook inbound |
| Object storage | Box.com | OAuth, tokens in Mongo |
| Database | MongoDB Atlas | via `MONGODB_URI` |

- **No `vercel.json` in this repo**, so no Vercel Crons — the two cron endpoints
  (`/api/cron/free-cooled-trays`, `/api/cron/archive-done-tasks`) are plain POST
  endpoints guarded by `AGENT_API_KEY` that expect an **external scheduler** to hit
  them.
- **Agent/device API surface**: ~27 routes under `/api/agent/*` (dashboard, inventory,
  equipment, kanban tree, saved-query engine at `/api/agent/query`), all authenticated
  with a timing-safe key compare (`api-auth.ts`) accepting `x-api-key`,
  `x-agent-api-key`, or Bearer.
- **bims-mcp** (`bims-mcp/`) is a thin proxy: MCP tools → HTTP calls to `/api/agent/*`
  using `AGENT_API_KEY`; its own HTTP transport is Bearer-authenticated
  (`MCP_BEARER_TOKEN`). **Drift found:** the MCP client calls
  `/api/agent/operations/spus`, which doesn't exist in this checkout.
- **Particle integration** (`particle.ts`): syncs devices into Mongo, links devices to
  SPUs by UDI suffix (`Spu.particleLink`), and the inbound webhook
  (`/api/particle/webhook`) converts device events into immutable `DeviceEvent`
  records.
- **No queues or workers.** QMS gates, cooling state machines, Box sync — everything
  runs inline inside request handlers within Vercel's 30-second limit.

---

## 4. Frontend Framework

- **SvelteKit 2 + Svelte 5, fully on runes.** Zero legacy syntax (`export let`, `$:`)
  anywhere — every component uses `$props()`, `$state`, `$derived`, snippets, and
  `{@render}`.
- **Data flow is classic SvelteKit SSR**: `+page.server.ts` load functions query
  Mongoose directly (auth check → `connectDB()` → query → serialize), form actions
  with `use:enhance` for mutations, `/api/*` endpoints for client-side fetches.
- **Real-time is polling-based** — `setInterval` in ~14 files (instrument capture,
  Opentrons run monitoring, wax cooling timers). No WebSockets or SSE anywhere.
- **Styling is Tailwind v4, CSS-config only** (no `tailwind.config.js`): a `@theme`
  block in `routes/layout.css` defines the "TRON" design system — dark-only neon
  palette (`--color-tron-cyan` etc.), glow shadows, grid/scanline backgrounds, and a
  44px touch-target token for shop-floor tablet use.
- **Zero external UI or chart libraries.** Primitives are homegrown (`TronCard`,
  `TronButton`, `TronInput`, `TronBadge`, `TronProgress`) plus domain components
  (kanban board, electronic signature for Part-11-style signoff, wax-filling run
  execution). Charts are hand-rolled SVG (e.g. `ThermocoupleChart.svelte`).
- **Most client-heavy code is Web Serial instrument capture**: three serial-service
  classes (`thermocouple-serial.ts`, `spectrophotometer-serial.ts`,
  `magnetometer-serial.ts`) drive USB instruments directly from the browser, feeding
  the validation capture UIs under `/spu/validation/*`. Types declared in
  `src/web-serial.d.ts`.
- **No `src/lib/stores` directory** despite CLAUDE.md listing one — state is
  component-local via runes.

### Key dependencies
SvelteKit `^2.50.2` · Svelte `^5.51.0` · Vite `^7.3.1` · Tailwind `^4.2.1` ·
`adapter-vercel` `^6.3.3` · Mongoose `^9.2.3` · bcryptjs · @oslojs/crypto ·
nanoid · xlsx · mdsvex

---

## Improvement Candidates (to be prioritized later)

1. **Data structures** — the untyped-schema / hand-written-interface split (drift
   already caused one production CV breakage); the duplicate `spuId` in
   `validation-session.ts`; inconsistent `createdBy` shapes (bare string in most
   models, `{_id, username}` snapshot in others).
2. **Storage** — inline CSV attachments in Mongo will hit the 16MB document cap and
   bloat the working set as SPUs accumulate attachments; unifying file storage (Box vs
   inline vs the CV clone's R2) is the big architectural question.
3. **Cloud** — external-scheduler crons with no visibility or retry; everything inline
   under a 30s serverless ceiling; the MCP server already drifting from the app's API
   surface.
4. **Frontend** — polling everywhere for real-time views; CLAUDE.md describing a
   structure (stores dir, frozen `.svelte` rule, "53 models") that no longer matches
   reality.

---

# Performance Audit — Storage, Reads (get), Writes (push) & Data Packaging

*Audited 2026-07-13 via two code sweeps: read-side (361 find-style calls across ~107
server files) and write-side (form actions, serialization, embedded arrays,
connection handling).*

## What's already healthy

- `.lean()` adoption is high — the gap between reads and `.lean()` calls is almost
  entirely action handlers that must NOT use it (findById → mutate → save).
- **Zero N+1 query loops** — the codebase consistently batches with `$in` and uses
  aggregation for group counts.
- 47 load functions already parallelize queries with `Promise.all`.
- Inline CSV attachments are fine as stored: 5 MB cap enforced at upload
  (`thermocouple/+page.server.ts:84-87`), realistic size tens of KB.
- Instrument readings are written as one bulk array per session, not per-reading
  pushes.
- `ManufacturingMaterial.recentTransactions[]` uses `$push` + `$slice: -100` — the
  house best-practice pattern for capped arrays.

## P0 — Bugs (fix first)

1. **AuditLog query uses non-existent fields** — `spu/[spuId]/+page.server.ts:23`
   queries `{ entityId }` sorted by `createdAt`, but the schema has `recordId` and
   `changedAt` (`timestamps: false`). Result: a full collection scan of the
   forever-growing `audit_log` on every SPU detail view that returns **no data**.
   Fix: `{ tableName: 'spus', recordId: params.spuId }` sorted by `changedAt`.
2. **`CartridgeRecord.phases` writes may be silently dropped** — several actions
   `$push` to `phases` (e.g. `shipping/+page.server.ts:187-193`) but no `phases`
   field is declared in `cartridge-record.ts`. Under Mongoose strict mode those
   writes vanish. Same failure family as the strict-mode bug that broke CV.

## P1 — Read side (get)

3. **Fat unprojected list queries.** `spu/mfg/+page.server.ts:11` does `Spu.find()`
   with no limit and no projection — every SPU in full (inline CSVs, assembly trees,
   corrections, Mixed rawData) to display ~9 scalar fields. Same for
   `batches/[batchId]/+page.server.ts:13`. Rule: any display query on SPUs must
   exclude `attachments.content`. Good reference pattern:
   `cartridges/analysis/+page.server.ts:17` (projection + `usageLog: {$slice:-1}`).
4. **~7 missing indexes** (queried fields with no index → collection scans):
   - `spus`: `createdAt: -1` (both main list pages sort on it)
   - `test_results`: `{status, createdAt}`, `deviceId`, `assayId`
   - `inventory_transactions`: `{partDefinitionId, performedAt}`, `{performedAt: -1}`
   - `assembly_sessions`: `spuId` (hit on every SPU detail view)
   - `electronic_signatures`: `{entityType, entityId}` (every SPU detail view)
   - `lab_cartridges`: `status`, `groupId`, `createdAt: -1`
   - `cartridge_records`: `createdAt: -1` (statistics page range scans)
5. **~12 unbounded list queries** (no `.limit()`): spu/mfg, cartridges/analysis,
   assays, parts, customers, documents/instructions, documents/repository,
   manufacturing/inventory, consumables, laser-cutting, equipment/activity.
   Degrade linearly with data growth. Pages that already paginate correctly:
   cartridges (50/page), shipping, devices, build-logs (100).
6. **Per-navigation layout queries.** `spu/+layout.server.ts:16,23` runs two
   *sequential* `Integration.findOne` calls on every navigation in the app;
   `kanban/+layout.server.ts:12-13` runs sequential projects + unbounded
   `User.find({})`. Also sequential-but-independent chains in
   `spu/[spuId]` (3 user lookups), `assembly/[sessionId]`, `documents/[id]`,
   `kanban/task/[taskId]`.

## P2 — Write side (push)

7. **Sequential independent writes.** `await Model.create()` → `await
   AuditLog.create()` in 50+ actions (2 serial round-trips each). Worst:
   `receiving/new/+page.server.ts` with **6–8 serialized writes** (lot, tool
   confirmations, inspection results, part update, 2 transactions, material update,
   2 audit logs). IDs are pre-generated nanoids, so most writes are independent and
   `Promise.all`-able. Also `validation/magnetometer` (3 serial writes) and
   `shipping` (2).
8. **Read-modify-write race on cartridges.** `spu/cartridges/+page.server.ts:104-142`
   (updateStatus / changeGroup): findById → mutate → `usageLog.push()` → `save()`.
   Rewrites the whole doc (lost-update race) including the entire `usageLog[]` —
   the only genuinely unbounded embedded array in the system. Fix: atomic
   `$set` + `$push` (with `$slice` cap), like the rest of the codebase.

## P3 — Data packaging

9. **Oversized client payloads.** `test-results/[resultId]/+page.server.ts:39-57`
   ships the full `readings[]` (16 numeric fields × up to thousands of readings) to
   render a table. The list page already does it right (`readings: 0` projection).
10. **Redundant deep clones.** 10 `JSON.parse(JSON.stringify(...))` sites, mostly
    cloning `.lean()` results that are already plain objects — wasted lambda CPU.
    (CLAUDE.md prescribes this pattern; doc should be updated alongside.)
11. **Connection not hardened for serverless.** `connection.ts` caches a boolean,
    not the in-flight promise → concurrent cold-start requests can each connect.
    `minPoolSize: 1` holds an Atlas socket per idle lambda; `maxPoolSize: 10` ×
    many lambdas can pressure the Atlas connection ceiling. Fix: cache the connect
    promise on `globalThis`, `minPoolSize: 0`.

## Suggested order
Bugs (#1, #2) → indexes (#4, trivial one-liners) → hot-path projections (#3) →
layout parallelization (#6) → write parallelization (#7) + race fix (#8) →
connection (#11) → payloads (#9) / clone cleanup (#10) → pagination for #5 as a
follow-up (needs UI pagination controls).
