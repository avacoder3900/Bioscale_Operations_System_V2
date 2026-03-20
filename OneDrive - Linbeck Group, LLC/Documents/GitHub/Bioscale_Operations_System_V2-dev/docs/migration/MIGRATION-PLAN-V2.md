# Bioscale Operations System — MongoDB Rebuild Plan V2

**Date:** February 27, 2026
**Author:** Agent001 + Jacob Quick (workshopped)
**Status:** Plan — awaiting approval to begin execution
**Old Repository:** `/Users/agent001/Bioscale_Operations_System` (Postgres — stays untouched as reference)
**New Repository:** `/Users/agent001/Bioscale_Operations_System_V2/` (fresh SvelteKit project)

---

## Why V2?

The first migration attempt (`mongo-migration` branch) tried to rewrite the backend in-place — translating Drizzle/Postgres queries into Mongoose/MongoDB queries across the existing codebase simultaneously. The result was a broken app with mismatched data shapes, missing fields, and UI components receiving data they didn't expect.

**Root cause:** The agents were reverse-engineering behavior from Drizzle query code instead of working from a clear specification of what the UI actually needs. When you translate `db.select().from(spuTable).where(...)` into `Spu.find(...)`, subtle differences in joins, field names, and return shapes break the frontend silently. In-place surgery on a codebase where the entire data model is changing (relational → document, 110 tables → 33 collections) is where projects go sideways.

**The V2 approach:** Greenfield rebuild with a golden master. Don't migrate — rebuild.
1. Capture what the working app actually does (test suite against Postgres app)
2. Define what data each page needs (contract registry)
3. Build a fresh app: copy the UI layer, write new server layer from specs + MongoDB schema
4. Verify the new app with the same tests

The old Postgres app stays running and untouched the entire time. It's the reference, not the patient.

---

## Core Principle: Three Separable Layers

The app is three independent layers:

| Layer | What It Is | Changes in Migration? |
|-------|-----------|----------------------|
| **UI** | `.svelte` components, CSS, client-side JS | **NO** — identical, untouched |
| **Data Contracts** | The shape of data flowing between UI and server | **NO** — must be preserved exactly |
| **Server + Database** | `+page.server.ts`, `/api/*` routes, DB models, queries | **YES** — this is what we rewrite |

The UI layer and the server layer communicate through **data contracts** — the return types of `load()` functions, the inputs/outputs of form actions, and the request/response shapes of API endpoints.

**If the data contracts are preserved, the UI cannot tell the difference.** This is the entire strategy.

---

## Phase 0: Pre-Work — Reference Documents

These already exist and are ready:

| Document | Location | Status |
|----------|----------|--------|
| MongoDB Schema Specification V2 | `projects/mongodb-redesign/COMPLETE-SCHEMA-SPECIFICATION.md` | ✅ Complete |
| V2 Rewrite Decisions | `projects/mongodb-redesign/HANDOFF-V2-REWRITE.md` | ✅ Complete |
| Schema Context (domain reference) | `skills/brevitest-agent/references/schema-context.md` | ✅ Complete |

---

## Phase 1: Characterization Test Suite

**Goal:** Capture the current working behavior of every route and API endpoint as automated tests. These tests become the safety net for the entire migration.

**Branch:** `dev` (the working Postgres version)

### What Gets Tested

For every route in the application:

**Load Function Tests:**
- Hit the route via HTTP GET
- Verify response status (200, redirect, etc.)
- Verify the data shape — every property the `.svelte` file accesses via `data.` must be present
- Verify field types (string, number, array, object)
- Verify arrays contain objects with the expected properties
- Verify enum values where applicable (status fields, types, etc.)

**Form Action Tests:**
- Submit forms via HTTP POST
- Verify success responses (redirect, return data)
- Verify validation errors on bad input
- Verify side effects where observable (created record appears in subsequent GET)

**API Endpoint Tests:**
- Hit every `/api/*` route with appropriate HTTP methods
- Verify response shapes
- Verify error handling (404 for missing records, 401/403 for unauthorized)

