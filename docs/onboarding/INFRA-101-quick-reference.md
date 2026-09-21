# INFRA-101 — Quick Reference Cards (engineer handout)

Eight one-screen cards. Keep this open on a second monitor during the session and come back to it later.

---

## Card A — The map in one breath

| | BIMS | research-v2 | device / middleware |
|---|---|---|---|
| Repo | `Bioscale_Operations_System_V2` | `brevitest-research-v2` | `brevitest-device` (firmware **+ live Lambda** in `firmware/Middleware reference files/lambda-current-*`) |
| Does | manufacturing, SPU records, inventory, kanban, QMS, OT-2/CV/arm control, MCP | experiments, reagent prep, analysis, calibration, exports, push-assay | reader firmware; Particle → Lambda → Mongo |
| Runs on | Vercel (`master` = prod) | Vercel (`main` = prod) | Particle M-SoM / AWS Lambda us-east-1 |
| Database | **same** Atlas cluster, db `bioscale` | **same** | **same** (`cartridge_records`, `assay_definitions`) |

Four mental models: **Mongo is the truth · sacred docs are append-only · the lab is outbound-only · docs and PRDs drive the agents.**

---

## Card B — Data tiers & sacred docs

| Tier | Rule | Models |
|---|---|---|
| Sacred | mutable until `finalizedAt`; then only `$push corrections[]`; never delete | CartridgeRecord, SPU, AssayDefinition, ReagentBatchRecord, ReagentLot, RobotArmRun, User (deactivate) |
| Operational | normal CRUD | kanban, inventory, equipment, opentrons, CV, robot arm, analytics… |
| Immutable | insert only | AuditLog, ElectronicSignature, InventoryTransaction, DeviceEvent, ManufacturingMaterialTransaction, DeviceLog, DeviceCrash, WebhookLog, TemperatureReading |

- IDs = nanoid **strings** (cartridge/vial `_id` = UUID barcode; assay id = `A`+7 hex).
- Denormalize at write (`{ _id, username }`); snapshot for point-in-time (SPU into cartridge at test).
- `_id: false` on data-only subdoc arrays. `.lean()` + `JSON.parse(JSON.stringify())`.
- **CartridgeRecord = the spine**: one sub-object per phase (`backing … shipping`), `photos[]`, `notes[]`, `corrections[]`, embedded `assay`, device `rawData`. **The cartridge record *is* the test record.**
- **SPU** = the reader instrument's Device History Record (`udi`, `parts[]`, `validation`, `particleLink`, `signature`).
- Correction shape: `{ fieldPath, previousValue, correctedValue, reason, correctedBy, correctedAt }`.

---

## Card C — Environment variables: where they live

| Home | How | Notes |
|---|---|---|
| Laptop | `.env` (gitignored) | copied by hand; **never over chat**; `.env.example` is incomplete |
| Vercel | Project → Settings → Env Vars | set **Production + Preview**; redeploy after change |
| AWS Lambda | function config | `MONGODB_URI`, `BIMS_API_URL/KEY`, `PARTICLE_*`, `COUCHDB_*` |
| Particle Console | webhook targets, product firmware | |
| Pis | `/data/ot2-bridge/.env`, `/etc/bims/station.env` | `BIMS_BASE_URL` must be the Vercel URL |

Read in app: `import { env } from '$env/dynamic/private'`; in scripts: `dotenv` + `process.env`.
Families: `MONGODB_URI` · machine keys `AGENT_API_KEY`, `MCP_API_KEY`, `CRON_SECRET`, `*_FLEET_KEY`/`STATION_AGENT_KEY` · services `R2_*`, `BOX_*`, `RESEND_*`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `MOCREO_*` · hardware `ROBOT_ARM_BASE_URL/API_KEY`, `OT2_TRANSPORT`, `BROWSER_PRINT_URL` · flags `PERMISSIONS_ENFORCE`.

---

## Card D — Writing a server file (the five lines)

```ts
export const load: PageServerLoad = async ({ locals }) => {
  requirePermission(locals.user, 'resource:read');   // 1 guard (throws 403)
  await connectDB();                                   // 2 connect (lazy singleton)
  const items = await Model.find({...}).select('a b').lean(); // 3 query
  return { items: JSON.parse(JSON.stringify(items)) }; // 4 serialize  5 return
};
```
- Mutations: validate → write → **`AuditLog.create()`** → redirect. Sacred: check `finalizedAt` first.
- Machine endpoints: `requireAgentApiKey(request)` from `$lib/server/api-auth`.
- Auth: cookie `auth-session` → SHA-256 → `sessions._id` → `locals.user`. Permissions: `resource:action` strings; `hasPermission` / `requirePermission`; never check `roleName`.
- Off-limits: `src/lib/stores/`, `src/lib/utils/`, `app.html`, `app.css`, `static/`.
- Validate: `npm run check` (note baseline count) · `npm run build` · `npm run test:contracts`.
- Deploy: push branch → preview; merge to `master` → production. **Never `vercel deploy` locally.** Log every deploy in `progress.txt`.

---

## Card E — Device data path

