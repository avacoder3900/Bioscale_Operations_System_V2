# INFRA-101 — Knowledge Base (upload to Project knowledge)

Authoritative background for the INFRA-101 onboarding session. Compiled 2026-08-18 from the
live repos. Where two sources disagreed, the code won; known stale docs are listed at the end.
Never treat anything here as containing secret *values* — only names.

---

## 0. The map

### Repos

| Repo | What | Stack | Deploys to |
|---|---|---|---|
| `Bioscale_Operations_System_V2` — **BIMS** | Manufacturing / operations: cartridge production phases, SPU device-history records, inventory, kanban, QMS docs, Opentrons control, computer vision, robot arm, MCP server, Ask BIMS | SvelteKit 2 + Svelte 5, TypeScript strict, Tailwind, Mongoose 9, `@sveltejs/adapter-vercel` (`nodejs22.x`, region `pdx1`, `maxDuration 30`) | Vercel project `bioscale-operations-system-mongodb` (team **brevitest**). Production URL `https://bioscale-operations-system-mongodb.vercel.app`. **Production branch = `master`.** |
| `brevitest-research-v2` — **research** | Lab experiment management: experiments/arms/cartridges, reagent prep (Excel-parsed protocols), analysis of raw optical data, calibrations, exports to Excel/Box, device list + push-assay | SvelteKit 2 + Svelte 5, Mongoose 9, Tailwind 4, `adapter-auto` (no `vercel.json`) | Vercel project `brevitest-research-v2`; branch `main` is production there |
| `brevitest-device` — **device** | Particle firmware (C++/Wiring) for the SPU/reader, plus **the currently deployed Lambda middleware** in `firmware/Middleware reference files/lambda-current-8_18_26/`, plus 18 design docs in `firmware/Docs/`. (`Brevitest-Firmware-v2` is a stale Feb-2026 copy, not a git repo — ignore it.) | C++ (Particle Device OS 6.3.x, platform `msom`); Node 20 ESM Lambda | Particle Cloud (firmware OTA, product version 84); AWS Lambda `us-east-1` behind API Gateway |
| `brevitest-middleware` | Older middleware repo (Auth0 Webtask origins → Lambda). HEAD 2026-03-02, **behind the deployed code**. Contains sibling Lambdas: hipaa/pdf/tokens/jotform-pif (patient PDF → Zoho CRM), and the canonical BCODE opcode table. | Node | AWS Lambda |
| `brevitest-opentrons` | OT-2 protocol Python files (`production_protocols/`), legacy upload/run helpers (`io_http`, `io_ssh_file_based`, `bin/`), SSH key `ot2_ssh_key` | Python 3.10 / Opentrons 7.3.1 | Runs on the robots |
| `brevitest-fill-detection` | Original offline Keras/TensorFlow CNN for cartridge fill good/bad. R&D ancestor of the in-app classifier; no BIMS integration | Python | nowhere (offline) |

### One database
Both web apps **and** the device middleware use the same MongoDB Atlas cluster and database:
`cluster0.vmsozkl.mongodb.net` → db **`bioscale`**. Env var `MONGODB_URI` in every codebase.

### Where code runs
1. **Vercel** — the two SvelteKit apps (serverless functions, Fluid compute). Cannot reach the lab LAN.
2. **AWS Lambda + API Gateway (us-east-1)** — device middleware.
3. **Particle Cloud** — broker between devices and Lambda (webhooks + response topics + OTA firmware).
4. **The lab** — Raspberry Pis inside 3 OT-2 robots, CV capture-station Pis, `arm-pi` (robot arm), the Lab Mac (jump box/workstation), a Windows PC with Zebra Browser Print, Mac mini (agent infra only).
5. **Cloudflare R2** — image storage bucket `brevitest-cv` (presigned uploads / upload worker).
6. **Anthropic cloud** — Claude clients dial into BIMS's MCP server; Ask BIMS calls the Anthropic API.

---

## 1. MongoDB as the single source of truth

### Conventions (both apps)
- **IDs are nanoid strings**, never ObjectId. `generateId()` from `src/lib/server/db/models`. Exceptions by design: `CartridgeRecord._id` and `ReagentInventory._id` are 36-char UUID barcodes; `AssayDefinition._id` is `A` + 7 hex (8 chars, matches firmware `char assay_id[9]`); `Session._id` is the SHA-256 of the raw token; `ManufacturingSettings._id = 'default'` (singleton).
- **Denormalize at write time**: embed `{ _id, username }` for operators, `{ _id, name, color }` for projects, etc.
- **Snapshots for point-in-time data**: the SPU is copied into the cartridge at test time; the customer into a shipping package.
- **References for identification only** where a snapshot would be wrong (assay `{ _id, name, skuCode }` in a reagent batch).
- **Subdocument arrays need `_id: false`** (or an explicit nanoid `_id`) — Mongoose otherwise adds ObjectIds and SvelteKit serialization breaks.
- Always `.lean()` and `JSON.parse(JSON.stringify(x))` before returning from a load function.
- Collection names are snake_case plurals set explicitly (`cartridge_records`, `assay_definitions`, `spus`, `sessions`, `users`, `device_events`, `ot2_bridge_commands`, `cv_inspections`, `capture_stations`, `reagent_catalog`, `reagent_inventory`, `reagent_lots`, `reagent_protocol_templates`, `protocol_definitions`, `protocol_executions`, `permission_shadow_log`…).
- TTL indexes are used aggressively: `device_events` 30 d, `ot2_bridge_commands` 3 d after completion / 7 d after creation, `sessions` at `expiresAt`, `permission_shadow_log` 30 d.
- Connection: `src/lib/server/db/connection.ts` exports `connectDB()`, a lazy singleton cached on `global` (safe across warm serverless invocations). It reads raw `process.env.MONGODB_URI` so `scripts/*.ts` can reuse it. **Forgetting `await connectDB()` is the #1 new-dev bug.**

### The three tiers (BIMS `src/lib/server/db/models/`, middleware in `src/lib/server/db/middleware/`)

