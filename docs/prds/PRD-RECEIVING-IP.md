# PRD: Receiving & Inspection Procedure (ROG/IP) Port from V1

## Overview
Port the Receiving of Goods (ROG) and Inspection Procedure (IP) features from V1 `NickROGandIPFeature` branch to V2 (MongoDB/Mongoose). Also port the Opentrons API proxy layer.

## Source Reference
- V1 repo: `/Users/agent001/Bioscale_Operations_System`
- V1 branch: `origin/NickROGandIPFeature`
- V2 repo: `/Users/agent001/Bioscale_Operations_System_V2`
- V2 branch: `NichEditsandTesting`

## Stories

### RECV-01: Mongoose Models for Receiving/Inspection
**Create 4 new Mongoose models:**
1. `receiving-lot.ts` — based on V1 `receivingLot` table
2. `inspection-result.ts` — based on V1 `inspectionResult` table  
3. `inspection-procedure-revision.ts` — based on V1 `inspectionProcedureRevision` table
4. `tool-confirmation.ts` — based on V1 `toolConfirmation` table

**Also update:**
- `part-definition.ts` — add `inspectionPathway` (default 'coc'), `sampleSize` (default 1), `percentAccepted` (default 100), `supplier` fields
- `bom-item.ts` — add `supplier` field if missing
- `index.ts` — export all new models

**Reference:** V1 schema at `src/lib/server/db/schema.ts` lines for these tables.
**Pattern:** Follow existing V2 model patterns (nanoid IDs, timestamps, etc.)

### RECV-02: Receiving Components (11 Svelte files)
**Create `src/lib/components/receiving/` with:**
1. `CocUpload.svelte` — Certificate of Conformance upload
2. `DimensionInput.svelte` — Dimension measurement input
3. `InspectionForm.svelte` — Main inspection form container
4. `IpFormDefinitionEditor.svelte` — IP form definition editor
5. `IpInspectionLayout.svelte` — Split-screen IP inspection layout
6. `IpRevisionHistory.svelte` — Revision history viewer
7. `PartSelector.svelte` — Part selection dropdown
8. `PassFailInput.svelte` — Pass/fail toggle input
9. `ToolCheckGate.svelte` — Tool confirmation gate
10. `VisualInspectionInput.svelte` — Visual inspection input
11. `YesNoInput.svelte` — Yes/no toggle input

**Reference:** Port directly from V1 `src/lib/components/receiving/` — adapt Drizzle queries to Mongoose, keep Svelte 5 patterns from V2.

### RECV-03: Receiving Routes (List + New)
**Create:**
- `src/routes/spu/receiving/+page.server.ts` — load receiving lots list
- `src/routes/spu/receiving/+page.svelte` — receiving lots list page
- `src/routes/spu/receiving/new/+page.server.ts` — create new receiving lot (form actions for COC + IP pathways, override workflow)
- `src/routes/spu/receiving/new/+page.svelte` — new receiving lot form page

**Reference:** Port from V1 `src/routes/spu/receiving/`. The `new` page is complex (~700 lines) with:
- Part selector with inspection pathway detection
- COC upload path
- IP inspection path (split-screen layout, tool checks, multi-sample forms)
- Override workflow for failed inspections
- Photo/document attachments

### RECV-04: Opentrons API Proxy Routes
**Create `src/routes/api/opentrons-lab/robots/` tree:**
- `+server.ts` — list robots
- `[id]/+server.ts` — get robot details
- `[id]/health/+server.ts` — health check
- `[id]/home/+server.ts` — home robot
- `[id]/identify/+server.ts` — identify (blink lights)
- `[id]/lights/+server.ts` — toggle lights
- `[id]/calibration/+server.ts` — calibration data
- `[id]/info/+server.ts` — system info
- `[id]/protocols/+server.ts` — list protocols
- `[id]/protocols/[pid]/+server.ts` — protocol detail
- `[id]/protocols/[pid]/analyses/+server.ts` — protocol analyses
- `[id]/runs/+server.ts` — list/create runs
- `[id]/runs/[rid]/+server.ts` — run detail
- `[id]/runs/[rid]/actions/+server.ts` — run actions (play/pause/stop)
- `[id]/runs/[rid]/state/+server.ts` — run state

**Reference:** Port from V1 `src/routes/api/opentrons-lab/`. These are proxy routes that forward to the OT-2 robot HTTP API. Use V2's existing `OpentronsRobot` model for robot lookup.

### RECV-05: Part Detail Page Enhancements
**Update** `src/routes/spu/parts/[partId]/+page.server.ts` and `+page.svelte`:
- Add inspection pathway configuration (COC vs IP)
- Add sample size and percent accepted fields
- Add IP revision management (upload, view history)
- Add supplier field display

**Reference:** V1 `src/routes/spu/parts/[partId]/` has ~1260 lines of enhancements.

## Implementation Notes
- V2 uses MongoDB/Mongoose, NOT Drizzle/Postgres — all queries must use Mongoose
- V2 uses Svelte 5 runes ($state, $derived, etc.) — check existing V2 components for patterns
- Follow V2's CLAUDE.md coding standards strictly
- All IDs use nanoid (not ObjectId)
- Auth uses cookie-based sessions — check `locals.user` in server files