```
SPU firmware (C++, Particle M-SoM v84)
  Particle.publish: load-assay | validate-cartridge | upload-test | reset-cartridge | device-log
        ↓ Particle Cloud webhook (POST JSON: event, data, device_id, fw_version…)
  AWS Lambda (API Gateway us-east-1)  index.mjs → db-adapter.mjs
        ↓ MongoDB bioscale.cartridge_records / assay_definitions  (CouchDB fallback)
        ↓ evaluate.mjs / unmix_ratio.mjs computes the clinical result
        ↑ reply on topic {deviceId}/hook-response/{event}, 512-byte chunks
  Also → BIMS /api/particle/webhook, /api/device/logs|crashes|webhook-logs|events (immutable)
```
- Assay = id + BCODE + duration; downloaded once, cached in `/assay/<id>`; validate returns pointer + checksum only.
- `upload-test` = 9,668-byte binary: header + ≤300 × 32-byte readings (f1–f8, clear, nir, temp, laser, msec).
- Result computed **in the middleware**; device sends raw counts. Idempotent re-uploads.
- Docs: `firmware/Docs/PARTICLE_WEBHOOK_REFERENCE.md`, `STATE_MANAGEMENT_GUIDE.md`, `LOAD_ASSAY_INVESTIGATION.md`.

---

## Card F — Lab hardware: three patterns

| Pattern | Who | Mechanism | Auth |
|---|---|---|---|
| **Device polls cloud** | OT-2 ×3 (B07, R04, B14; Pi 3B+ inside, `robot-server :31950` no auth) | `ot2-bridge.py` long-polls `POST /api/agent/ot2/poll`, claims `Ot2BridgeCommand`, relays to localhost:31950, posts `/result`; `OT2_TRANSPORT=direct\|bridge\|auto` | `x-agent-api-key` |
| **Browser → device (tailnet)** | CV capture stations (Pi + camera + scanner, `:8765` behind `tailscale serve`) | browser WebRTC/WS to Pi with station-signed JWT; Pi pushes register/heartbeat/ingest to BIMS; images → R2; inference **in-process on Vercel** | `x-station-agent-key`, JWT |
| **Cloud → device** | Robot arm SO-ARM101 (`arm-pi :8000`, Tailscale Funnel) | BIMS calls FastAPI; arm posts `/api/robot-arm/webhook`; `RobotArmRun` sacred | `x-api-key` / agent key |

Rule: **Vercel can't reach the lab; nothing in the lab is inbound-exposed.** Planned: OT-2 Pis join the tailnet (`tailscale serve 443 → 31950`); browser talks to robot directly for pause/resume/jog; queue stays for Start Run + records. Lab Mac = jump box, not a server. Zebra ZT230 via Browser Print on localhost. Mocreo temps pulled by cron.

---

## Card G — Agents & MCP

- **MCP server** at `https://<bims>/api/mcp` (Streamable HTTP, stateless). ~30 tools = thin wrappers over `/api/agent/**` (single audit path). Auth `MCP_API_KEY` as Bearer / `x-api-key`; URL-only clients use `/api/mcp/k/<key>`. Docs `docs/MCP-SERVER.md`.
- **Agent API** `/api/agent/**` (`ot2`, `scanner`, `cartridge`, `inventory`, `operations`, `query`, `schema`, `ask`…), `requireAgentApiKey`.
- **Rules for machines**: bots are non-admins (propose, don't decide); write tools need `actor` = human's name (attribution, not authority); dual-identity audit; per-fleet device keys.
- **Ask BIMS**: Claude in-app, read-only across both apps' collections, spend caps via env.
- Connect Claude Desktop/claude.ai: custom connector URL + Request header `Authorization: Bearer <MCP key>`.

---

## Card H — How we build (Ralph loop)

`PULL → READ (AGENTS.md, CLAUDE.md, SECURITY.md, progress.txt, PRD) → IMPLEMENT → VALIDATE (check/build/tests) → LOG (progress.txt) → COMMIT (feature branch) → PUSH → REPORT`

- One PRD per feature in `docs/prds/` (families `KB2-`, `PERM-`, `OT2-`, `CV-`, `WAX-`, `CALIB-`, `ARM-`): Date/Owner/Status/Parent · Goal · Facts · Steps · Acceptance. Write/approve the PRD first.
- `progress.txt`: heartbeat ≤ 1 h; deployment entries (URL, branch @ sha, purpose).
- Branch per workstream; **git worktrees** for parallel streams (`docs/worktree-commands.md`); copy `.env` by hand.
- Production trunk: BIMS `master`, research `main`. Merge only with human approval. Never local Vercel deploys.
- Read before auth work: `SECURITY.md` + `docs/prds/PERM-00`. Read before hardware work: `docs/prds/OT2-TAILNET-0-PLAN.md`. Data: `docs/DATA-REFERENCE.md`.
- Handoffs: write so the next session (human or Claude) can continue from `progress.txt` + the PRD alone.

**First week**: clone 3 repos · `.env` from Jacob in person · `npm run dev` · read the 4 root docs · `npm run check` baseline · connect Claude Desktop to `/api/mcp` · pick a small PRD · first PR → preview → log it.