| Tier | Rule | Enforced by | Models |
|---|---|---|---|
| **1 Sacred** | Mutable until `finalizedAt` is set; after that no update/delete — fixes go into append-only `corrections[]` | `applySacredMiddleware(schema)`: pre-hooks on `updateOne/updateMany/findOneAndUpdate/findOneAndReplace` read the doc first and throw `Cannot modify a finalized sacred document` if `finalizedAt` is truthy; **all deletes throw unconditionally**. Gaps: does not hook `document.save()`; the pre-read is not atomic. | `CartridgeRecord`, `SPU`, `AssayDefinition`, `ReagentBatchRecord`, `ReagentLot`, `RobotArmRun`; `User` is sacred-by-hand (no `finalizedAt`; `deactivatedAt` instead; deletes throw "deactivate instead"). Grouped with Tier 1 by comment but no middleware: `OpticalTestCartridge`, `CartridgeGroup`, `ReagentProtocolTemplate`. |
| **2 Operational** | Normal mutable data | none | Kanban (`kanban-task/-policy/-template/-counter`), documents/QMS, inventory & receiving, equipment, Opentrons (`opentrons-robot/-protocol/-run-record`, `ot2-bridge-command`, scanner sets, labware, deck offsets), CV (`cv-project/-image/-sample/-inspection`, `capture-station`), robot arm, analytics/SPC, Ask-BIMS telemetry, plus **read-only mirrors of 9 research collections** (`Experiment`, `ReagentCatalog`, `ReagentInventory`, `ProtocolDefinition`, `ProtocolExecution`, `Sample`, `Analyte`, `AnalysisProfile`, `CalibratedAnalysis`). |
| **3 Immutable** | Insert only, ever | `applyImmutableMiddleware(schema)` blocks all six update/delete hooks | `AuditLog`, `ElectronicSignature`, `InventoryTransaction`, `DeviceEvent`, `ManufacturingMaterialTransaction`, `DeviceLog`, `DeviceCrash`, `WebhookLog`, `TemperatureReading` |

**Corrections pattern** (identical `correctionSchema` in every sacred model, `_id: false`):
`{ fieldPath, previousValue, correctedValue, reason, correctedBy {_id, username}, correctedAt, approvedBy }`. You `$push` onto `corrections[]`; you never edit the finalized field. Snippet in `CLAUDE.md`. Gate permission (planned): `sacred:correct`.

**Honest caveat**: `CartridgeRecord.finalizedAt` is never written by any action today, so cartridge finalization is aspirational; `RobotArmRun` is the cleanest live example (webhook stamps `finalizedAt` on terminal events, middleware then blocks further writes).

### The sacred documents, what hangs on them

**`CartridgeRecord`** (`cartridge_records`) — the spine of manufacturing *and* the test record. Phase-structured: one sub-object per lifecycle phase, each with `operator {_id, username}` + `recordedAt`: `backing`, `waxFilling`, `waxQc`, `waxStorage`, `reagentFilling`, `reagentInspection`, `topSeal`, `ovenCure`, `storage`, `qaqcRelease`, `shipping`, `assayLoaded`; then runtime: `testExecution` (embeds a denormalized SPU snapshot with parts/firmware/particleLink), `sample`, `testResult`. Append-only arrays: `photos[]` (R2 keys, `photoType inspection|microscope`, `verdictSummary` mirrored from CV), `notes[]`, `corrections[]`. Device-facing flat fields: `assayId`, `serialNumber`, the whole `assay` embedded (incl. BCODE) so the reader needs nothing else at scan time. Written by the Lambda after a run: `rawData` (decoded spectral payload), `checkpoints`, `status completed|cancelled`. Research-app fields: `analysis`, arm/experiment link, `reagentChain`. Write-once phases: check `phase.recordedAt: { $exists: false }`.
`status` enum today: `backing, wax_filling, wax_filled, wax_qc, wax_ready, wax_rejected, reagent_filling, reagent_filled, sealed, reagent_qc, reagent_ready, reagent_rejected, stored, released, shipped, linked, underway, completed, cancelled, scrapped, voided, packeted, transferred, received`. (`wax_stored` migrated away; `wax_qc` retired-but-kept. See WAX-FLOW / WAX-SIMPLIFY PRDs for why.)

**`SPU`** (`spus`) — the **S**ample **P**rocessing **U**nit, i.e. the reusable reader instrument (a.k.a. Acuity SPU / "the device"). Keyed by unique `udi` + barcode. It is a Device History Record: `parts[]` (lot/serial, replacement chain), `assembly` (work-instruction + every scan), 21 CFR Part 11 `signature` (`dataHash`, ip, meaning), `particleLink { particleSerial, particleDeviceId }` (the Particle module inside), `validation` blocks (magnetometer, thermocouple, lux, spectrophotometer — pending/passed/failed + rawData), `serviceRecords[]`, `attachments[]`, `statusTransitions[]`. Status: `draft → assembling → assembled → validating → validated → released-rnd | released-manufacturing | released-field → deployed → servicing → retired | voided`. Research adds `opticalCalibration.channels.{A,B,C}` (per-channel F3 factors).

**`AssayDefinition`** (`assay_definitions`) — the test recipe: `name/skuCode/duration`, `reagents[]` (well, volume, cost, subComponents), the **BCODE** program (`{deviceParams, code[]}`; research also stores compiled `bcode` Buffer + JS `BCODE` object), `versionHistory[]`, `lockedAt/lockedBy` (gate `assay:lock`), `corrections[]`.

**`ReagentBatchRecord`** — OT-2 reagent-fill runs: `runNumber`, `robot`, `assayType`, `tubeRecords[]`, `cartridgesFilled[]` (deck position, inspection verdict, seal batch, storage), `sealBatches[]`, `qcRelease`. Status enum is mixed-case legacy (`src/lib/server/manufacturing/run-statuses.ts`).
**`ReagentLot`** — rigid conjugation flows (SuperQD P1/P2, Antibody Biotinylation, Bead Mix) driven by `ReagentProtocolTemplate`; lineage via `inputLots[]`.
**`RobotArmRun`** — one arm task/teleop/record/replay session; finalized on terminal event.
**`User`** — `roles[].permissions[]`, `isActive`, `deactivatedAt`; never deleted.

### Shared collections & ownership (BIMS ↔ research-v2)
| Collection | Owner / writer | Notes |
|---|---|---|
| `cartridge_records` | Both + Lambda | BIMS writes manufacturing phases; Lambda writes `rawData`/status at test time; research writes `analysis`, links, `reagentChain`. Research rule: only `rawData`/`reading` prove a device run — `testResult/testExecution` are ops QC. |
| `assay_definitions` | Both | Same 8-char ids the firmware uses. |
| `users`, `sessions`, `roles` | Both | Same login works in both apps. `Research Admin`/`Researcher` roles are research-owned; BIMS ignores permissions from research-owned roles. |
| `cv_images`, `failure_labels` | BIMS owns; research labels | Research `$set`s only tags/QC verdicts. |
| `spus` | BIMS owns; research adds calibration | |
| `reagent_catalog`, `reagent_inventory` | research primary; both write | Vial lineage: `preparedFromExecutionId` (research) XOR `preparedFromReagentLotId` (BIMS). |
| `audit_log` | both append | |
Cross-app HTTP is minimal: research calls BIMS `/api/agent/**` (photo proxy) with `AGENT_API_KEY` + `BIMS_BASE_URL`; BIMS never calls research — it reads research collections directly via read-only mirror models (Ask BIMS).

