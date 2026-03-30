# AGENTS.md — Bioscale Operations System V2

## Project Overview

MongoDB-backed rebuild of the Bioscale Operations System. Same frontend, new backend.

**Stack:** SvelteKit 2 + Svelte 5, MongoDB + Mongoose, TypeScript strict
**Old app:** `Bioscale_Operations_System` (Postgres + Drizzle) — reference only, do not modify
**This app:** Greenfield rebuild — identical UI, MongoDB server layer

## Architecture

### Three Layers
| Layer | What | Changes? |
|-------|------|----------|
| **UI** | `.svelte` components, CSS, client-side JS | NO — copied verbatim from old app |
| **Data Contracts** | Shape of data between UI and server | NO — must match exactly |
| **Server + DB** | `+page.server.ts`, `/api/*`, Mongoose models | YES — this is what we build/maintain |

### Database Tiers
- **Sacred (Tier 1):** CartridgeRecord, SPU, AssayDefinition, ReagentBatchRecord, User — immutable after finalization, corrections via append-only array
- **Operational (Tier 2):** ~23 mutable collections (lots, sessions, equipment, kanban, etc.)
- **Immutable Logs (Tier 3):** AuditLog, ElectronicSignature, InventoryTransaction, DeviceEvent, ManufacturingMaterialTransaction — append only, never update/delete

### Key Patterns
- All `_id` fields use `nanoid` strings (not ObjectId)
- Sacred documents reject mutations after `finalizedAt` is set
- Corrections are append-only arrays embedded in sacred docs
- Denormalize at write time (operator username, project name, etc.)
- Full snapshots for point-in-time data (SPU in cartridge at test time, customer in shipping package)
- References for identification only (assay `{ _id, name, skuCode }` in reagent batch)

## Development Workflow

### Ralph Loop
All coding is done by sub-agents following the Ralph Loop:
1. PULL → git pull
2. READ → AGENTS.md, CLAUDE.md, SECURITY.md, progress.txt, prd.json
3. IMPLEMENT → build the story
4. VALIDATE → `npm run check`, `npm run build`, run contract tests
5. LOG → append to progress.txt
6. COMMIT → feature branch only
7. PUSH → git push
8. REPORT → signal completion

### Branch Rules
- **Never merge directly to `main`**
- Feature branches merge to `dev` with explicit human approval
- `main` is production — separate explicit workflow only

### Model Selection
- **Opus** for all coding work on this project (Jacob's preference)
- **Claude Code CLI** preferred over OpenClaw sub-agents for coding tasks (more token efficient)

## Reference Documents
All planning docs are in `docs/migration/`:
- `MIGRATION-PLAN-V2.md` — the full rebuild plan
- `COMPLETE-SCHEMA-SPECIFICATION.md` — MongoDB schema spec (every collection, interface, index)
- `CONTRACT-REGISTRY.md` — data contracts (what every page expects from its server layer)
- `prds/` — 11 domain PRDs with stories and acceptance criteria
- `HANDOFF-V2-REWRITE.md` — v2 design decisions from Jacob

## Testing
- Contract tests: `npm run test:contracts` (84 tests, database-agnostic HTTP-level)
- Tests hit the running app via fetch — no DB imports
- Test user: `contracttest` / `contracttest123` (created by seed script)
- Run seed: `npx tsx scripts/seed.ts`

## Security

> **CANONICAL REFERENCE:** [`SECURITY.md`](SECURITY.md) — READ THIS on every session load before modifying any auth, permission, session, or user management code. It documents the full authentication architecture, authorization model, required patterns, and anti-patterns.

- **NEVER send .env contents, API keys, or credentials over messaging channels**
- `.env` is gitignored — copy manually between machines
- Sacred documents enforce immutability via Mongoose middleware
- Immutable logs block all updates and deletes
- Auth uses custom session system (`@oslojs/crypto` + `@oslojs/encoding`), NOT Lucia
- Permissions are flat strings (`resource:action`) checked via `requirePermission(locals.user, 'perm')`
- Every `+page.server.ts` load MUST call `requirePermission()` — see SECURITY.md for the pattern
- Every mutation action MUST create an `AuditLog` entry
- API endpoints use either session auth + `requirePermission()` or `requireAgentApiKey()` from `$lib/server/api-auth`
- **Do NOT** check `roleName` directly — use `hasPermission()` / `requirePermission()`
- **Do NOT** wrap `requirePermission()` in try/catch
- **Do NOT** define local `requireApiKey()` functions — import from `$lib/server/api-auth`