**Business Logic Tests:**
- Cartridge lifecycle progression (can't skip phases)
- Permission enforcement
- Required field validation
- Cascading effects (e.g., completing a wax run updates cartridge records)

### Test Architecture

```
tests/
├── contracts/
│   ├── auth.test.ts              # login, logout, sessions, invite
│   ├── spu.test.ts               # SPU CRUD, detail, parts, assembly
│   ├── manufacturing.test.ts     # lots, wax filling, reagent filling, QC
│   ├── kanban.test.ts            # projects, tasks, board, proposals
│   ├── shipping.test.ts          # lots, packages, customers
│   ├── inventory.test.ts         # parts, BOM, transactions
│   ├── documents.test.ts         # work instructions, controlled docs, repository
│   ├── equipment.test.ts         # fridges, ovens, locations, robots
│   ├── cartridge-lab.test.ts     # lab cartridges, firmware, test results
│   ├── admin.test.ts             # users, roles, permissions, approvals
│   └── agent-api.test.ts         # agent queries, messages, routing
├── helpers/
│   ├── client.ts                 # HTTP client wrapper (fetch + cookie jar for auth)
│   ├── auth.ts                   # Login helper, get authenticated session
│   └── assertions.ts             # Custom shape matchers
├── setup.ts                      # Global setup (start app if needed, login)
└── vitest.config.ts              # Test runner config
```

### Key Design Rules

1. **Tests hit HTTP only.** No database imports, no ORM references, no Drizzle, no Mongoose. Pure `fetch()` against the running app.

2. **Tests are database-agnostic.** They verify shapes and behavior, not implementation. The same test file runs against Postgres or MongoDB.

3. **Tests use a real running app.** The dev server must be running with seeded data. Tests don't mock anything — they test the real stack.

4. **Authentication is handled via cookie.** Tests log in once, capture the session cookie, and pass it on subsequent requests.

5. **Tests are organized by domain**, not by route, so related behavior is tested together.

### Execution

```bash
# Terminal 1: Start the app on dev branch
cd /Users/agent001/Bioscale_Operations_System
git checkout dev
npm run dev

# Terminal 2: Run tests
npm run test:contracts
```

**Success criteria:** 100% of tests pass against the Postgres app. This is the green baseline. Any test that fails here is a test bug, not an app bug.

### Estimated Scope

| Area | Routes (approx) | API Endpoints (approx) | Test Cases (approx) |
|------|-----------------|----------------------|---------------------|
| Auth & Users | 5 | 3 | 20 |
| SPU & Assembly | 12 | 8 | 50 |
| Manufacturing Pipeline | 15 | 10 | 60 |
| Kanban | 6 | 8 | 30 |
| Shipping & Customers | 5 | 4 | 20 |
| Inventory & BOM | 8 | 6 | 30 |
| Documents & WI | 8 | 5 | 25 |
| Equipment | 6 | 4 | 20 |
| Cartridge Lab & Firmware | 8 | 6 | 25 |
| Admin & Approvals | 4 | 5 | 15 |
| Agent API | 3 | 8 | 20 |
| **Total** | **~80** | **~67** | **~315** |

---

## Phase 2: Contract Registry

**Goal:** Extract and document the exact data shape every page expects from its server layer. This is the specification that migration agents work from.

### What the Registry Contains

For every route, a structured entry:

```markdown
## Route: /spu/manufacturing/reagent-filling

### Load Function
Returns:
- `runs`: ReagentFillingRun[] — active and recent runs
  - `id`: string
  - `status`: 'setup' | 'running' | 'completed' | 'aborted'
  - `robot`: { id: string, name: string }
  - `assayType`: { id: string, name: string, skuCode: string }
  - `operator`: { id: string, username: string }
  - `cartridgeCount`: number
  - `createdAt`: string (ISO date)
- `robots`: Robot[] — available robots for dropdown
- `assayTypes`: AssayType[] — active assay types for dropdown

### Form Actions
**action: create**
Accepts: { robotId: string, assayTypeId: string, deckId?: string }
Returns: redirect to /spu/manufacturing/reagent-filling/[newRunId]
Side effects: creates run record, logs audit entry

**action: abort**
Accepts: { runId: string, reason: string }
Returns: { success: boolean }
Side effects: updates run status, logs audit entry

### Client-Side API Calls
- GET /api/reagent-filling/[id]/cartridges → CartridgeSummary[]
- POST /api/reagent-filling/[id]/add-cartridge → { cartridgeId: string }
```

### How It's Extracted

1. **Automated scan:** Agent reads every `+page.server.ts` and extracts `load()` return shapes and `actions` signatures
2. **Cross-reference:** Agent reads corresponding `+page.svelte` files and traces every `data.` property access to verify completeness
3. **API scan:** Agent reads every `src/routes/api/**/+server.ts` file and documents request/response shapes
4. **Manual review:** Jacob spot-checks critical routes (manufacturing pipeline, shipping) for accuracy

### Output

Single file: `projects/mongodb-redesign/CONTRACT-REGISTRY.md`

This becomes the primary reference document for Phase 3 agents. They don't need to read the old Postgres code at all — they work from the contracts + the MongoDB schema spec.

---

## Phase 2.5: PRDs & Acceptance Criteria

**Goal:** Write detailed PRDs for each domain, following the Ralph Loop workflow. These become the implementation specs that coding agents work from.

**Prerequisite:** Phases 1+2 must be complete. The contract registry and test suite provide the raw material for acceptance criteria.

### One PRD Per Domain

Each PRD covers one domain from the Phase 3 domain order table (Auth, Kanban, Customers, etc.) and contains:

1. **Scope** — Which routes, API endpoints, and Mongoose models are involved
2. **Contract References** — Exact entries from the Contract Registry this domain must fulfill
3. **MongoDB Schema References** — Which collections from the Schema Spec V2 are used
4. **Stories** — Broken into implementable units (e.g., "Implement /spu load function", "Implement /spu/[id] detail page + form actions")
5. **Acceptance Criteria** — Specific test file(s) that must pass: "Done when `auth.test.ts` passes against the new app"
6. **Dependencies** — Which other domains must be complete first

### PRD Structure

```
prd.json (in new repo root)
├── DOMAIN-01-AUTH.md
├── DOMAIN-02-KANBAN.md
├── DOMAIN-03-CUSTOMERS.md
├── ...
└── DOMAIN-11-AGENT-API.md
```

Each PRD follows the repo's existing PRD format with stories in `prd.json` for Ralph Loop agents.

### Why After Phases 1+2

The contract registry tells you WHAT each page needs. The test suite tells you HOW to verify it. Without both, PRD acceptance criteria would be vague ("page should work") instead of precise ("GET /spu returns 200 with `spus` array where each item has `_id`, `udi`, `status`, `batch`, `parts` — verified by `spu.test.ts` lines 12-45").

---

## Phase 3: Greenfield Build

**Goal:** Build a fresh SvelteKit app with MongoDB backend that passes every characterization test from Phase 1.

### Project Setup

1. Create new SvelteKit project (same config: TypeScript strict, Svelte 5, adapter-auto)
2. Copy entire `src/routes/**/+page.svelte` and `+layout.svelte` files (UI layer — untouched)
3. Copy static assets, app.html, global CSS, component library (`$lib/components/`)
4. Copy client-side utilities (`$lib/utils/`, `$lib/stores/`, etc.)
5. Set up Mongoose connection + models from the MongoDB Schema Specification V2
6. Write new `+page.server.ts` and `/api/*` handlers from the Contract Registry

**What gets copied verbatim (the UI):**
- All `.svelte` components (pages, layouts, shared components)
- All CSS/Tailwind config
- All client-side JS (stores, utilities, helpers)
- Static assets (images, fonts, etc.)
- `app.html`, `hooks.server.ts` (auth logic rewritten for Mongoose)

**What gets written fresh (the server layer):**
- Every `+page.server.ts` (load functions + form actions)
- Every `+server.ts` (API endpoints)
- `src/lib/server/db/` (Mongoose models, connection, middleware)
- Auth/session handling (adapted for MongoDB)

### Agent Architecture

```
MAIN SESSION
│  Coordinates, tracks progress, handles merges
│
├── CODING AGENT A (Opus)
│     Works on one domain at a time (e.g., all manufacturing routes)
│     Receives: contract registry entries + MongoDB schema spec + copied .svelte files
│     Produces: new +page.server.ts files + API handlers
│     Runs domain tests after each route to verify
│
├── CODING AGENT B (Opus)
│     Same pattern, different domain
│     (Only if Agent A's domain is large enough to justify parallelism)
│
└── (Max 2 agents to avoid coordination overhead)
```

### Per-Route Workflow

For each route the coding agent works on:

1. **Read the contract** — What does this page need? What are the exact shapes?
2. **Read the MongoDB schema** — Which collection(s) serve this data? What's embedded vs referenced?
3. **Read the `.svelte` file** — Confirm every `data.` access is covered by the contract
4. **Write the new `+page.server.ts`** — Mongoose queries that produce the exact contract shape
5. **Write API handlers** — Same approach for any `/api/*` endpoints this page uses
6. **Run the contract tests for this route** — Verify green
7. **Commit** — One commit per route or small group of related routes

### Domain Order (suggested)

Start with simpler, self-contained domains to build confidence, then tackle the complex manufacturing pipeline:

| Order | Domain | Complexity | Dependencies |
|-------|--------|-----------|-------------|
| 1 | Auth & Users | Low | None — foundational, needed by everything |
| 2 | Kanban | Low | Users only |
| 3 | Customers | Low | Users only |
| 4 | Equipment & Locations | Low | Users only |
| 5 | Documents & Work Instructions | Medium | Users |
| 6 | Parts & BOM & Inventory | Medium | Users |
| 7 | SPU & Assembly | High | Users, Parts, WI, Equipment |
| 8 | Manufacturing Pipeline | High | Users, Equipment, Assays, SPUs |
| 9 | Shipping & Fulfillment | Medium | Customers, Manufacturing |
| 10 | Cartridge Lab & Firmware | Medium | Assays, SPUs |
| 11 | Agent API & Admin | Medium | Everything |

### Branch Strategy

Simple — it's a fresh repo:

```
main (new repo)
├── domain branches merge sequentially
│   auth → kanban → customers → equipment → ...
└── each merge only after domain tests are green
```

No dual-database complexity. No Drizzle coexistence. Clean from the start.

---

## Phase 4: Verification

**Goal:** Confirm the new app is functionally identical to the original.

### Automated (Agent001 does this)

- Run the full characterization test suite against the new MongoDB app
- Compare test results: every test that passed on Postgres must pass on MongoDB
- Run linting/type checking: `npm run check`
- Run build: `npm run build`

### Manual (Jacob does this)

- Spot-check critical workflows end-to-end:
  - Create a wax filling run → fill cartridges → inspect → store
  - Create a reagent filling run → fill → inspect → top seal → QC release
  - Create an SPU → assemble → validate → assign
  - Ship cartridges to a customer
  - Create and manage kanban tasks
- Verify pages look identical (same layout, same data, same behavior)
- Test edge cases: empty states, error messages, permission denied screens

### Success Criteria

- [ ] 100% of characterization tests pass on the new MongoDB app
- [ ] `npm run check` passes (no TypeScript errors)
- [ ] `npm run build` succeeds
- [ ] Jacob confirms critical workflows work correctly
- [ ] App deploys successfully to Vercel
- [ ] Old Postgres app can be decommissioned

---

## Data Migration (Separate Workstream)

This plan covers the **application code** migration. The actual data migration (moving records from Supabase Postgres to MongoDB Atlas) is a separate task:

1. Write migration scripts that read from Postgres and write to MongoDB in the new schema shapes
2. Handle the schema transformations (junction tables → embedded arrays, etc.)
3. Run against a staging copy first
4. Coordinate cutover timing with Jacob

This can happen in parallel with Phase 3 or after Phase 4, depending on preference.

---

## Checklist: Easy Items That Must Not Be Forgotten

These are all small, straightforward tasks — none are technically difficult. They're flagged here because they're the kind of thing that causes hours of debugging if missed.

| # | Item | Effort | When | Why It Matters |
|---|------|--------|------|---------------|
| 1 | **Hooks / Auth Middleware** | ~30-50 lines. One DB query to rewrite. | First story in Auth PRD (Phase 2.5) | `hooks.server.ts` is SvelteKit's "bouncer" — runs before every page. Checks session cookie against DB to identify the user. Currently uses Drizzle. Without this, no page loads, no tests pass, nothing works. |
| 2 | **Shared Server Utilities** | `grep` for Drizzle imports, rewrite the few that touch DB. | Inventory during Phase 2, rewrite in relevant domain PRDs. | Files like `$lib/server/permissions.ts` that multiple pages import. Most are trivial. If missed, coding agents hit missing imports and get stuck. |
| 3 | **Seed Data** | Write Mongoose `.create()` calls for test records. | Phase 3 project setup, before running tests on new app. | New MongoDB starts empty. Tests against empty data pass vacuously (empty array matches any shape). Need realistic records: users, SPUs, cartridges at various lifecycle phases, assays, equipment. |
| 4 | **Deployment Config** | Copy `.env`, set Vercel variables. 10 minutes. | Checklist in Phase 4. | `MONGODB_URI` already exists in `.env`. Just needs to be in Vercel's environment when deploying the new app. |

### Deferred (add later if needed)

| Item | Why Deferred |
|------|-------------|
| **Real-time / WebSocket** | May not exist in the app. Check codebase during Phase 2. Add later if needed. |
| **Third-party integrations** (Box, Particle, Opentrons) | Last domain to rebuild. Requires external credentials and hardware to test. Not blocking anything else. |

---

## Agent Execution Strategy

### How This Gets Run

```
MAIN SESSION (Opus) — lightweight coordinator
│  Stays under 50% context at all times
│  Spawns sub-agents, tracks progress, reports to Jacob
│  Does NOT do heavy file reading or coding itself
│
├── Phase 1 Sub-agent (Opus) — "Build characterization test suite"
│     Reads all routes, writes all tests, verifies green baseline
│     Dies when done, reports results back
│
├── Phase 2 Sub-agent (Opus) — "Extract contract registry"
│     Reads all +page.server.ts and .svelte files
│     Produces CONTRACT-REGISTRY.md
│     Dies when done
│
├── Phase 2.5 Sub-agent (Opus) — "Write PRDs"
│     Reads contracts + tests, writes 11 domain PRDs
│     Dies when done
│
└── Phase 3 Sub-agents (Opus, one per domain, sequential)
      ├── Domain 1: Auth — hooks, sessions, users, roles
      ├── Domain 2: Kanban — projects, tasks, board
      ├── ...
      └── Domain 11: Agent API
      Each: reads PRD + contracts + schema spec, implements, runs tests, commits
```

### Model Configuration

- **All sub-agents:** Opus (`model="opus"` passed explicitly on every spawn)
- **Gateway default stays Sonnet** for background tasks (cron, newsletter, distillation)
- **Main session:** Opus (already configured)

### Token / Context Management

- **Sub-agents are the workhorse.** They spawn fresh (no accumulated history), do focused work, and terminate. This prevents context bloat.
- **Main session stays light.** It coordinates, doesn't read large files or write code.
- **After each phase:** Main session saves progress to daily log, reports to Jacob.
- **Context check:** Agent001 periodically reports session usage (context %, estimated cost) to Jacob.
- **If main session hits 60%:** Flush progress to daily log, suggest `/new`.

### Progress Reporting

After each sub-agent completes:
1. Report to Jacob: what was done, what passed, what's next
2. Update daily log with progress
3. Spawn next sub-agent

Jacob can check in anytime — main session always knows current status.

---

## Risk Mitigation

| Risk | Mitigation |
|------|-----------|
| Tests don't catch a subtle behavior difference | Manual verification in Phase 4 covers critical paths |
| MongoDB query performance differs from Postgres | Indexes defined in schema spec; monitor during Phase 4 |
| Embedded document size exceeds expectations | Schema spec has size warnings (test results, WI images); check during build |
| Agent produces incorrect Mongoose queries | Contract tests catch shape mismatches immediately; fail fast |
| Authentication/session handling differs | Auth is built first (Phase 3, Order 1); everything else depends on it working |
| Copied .svelte files import server-side utilities | Audit imports during project setup; client-only code copies clean, server imports get rewritten |

---

## Estimated Timeline

| Phase | Work | Estimated Duration |
|-------|------|-------------------|
| Phase 1: Test Suite | Crawl routes, write ~315 tests, verify green baseline | 1-2 days |
| Phase 2: Contract Registry | Extract data shapes from all routes | 1 day (parallel with Phase 1) |
| Phase 2.5: PRDs | Write 11 domain PRDs with acceptance criteria from contracts + tests | 1 day |
| Phase 3: Greenfield Build | New project + Mongoose models + ~80 server files + ~67 API handlers | 3-5 days |
| Phase 4: Verification | Automated tests + Jacob's manual check | 1 day |
| **Total** | | **~6-9 days** |

---

## Next Steps

1. **Jacob approves this plan**
2. Agent001 begins Phase 1: check out `dev`, start the app, crawl routes, build the test suite
3. Phase 2 runs in parallel: extract contract registry
4. Phase 2.5: write PRDs from contracts + tests (one per domain, with stories and acceptance criteria)
5. Phase 3: coding agents implement PRDs following Ralph Loop
6. Phase 4 when all domains complete and tests green

---

*This plan was workshopped between Jacob Quick and Agent001 on February 27, 2026. The core insight: define the contracts between UI and server, test them against the working app, then rebuild the server layer to fulfill those same contracts with a new database.*