Docs: `docs/DATA-REFERENCE.md` (concepts authoritative; says "53 collections" — now 100+ models), `docs/migration/COMPLETE-SCHEMA-SPECIFICATION.md`, `docs/REAGENT-UNIFICATION-PRD.md`.

---

## 2. Web apps: SvelteKit on Vercel

### Request lifecycle (BIMS; research is the same shape)
1. Browser → Vercel serverless function (Node 22, `pdx1`).
2. `src/hooks.server.ts` — `sequence(handleAuth, handleFormActionJson)` (+ `applyRoutePolicy` shadow evaluator). `handleAuth` reads cookie `auth-session` → SHA-256 the token → look up `sessions._id` → load user minus `passwordHash` (reject if `!isActive`) → `event.locals.user/session`; renews if within 15 d of the 30-d expiry. Non-public, non-`/api/*` routes redirect to `/login`. `PUBLIC_PATHS = ['/login', '/invite/accept']`.
3. Route file: `+page.server.ts` (`load` + form `actions`), `+layout.server.ts`, or `+server.ts` (API: `GET/POST…`).
4. Server pattern (`CLAUDE.md`, `progress.txt` "Codebase Patterns"): `requirePermission(locals.user, 'x:read')` → `await connectDB()` → Mongoose query with `.select().sort().lean()` → `JSON.parse(JSON.stringify())` → return. Mutations: validate input, write, **create an `AuditLog` row**, redirect/return.
5. Svelte 5 page renders with the returned data. `.svelte` files and `src/lib/components/` are editable (freeze lifted 2026-06-19); `src/lib/stores/`, `src/lib/utils/`, `src/app.html`, `src/app.css`, `static/` are off-limits.
6. API endpoints for machines use `requireAgentApiKey(request)` from `$lib/server/api-auth` (accepts `x-api-key`, `x-agent-api-key`, or `Authorization: Bearer`; timing-safe compare vs `AGENT_API_KEY`). Never define a local `requireApiKey()`.

### Permissions
- Flat strings `resource:action` on `user.roles[].permissions[]`. `hasPermission()` boolean, `requirePermission()` throws 403. Never check `roleName` directly; never wrap `requirePermission` in try/catch.
- Registry (single source of truth): `src/lib/server/permissions-registry.ts`. Model (PERM-00): humans = admin / not-admin via membership perms `bims` (BIMS) / `research` (research-v2); six admin gates: `document:approve`, `kanban:replenish`, `manufacturing:release`, `sacred:correct`, `assay:lock`, `admin:full`. `admin:full` is a wildcard **only for holders of `bims`** and never implies `research`. Permissions from research-owned roles count for nothing in BIMS.
- Deny-by-default route policy (`route-policy.ts`) runs in **shadow mode** (logs to `permission_shadow_log`, blocks nothing) until `PERMISSIONS_ENFORCE=true` (PERM-04 flip; then the sweep). Report: `scripts/report-shadow-denials.ts`.
- Bots (MCP/agent key) are permanent non-admins; write tools require a human `actor` (attribution, not authority); devices use per-fleet keys.
- Canonical docs: `SECURITY.md` (auth; its permission *lists* are stale), `docs/prds/PERM-00…06`.

### Cron (BIMS `vercel.json`, all `Authorization: Bearer CRON_SECRET`)
`/api/cron/mocreo` 09:00, `/mocreo-heartbeat` 10:00, `/daily-digest` 08:00, `/cartridge-cleanup-reminder` 21:30, `/bims-anomaly-scan` 07:00 (daily), `/archive-done-tasks` Mon 04:00. Research has no cron.

### Deploy rules (mandatory, `CLAUDE.md`)
- Commit → `git push origin <branch>` → Vercel GitHub integration builds. Branch push = **preview**; **`master` = production** for BIMS (`main` there is abandoned, 386 commits behind — never push releases to it). Research: `main` = production.
- **Never** run `vercel deploy` / `vercel deploy --prod` from a laptop (untraceable deployments happened). If the integration isn't firing, fix that.
- Every deployment gets a `progress.txt` entry: URL, branch @ short SHA, retrieval command, purpose. `progress.txt` heartbeat every ≤1 h of active work.
- Validation: `npm run check` (svelte-check; compare error count to baseline), `npm run build`, `npm run test:contracts` (HTTP-level contract tests against a running app; test user `contracttest`), `npm run test:unit`. Local dev: `npm run dev` (BIMS on `localhost:5173`; research on HTTPS `localhost:5176` via mkcert). Gotcha: plain `npm run dev` may not load `.env` on the Lab Mac — `set -a; source .env; set +a; npm run dev`.

---

## 3. Environment variables

**What**: configuration and secrets kept out of code, read at runtime. **Where they live**:
1. **Locally**: `.env` at repo root (gitignored). `.env.example` exists in BIMS but is incomplete (missing ~10 live vars). Copied by hand between machines / worktrees; **never sent over chat/messaging**. App code reads `import { env } from '$env/dynamic/private'` (~30 files); `connection.ts`, `opentrons/proxy.ts`, and all `scripts/*.ts` use `process.env` + `dotenv.config()`. Research uses `$env/static/private` for `MONGODB_URI`.
2. **Vercel**: Project → Settings → Environment Variables. Set for **Production and Preview** (Pis get 401 on preview deploys otherwise), then redeploy. No `vercel env pull` workflow is in use. `process.env.VERCEL` is set on Vercel (used by `OT2_TRANSPORT=auto`).
3. **AWS Lambda** function configuration (middleware): `MONGODB_URI`, `MONGODB_DB` (default `bioscale`), `COUCHDB_BASEURL`, `COUCHDB_BASE64_CREDENTIAL`, `BIMS_API_URL`, `BIMS_API_KEY`, `PARTICLE_URL`, `PARTICLE_ACCESS_TOKEN`, `MAGNET_MINIMUM_Z_GAUSS`, `TEMPERATURE_MIN`. (`brevitest-tokens` Lambda rewrites its own env to persist refreshed Zoho tokens.)
4. **Particle Console**: webhook definitions (target URL = Lambda API Gateway endpoint), product/firmware, `PARTICLE_ACCESS_TOKEN` issued here.
5. **On the Pis**: `/data/ot2-bridge/.env` on each OT-2 (`BIMS_BASE_URL`, `BIMS_AGENT_API_KEY`, `BRIDGE_DEVICE_ID`, `SCANNER_DEVICE_ID`, `SCANNER_SERIAL_PORT`, `OT2_BASE_URL=http://localhost:31950`); `/etc/bims/station.env` on CV stations (`STATION_AGENT_KEY`, hostname, BIMS URL); arm-pi FastAPI config (`ROBOT_ARM_API_KEY`).
Rotation therefore touches several homes; a shared key like `AGENT_API_KEY` is being replaced by per-fleet keys (`SCANNER_FLEET_KEY`, `OT2_BRIDGE_KEY`, `MOCREO_FLEET_KEY`, `PARTICLE_WEBHOOK_KEY`, `STATION_AGENT_KEY`, each with a `_STRICT` flag; until strict, the shared key still works).

**BIMS env-var families**
| Family | Names | Purpose |
|---|---|---|
| Database | `MONGODB_URI` | Atlas, db `bioscale` |
| Machine auth | `AGENT_API_KEY`, `MCP_API_KEY` (falls back to agent key), `CRON_SECRET`, fleet keys above | `/api/agent/**`, `/api/mcp`, `/api/cron/*`, devices |
| App config | `BIMS_BASE_URL`, `PERMISSIONS_ENFORCE`, `ADMIN_OVERRIDE_PASSWORD`, `OT_OPERATOR_PASSWORD`, `TRAINING_UNLOCK_PASSWORD` | links/emails, PERM-04 flip, UI gates |
| AI | `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `ASK_BIMS_DAILY_CAP_*_USD`, `ASK_BIMS_MAX_COST_OPUS`, `ASK_BIMS_DISABLED_TOOLS`, `ASK_BIMS_PII_REDACTION_ENABLED` | Ask BIMS + Whisper, spend caps, kill switch |
| Storage | `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET_NAME`, `R2_PUBLIC_URL`, `R2_WORKER_URL`, `R2_UPLOAD_SECRET`; `BOX_CLIENT_ID/SECRET/REDIRECT_URI/ROOT_FOLDER_ID` | Cloudflare R2 images; Box documents |
| Comms | `RESEND_API_KEY`, `RESEND_FROM_ADDRESS` | email |
| Lab hardware | `ROBOT_ARM_BASE_URL`, `ROBOT_ARM_API_KEY`, `OT2_TRANSPORT`, `OPENTRONS_LABWARE_DIR`, `BROWSER_PRINT_URL`, `MOCREO_EMAIL/PASSWORD/CONFIG_PATH/INTERVAL_MS` | arm, OT-2 transport, labware, Zebra, temp sensors |
| CV legacy/optional | `CV_WORKER_URL`, `CV_INFER_URL`, `ML_INFER_SECRET`, `CV_API_URL`, `CV_API_KEY`, `GITHUB_DISPATCH_TOKEN`, `GITHUB_REPO`, `TRAIN_CALLBACK_SECRET`, `OCR_API_URL`, `OCR_API_KEY` | external inference (unused now), GH-Actions training runner, OCR |
| Script flags | `APPLY`, `DEPLOY_APPLY`, `PRUNE_APPLY`, `ROBOT`, `ROBOT_HOST`, `PERM06_SWEEP_DONE`, … | dry-run/target switches for `scripts/*.ts` |

**Research env**: `MONGODB_URI`, `AGENT_API_KEY`, `BIMS_BASE_URL` (Vercel-only), `PARTICLE_ACCESS_TOKEN`, `PARTICLE_PRODUCT_ID`, `BOX_CLIENT_ID/SECRET/ENTERPRISE_ID/USER_ID/ROOT_FOLDER_ID`, legacy `COUCHDB_*`, vestigial `AUTH_SECRET`, `AWS_*`, `FEDEX_*`.

---

## 4. The device path

### Hardware / firmware (`brevitest-device/firmware/`)
- Reader = SPU. Compute module: **Particle M-SoM** (`project.properties: target.platform=msom`, Device OS 6.3.x), `PRODUCT_VERSION(84)`, `SYSTEM_MODE(AUTOMATIC)`, `SYSTEM_THREAD(ENABLED)`. Lineage: Photon/Core → Electron (v20) → Boron (v21–22) → M-SoM (v23+). `Electron ID list.txt` = 6 legacy Electron device IDs, unused.
- Language **C++ / Wiring**: `src/brevitest-firmware.ino` (~6,100 lines: setup/loop, BCODE interpreter `process_BCODE()`, cloud pub/sub, serial console, motors, heater, barcode, BLE) + `.h` (pins, `#define`s, structs). `brevitest-firmware.cpp` is generated — don't edit. `DeviceState.{h,cpp}` = formal state machine (11 modes, 50-entry transition history). `DFRobot_AS7341.*` = 11-channel spectral sensor driver (F1–F8, Clear, NIR).
- Subsystems: stepper stage (A5985), 3 spectrophotometers muxed by PCA9536 (channels A/B/C), 405 nm laser + LEDs, heater + thermistor, buzzer, cartridge detector, barcode scanner (5 barcode types), LittleFS dirs `/assay`, `/cache`, `/log`. Separate Particle projects: `magnetometer/` (Argon, BLE peripheral for 5-well magnet QC), `tip_locator/`.
- Device identity: `System.deviceID()` (24-hex Particle id) — retried because it can be empty early (`Docs/DEVICE_ID_EMPTY_BUG.md`). Linked to the SPU record via `spus.particleLink`.

### Cloud interface — 100 % Particle pub/sub, no HTTP in firmware
- **Published events**: `validate-cartridge` `{uuid}`, `load-assay` `{assay_id}`, `reset-cartridge` `{uuid}`, `upload-test` (BINARY `BrevitestTestRecord` from `/cache/<cartridgeId>`), `device-log` (BINARY rotated log with metadata header). Plus ~25 diagnostic publishes (`device_state`, `state_history`, …).
- **Subscription**: one prefix `Particle.subscribe(deviceID + "/hook-response/", response_webhook)` dispatching to per-event handlers (this replaced four subscriptions after the validation-timeout investigation; `VALIDATION_TIMEOUT_MS 45000`).
- **`Particle.function`s**: `load_assay`, `verify_assay`, `set_wifi_credentials`, `run_test`, `reset_cartridge`, `get_state`, `get_trans_count`, `get_history`, `clear_history`, `force_state`, `get_barcode_hist`, `upload_test`, `upload_log`. **`Particle.variable`s**: `temperature`, `magnet_validation`.
- Research's `POST /api/push-assay` calls Particle `POST /v1/devices/{id}/load_assay|verify_assay` for every research-assigned SPU; its `/devices` page merges `spus` with the live Particle product device list.

### An assay, to the firmware
`struct BrevitestAssay { char id[9]; int duration; uint16_t BCODE_length; char BCODE[5000]; }`. BCODE = compact bytecode (`,` args, `:` attrs, `|` items, `#` end); opcodes `0 START TEST, 1 DELAY, 2 MOVE MICRONS, 3 OSCILLATE STAGE, 4 BUZZ, 10–15 sensor reads, 17 OPTIMIZED SCAN, 20 REPEAT, FINISH TEST` (table in `brevitest-middleware/brevitest-production/index.js`). **Downloaded once, cached on flash**: `load-assay` → Lambda compiles BCODE from `assay_definitions` → response chunked at 512 B → reassembled, CRC-checked, saved to `/assay/<assayId>`. At test time `validate-cartridge` returns only `{cartridgeId, assayId, checksum}`; missing/mismatched cached assay ⇒ cartridge INVALID.

### Test-result payload
`BrevitestTestRecord`, **9,668 bytes**, packed LE: `'J'` format code, `cartridge_id[37]`, `assay_id[9]`, `start_time u32`, `duration u16`, `astep u16`, `atime u8`, `again u8`, `number_of_readings u16`, `baseline_scans u16`, `test_scans u16`, `checksum u32` @64, then `reading[300]` @68, each 32 B: `{number, channel, position, temperature, laser_output, msec, f1..f8, clear, nir}`. Particle base64-wraps it; Lambda's `parseByteArray()` mirrors the struct.

### Middleware (deployed: `brevitest-device/firmware/Middleware reference files/lambda-current-8_18_26/`)
- AWS Lambda (Node ≥20 ESM) behind API Gateway `us-east-1`; endpoint documented in `firmware/Docs/PARTICLE_WEBHOOK_REFERENCE.md` (`…/v1/particle-multiplex-middleware`). All five Particle webhooks point at the same URL; body `{event_id, event, data, device_id, product_id, fw_version, published_at}`.
- Files: `index.mjs` (handlers), `db-adapter.mjs` (**MongoDB first** — `cartridge_records`, `assay_definitions`, `devices`, `users`, `logs`, `experiments`, `sites` — **CouchDB fallback** — legacy per-site DBs `admin/development/research`), `evaluate.mjs` (clinical result: runs the assay's own JS `functions.calculation.code` with helpers in `utilities.mjs`), `unmix_ratio.mjs` (BCODE-17 weighted least-squares unmixing of AS7341 F2–F8 vs a 3-column basis; ratio r = a630/a480; `ESTIMATOR_VERSION` stamped on results).
- Handlers: `load-assay` → `{status, assayId, bcode, duration, checksum}`; `validate-cartridge` → `{SUCCESS, cartridgeId, assayId, checksum}` or `{FAILURE, errorMessage}` ("already used", "expired", "not linked or underway"), sets status `underway`; `upload-test` → decodes, writes `rawData`, `status completed` (or `cancelled` if 0 readings), `checkpoints`, evaluates result (skipped for `siteId === 'research'`), idempotent on repeat; `reset-cartridge` → clears `rawData`, back to `linked`; `validate-magnets`; `test-event`.
- Response path: `send_response()` → Particle topic `{DEVICE_ID}/hook-response/{EVENT_NAME}`, chunked 512 B (with a deliberate pad when length % 512 == 0).
- Result is computed **in the middleware, not on the device**; the device uploads raw counts only. **There is no separate test document — the cartridge record is the test record.**
- Logging path: Lambda also POSTs to **BIMS** (`BIMS_API_URL` + `BIMS_API_KEY`) `/api/device/logs`, `/api/device/crashes`, `/api/device/webhook-logs`, `/api/device/events`. BIMS also has `POST /api/particle/webhook` (requires `AGENT_API_KEY`) mapping `bioscale/validate|load_assay|upload|reset|error` events into immutable `DeviceEvent`s (30-d TTL). Related models: `ParticleDevice`, `FirmwareDevice`, `DeviceLog`, `DeviceCrash`, `WebhookLog`; UI `/particle/settings`, `/api/device/webhook-logs`.
- **Unified timeline** (`docs/BIMS-UNIFIED-TIMELINE-SPEC.md`): one chronological view per device merging `device_logs`, `webhook_logs`, `device_crashes`, `device_events`; firmware `ms`-since-boot converted with `bootTime + ms` (fallback `uploadedAt - lastLine.ms + line.ms`), normalized to `{timestamp, source, data}`.
- Sibling Lambdas (`brevitest-middleware`): `brevitest-hipaa`/`brevitest-pdf` (patient PDF → Zoho CRM), `brevitest-tokens` (Zoho OAuth refresh), `brevitest-jotform-pif` (intake form → PDF/QR → Zoho + DynamoDB), archived Crelio LIS integration.
- Known-defect writeups worth reading first: `Docs/LOAD_ASSAY_INVESTIGATION.md` (~50 % load failures from a shared global event object), `VALIDATION_TIMEOUT_FIX_PLAN.md`, `IDEMPOTENCY_IMPLEMENTATION_GUIDE.md`, `MAGNETOMETER_SYSTEM_OVERVIEW.md`, `STATE_MANAGEMENT_GUIDE.md`, `COMPREHENSIVE_LOGGING_PLAN.md`.

---

## 5. Lab hardware

### The governing rule
**Vercel cannot reach the lab LAN, and nothing in the lab is exposed inbound.** Three control-plane patterns exist:
1. **Device polls cloud** (OT-2 command bridge) — outbound long-poll queue. Jacob's standing rule for BIMS IoT devices: control plane = device polls BIMS; heavy realtime data (video) = direct browser↔device on LAN/tailnet with short-lived BIMS-minted tokens.
2. **Browser talks to device over the tailnet** (CV capture stations; planned for OT-2 interactive verbs) — cloud stays the system of record.
3. **Cloud talks to device** (robot arm via Tailscale Funnel + API key; arm calls back with a webhook). Explicitly slated to migrate toward pattern 1 eventually.

### OT-2 liquid handlers (3): B07 (`hidden-leaf.local`), R04 (`OT2CEP20210817R04.local`), B14 (`muddy-water.local`)
- Each does wax fill or reagent fill depending on the loaded protocol (`brevitest-opentrons/production_protocols/`; BIMS classifies uploads by filename `wax*` / `reagent*`; BIMS copies in `protocols/Wax_Filling_GEN7_Cartridge.py`, `Reagent_Filling_GEN7.py`).
- Inside each: **Raspberry Pi 3B+**, Opentrons Buildroot OS, `robot-server` on **:31950 (HTTP, no auth, needs `Opentrons-Version` header)**, root SSH with `ot2_ssh_key`, persistent storage only under `/data`. USB serial **gantry barcode scanner** on each robot (why an on-robot component is unavoidable).
- Legacy paths (`brevitest-opentrons`): `io_http/` (multipart POST `/protocols`, `POST /runs/{id}/actions play`), `io_ssh_file_based/` + `bin/run.sh` (scp + `opentrons_execute` + file-based command IPC — unfinished PoC).
- **Command bridge (production today)** — PRDs `docs/prds/OT2-BRIDGE-1/2/3`, daemon `scripts/ot2-bridge.py` (systemd `ot2-bridge.service`, `/data/ot2-bridge/`), deploy guide `scripts/OT2-BRIDGE-DEPLOYMENT.md`, runbook `docs/LAB-MAC-RUNBOOK-OT2-BRIDGE.md`:
  1. BIMS server code calls `robotFetch()` (`src/lib/server/opentrons/proxy.ts`). `OT2_TRANSPORT=direct|bridge|auto` (`auto` = bridge when `process.env.VERCEL`, else direct to `http://<ip>:31950`). ~49 call sites unchanged.
  2. Bridge mode inserts an `Ot2BridgeCommand` (`ot2_bridge_commands`): `deviceId` (`ot2-<slot>-bridge`), `kind` ∈ `http | sweep | deck_scan | upload_protocol | restart_robot_server | auto_resume_run | calibrate_tip`, `request {method,path,body}`/`payload`, `status pending`, `ttlMs` 45 s. `minimize:false` on the schema is load-bearing (labware defs need empty objects preserved).
  3. Daemon long-polls `POST /api/agent/ot2/poll {deviceId, waitMs}` (server holds up to 20 s, re-checks every 250 ms, route `maxDuration 60`; daemon `POLL_WAIT_MS 18000`), atomically claims oldest pending (`findOneAndUpdate pending→claimed`), executes (`http` → relay to localhost:31950; `sweep`/`deck_scan` → on-robot gantry-scanner choreography), POSTs `/api/agent/ot2/commands/[id]/result` (+ `/progress`, which echoes `pauseRequested/cancelRequested`). Heartbeat every 10 s via `/api/agent/scanner/event` with local `/health`. Auth: `x-agent-api-key` (`AGENT_API_KEY` / `OT2_BRIDGE_KEY`).
  4. BIMS polls the command doc every 100 ms up to 30 s and returns a real `Response`. Cost: 1–2 s per interactive verb; jog 0.5–1.5 s/step. Not bridged: protocol upload/deploy multipart to the `opentrons-clone` maintenance stack (localhost only).
- **Lab Mac** = jump box/workstation: Opentrons App, SSH key, scp deploys of daemon + `.env` + unit, local `npm run dev` for snappy jog/teach and localhost-only paths. Not a server (sleeps). Gotcha: bridge `.env` must point `BIMS_BASE_URL` at the Vercel URL, not the Mac's LAN IP.
- **Tailscale plan** (`docs/prds/OT2-TAILNET-0-PLAN.md`, `-1-PI-PROVISIONING.md`, `-2-DIRECT-CONTROL.md`; approved 2026-08-17, not yet built — `OpentronsRobot.directUrl` doesn't exist yet): static Tailscale under `/data/tailscale`, `tailscaled --tun=userspace-networking`, `tailscale up --hostname=ot2-b07 --advertise-tags=tag:ot2 --ssh`, `tailscale serve --bg --https=443 http://localhost:31950`. **Hybrid transport**: browser→robot direct over HTTPS for pause/resume/cancel/status/jog/health with queue fallback; Start Run + all durable records stay on the queue (new `POST /api/opentrons-lab/robots/[id]/runs/[rid]/record`). **Auth = the tailnet** (ACL `tag:lab-workstation → tag:ot2:443,22`, no Funnel). Rollout B07 → R04 → B14. `LAB-GATEWAY-1-DEFERRED.md`: an always-on lab gateway (relay for all robots + Zebra ZT230 print queue on TCP 9100) was deferred because the gantry scanner is USB-per-robot and the Lab Mac shouldn't host production services; revisit for unattended printing / a 4th robot.

### Computer vision capture stations
- Hardware: Raspberry Pi (4/5 depending on doc), USB UVC camera, Waveshare USB-HID barcode scanner, optional 365 nm UV LED ring, powered hub (`docs/prds/PI-CAPTURE-STATION.md`, `-BOM.md`, `docs/PI-SETUP-WIFI.md`). Hostnames `cap-pi-N`.
- Software: `services/bims-capture-agent/` (`agent.py`, aiohttp **:8765**, aiortc WebRTC, evdev scanner, gpiozero LED), systemd `bims-capture-agent.service`, env `/etc/bims/station.env`, provisioning `RUNBOOK.md` (Tailscale + `tailscale serve --bg --https=443 http://localhost:8765`).
- Comms: **Pi → BIMS push** — `/api/cv/stations/register`, `/heartbeat` (30 s; stale after 90 s), `/sweep`, `/api/cv/capture-ingest` (multipart JPEG + QR + phase; QR must match an existing `CartridgeRecord`), header `x-station-agent-key` = `STATION_AGENT_KEY` (fail-closed). **Browser → Pi direct over the tailnet** (`wss://<pi>.<tailnet>.ts.net/ws?token=…`, WebRTC video) using a short-lived HS256 JWT signed with the station's per-station `jwtSecret` in `CaptureStation`; the browser must be on the tailnet; the Pi never touches Mongo.
- Model `CaptureStation` (`capture_stations`): `hostname` unique, `health {cameraOk, scannerOk, ledOk, uptimeS}`, `capabilities {camera, scanner, led, robotArm, sequence}`, `mode free|assigned`, `assignedPhase`, `currentOperator`, `jwtSecret`.
- Images → **Cloudflare R2** (`brevitest-cv`) via presigned URLs (`/api/cv/images/presign`, `/record`) or `services/r2-upload-worker/`.
- **Inference runs in-process on Vercel**: `src/lib/server/services/cv-bridge.ts` + `cv-classifier.ts` (sharp → 224×224 → 156-dim colour/spatial embedding `cv-color-spatial-v1` → z-score → logistic regression; `embedImage` is the swap point for a future ONNX CNN). `services/cv-worker/` (FastAPI PaDiM/ONNX, Fly.io) is legacy. Heavier training can dispatch to an ephemeral GitHub Actions runner (`repository_dispatch`, callback `TRAIN_CALLBACK_SECRET`).
- Records: `CvImage` (`qcLabel approved|rejected`, `embedding`, `view top|bottom`), `CvProject` (a project *is* a model: immutable `trainedModels[]`, `activeModelVersion`, `shadowModelVersion`, `deployAtPhases`, verify gate min holdout 10 / balanced accuracy ≥ 0.8), `CvInspection` (`status queued|running|completed|failed`, `result pass|fail`, `confidenceScore`, `defects[]`, `modelVersion`, `isShadow`, `phase`, `humanLabel` ground truth). Phase selects the model (`runPhaseInference`, `src/lib/server/cv/run-inference.ts`). Human verdict endpoints `/api/cv/wax-verdict`, `/api/cv/reagent-verdict`. Operator pages `/manufacturing/cart-mfg/wax-inspect`, `wax-reject`, `reagent-inspect`. Non-shadow verdicts mirror a `verdictSummary` onto `CartridgeRecord.photos[]`. Research labels the same `cv_images` (`/api/cartridge-photos/[imageId]/tags|qc`).
- `brevitest-fill-detection` = the original offline Keras CNN (good/bad folders, `.keras` models); no serving path.

### Robot arm
- **SO-ARM101** on Pi `arm-pi`, FastAPI/uvicorn **:8000**, exposed via **Tailscale Funnel** `https://arm-pi.tailf65a70.ts.net` (public HTTPS). BIMS → arm: `src/lib/server/robot-arm-client.ts` (`ROBOT_ARM_BASE_URL`, header `x-api-key: ROBOT_ARM_API_KEY`, 5 s timeout): `POST /teleop/start`, `/record/start`, `/replay/start`, `/sessions/stop`, `GET /sessions/active`, tasks `cartridge_pick_and_place_relay`, `xyz_calibration`. Arm → BIMS: `POST /api/robot-arm/webhook {run_id, event}` with `x-agent-api-key` → upsert sacred `RobotArmRun`, terminal events stamp `finalizedAt`.
- Models `RobotArm`, `RobotArmServo`, `RobotArmRun`, `RobotArmDataset`; UI `/manufacturing/cart-mfg/robot-arm/control`; PRDs `ARM-01`, `ROBOTARM-01`; runbook `docs/runbooks/robot-arm-deck-calibration.md`; north star `docs/robot-arm-wax-filling-vision.md`. Two divergent server copies exist (vendored `services/robot-arm/` vs the Pi's standalone repo; the Pi runs the standalone one).

### Other lab I/O
- Barcode surfaces: OT-2 gantry scanner (serial, owned by `ot2-bridge.py`; `OpentronsScannerPositionSet`, `OpentronsScannerSweepRun`, `ScannerTrigger/ScannerEvent`), CV-station HID scanner (evdev → `/ws`), browser wedge / jsQR. `docs/scanner-automation-plan.md`.
- Label printing: UUID-v4 cartridge barcodes minted at `/manufacturing/print-barcodes/zebra`, ZPL in `src/lib/zebra/cartridge-label-zpl.ts`, sent to a **Zebra ZT230** through Zebra Browser Print on `localhost:9100/9101` (`BROWSER_PRINT_URL`); `BarcodeSheetBatch` reserve→confirm→expiry. `docs/ZEBRA-ZT230-BARCODE-PRINTING.md`.
- Temperature: Mocreo cloud (`api.sync-sign.com/v2`) pulled by cron → immutable `TemperatureReading` + `TemperatureAlert`.
- Mac mini (`agent001`) runs agent infrastructure (Claude Code sandbox, launchd "Ducky" cron agent, Telegram relay); nothing in the web apps depends on it (`brevitest-research-v2/mac-mini-setup-guide.md`).

---

## 6. Agents talking to BIMS: MCP server, agent API, Ask BIMS

- **Agent API** (`src/routes/api/agent/**`): key-authed REST for non-humans; namespaces `ot2`, `scanner`, `cartridge`, `inventory`, `validation`, `test-results`, `operations`, `approvals`, `messages`, `query`, `schema`, `export`, `system`, `dependencies`, `health`, `ask`, `transcribe`; `GET /api/agent?action=health|schema`.
- **MCP server** (`docs/MCP-SERVER.md`, `src/routes/api/mcp/+server.ts`, `src/routes/api/mcp/k/[key]/+server.ts`, `src/lib/server/mcp/bims-mcp.ts`, `auth.ts`): remote **Streamable-HTTP** MCP at `https://<bims>/api/mcp`, `@modelcontextprotocol/server` `createMcpHandler`, **stateless per request** (Vercel-safe). Lives inside the SvelteKit app because Anthropic's custom connectors dial in from the internet (a localhost prototype `services/bims-mcp` stalled for that reason). ~30 tools (v3.0.0): every tool is a **thin wrapper calling `/api/agent/**` internally via `event.fetch` + `AGENT_API_KEY`** — audit logging and allowlists live in one place. Read tools (`list_collections`, `operations_summary/dashboard/alerts`, `inventory_overview`, `get_spu_status`, `kanban_board_snapshot`, `get_cartridge_photos`, saved queries…) plus **kanban write tools** (the priority surface, KB2-09/18). Auth `requireMcpKey`: constant-time compare vs `MCP_API_KEY` (fallback `AGENT_API_KEY`); accepts `Authorization: Bearer`, `x-api-key`, `?key=`; the path-key route `/api/mcp/k/<key>` exists for URL-only clients (Claude custom connectors don't forward `?key=`; put the key in the connector dialog's Request headers instead). Connected to Jacob's Claude Desktop since 2026-07-30.
- **Machine rules** (PERM-05, `src/lib/server/machine-actor.ts`, `fleet-keys.ts`): bots are permanent non-admins (kanban replenish/demote/ready-reorder refuse via MCP); 23 write tools require a validated `actor` (the human's name; server replies "ask the person their name" if missing; one chat = one actor; attribution not authority); dual-identity audit logging (`keyIdentity` + actor); devices get per-fleet keys and carry no permissions.
- **Ask BIMS** (`src/lib/server/ask-bims.ts`, `/api/agent/ask`, `/transcribe`): Claude inside the app; **read-only in both apps' collections** (redirects mutation requests to the owning page); Haiku/Sonnet/Opus with server-enforced daily USD caps; Whisper voice; tool kill-switch env.
- Follow-ups on record: rotate `MCP_API_KEY` (a value leaked in screenshots), remove `/api/mcp/health` diagnostic (already 404 in prod), OAuth per-user identity later.

---

## 7. How we build: agentic coding and the Ralph loop

- **Ralph loop** (`AGENTS.md`, `docs/ralph-checklist.md`, `CLAUDE.md`): PULL (`git pull origin <feature-branch>`) → READ (`AGENTS.md`, `CLAUDE.md`, `SECURITY.md`, `progress.txt` — Codebase Patterns section first — and the story/PRD) → IMPLEMENT (follow standards; reuse patterns; no dead code; auth + audit) → VALIDATE (`npm run check`, `npm run build`, `npm run test:contracts`/`test:unit`, browser check for UI) → LOG (append `progress.txt` in the established narrative style; update Codebase Patterns if a new reusable pattern emerged) → COMMIT (feature branch only, `feat: … / fix: …`, `Co-Authored-By: Claude`) → PUSH → REPORT (blockers, dependencies, next steps).
- **The docs are the operating system**: `CLAUDE.md` (standards, mandatory deploy + progress-log + deployment-log rules, DO-NOT-MODIFY list, canonical snippets), `AGENTS.md` (architecture in one page, workflow), `SECURITY.md` (auth patterns; read before touching auth), `docs/DATA-REFERENCE.md`, `docs/migration/*` (schema spec, contract registry, original 11 domain PRDs), `docs/prds/*` (**121 PRDs**, one per feature, named by family and number: `KB2-00..18` kanban v2, `PERM-00..06` permissions, `OT2-BRIDGE-1..3`, `OT2-TAILNET-0..2`, `CV-*`, `CALIB-*`, `WAX-FLOW-*`/`WAX-SIMPLIFY-*`, `ARM-01`, `PI-CAPTURE-STATION`; each has Date/Owner/Status/Parent, Goal, Facts, Steps, Acceptance), `docs/runbooks/*`, `docs/*-handoff*.md` (session handoffs), `progress.txt` (running journal, newest at bottom, mandatory heartbeat ≤ 1 h and per-deployment entries).
- **Branching**: feature branches (`feat/…`, `fix/…`, `jq/…`, `ralph/…`); parallel workstreams in **git worktrees** (`docs/worktree-commands.md`; sibling folders like `…_V2-jq-barcode-scanning`); `.env` copied by hand into each worktree. Merge to production trunk only with explicit human approval. BIMS trunk = `master`; research trunk = `main`. Note the stale `AGENTS.md` lines about `dev`/`main` (see §9).
- **PRD-first**: write/approve the PRD, then implement; contract test before implementation (research CLAUDE.md); keep stories one-context-window sized; sub-agents can run stories in parallel worktrees.
- **Memory & handoffs**: Claude Code keeps a memory index per project; session handoff docs in `docs/`; the next session (human or agent) should be able to pick up from `progress.txt` + the PRD alone.
- **Model/tooling preferences**: Claude Code CLI for coding (token-efficient); Opus-class models for coding work; MCP connector for conversational ops.
- **Tests**: BIMS `npm run test:contracts` (84 HTTP-level tests, need running app + seeded `contracttest` user via `npx tsx scripts/seed.ts`), `npm run test:unit` (Vitest, e.g. permission matrix); research: contract tests + Playwright.
- **First-week checklist**: clone the three repos (+ `brevitest-opentrons` if touching robots); get `.env` from Jacob in person; `npm install`, `npm run dev`; read `CLAUDE.md`, `AGENTS.md`, `SECURITY.md`, `docs/DATA-REFERENCE.md`, `docs/prds/PERM-00`, `docs/prds/OT2-TAILNET-0-PLAN.md`; run `npm run check` and note the baseline error count; browse Atlas (read-only) to see `cartridge_records`; connect Claude Desktop to `/api/mcp`; pick a small open PRD; make first PR to a feature branch, watch the Vercel preview build, log it in `progress.txt`.

---

## 8. Glossary
- **BIMS** — Bioscale Operations System V2 (manufacturing/ops app). **SPU** — Sample Processing Unit, the reader instrument. **Cartridge** — single-use test consumable, UUID barcode. **Assay** — test recipe (reagents + BCODE program). **BCODE** — device bytecode program. **AS7341** — 11-channel spectral sensor. **M-SoM** — Particle system-on-module in the SPU. **Particle** — IoT cloud/broker for the devices. **Lambda / middleware** — AWS function bridging Particle ↔ Mongo. **Sacred** — Tier-1 immutable-after-finalization document. **Corrections** — append-only fix log on sacred docs. **DHR** — Device History Record (the SPU doc). **OT-2** — Opentrons pipetting robot. **Bridge** — the outbound-poll command queue for OT-2s. **Tailnet** — our Tailscale private network. **Funnel** — Tailscale public exposure (arm only). **CV** — computer vision (in research code `cv` usually means coefficient of variation!). **R2** — Cloudflare object storage. **MCP** — Model Context Protocol server at `/api/mcp`. **Ask BIMS** — in-app Claude assistant. **Ralph loop** — our agentic coding protocol. **PRD** — one-feature spec in `docs/prds/`. **KB2** — kanban v2. **PERM** — permissions rewrite.

## 9. Known stale / inconsistent docs (say so if asked)
- `AGENTS.md`/`docs/worktree-commands.md`/`docs/ralph-checklist.md` still reference `dev`/`main`, Postgres `schema.ts`, `db:push` — the real BIMS trunk is `master` and the DB is Mongo. Read them for the *process*, not the branch names.
- `CLAUDE.md`, `DATA-REFERENCE.md`, `AGENTS.md` say "53 models / ~23 collections" — there are 100+ models now.
- `SECURITY.md` permission lists are stale → `permissions-registry.ts` + `PERM-00`.
- `.env.example` (BIMS) omits ~10 live vars.
- research-v2 `CLAUDE.md` says Mongoose 8 (it's 9) and predates ~12 models; its `README.md` is the `sv` scaffold.
- `brevitest-middleware` README says "Webtask" — it's AWS Lambda now; the repo is behind the deployed Lambda (live code in `brevitest-device/firmware/Middleware reference files/lambda-current-8_18_26/`).
- `Brevitest-Firmware-v2` folder is a stale copy of `brevitest-device`.
- CartridgeRecord `finalizedAt` never written; sacred middleware doesn't hook `save()`.
- `OpentronsRobot.directUrl` / TAILNET-1/2 are approved but unbuilt as of 2026-08-18.
- Whether `services/cv-worker` (Fly.io) is still deployed is unknown; the app no longer calls it.
