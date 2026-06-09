# PRD: SPU Assembly — In-Progress Build Widgets

## Overview
Extend the revamped `/assembly` page so that, in addition to the **Allocate UDI & Start New Build** affordance at the top, the page renders one widget per currently in-progress SPU build. Each widget shows the build's UDI, its current assembly step, and the operator who owns the unit. Operators can see at a glance every unit on the line, who is responsible, and how far each one has progressed. The Start Assembly action remains the primary CTA at the top of the page; the in-progress list lives below it.

## Background
- `PRD-SPU-ASSEMBLY-REVAMP` introduced auto-UDI allocation and a draft-SPU-on-click flow. Once a UDI is allocated, the SPU sits in `status: 'draft', assemblyStatus: 'created'` until the operator opens the work instruction and an `AssemblySession` is started.
- The line currently has no per-unit "in-flight" view on the assembly tab — operators must navigate elsewhere to see what's outstanding. This breaks parallel-build situations (multiple SPUs in flight at once).
- `Spu` carries `udi`, `status`, `assemblyStatus`, `createdBy`, `owner`, `finalizedAt`, `voidedAt`. `AssemblySession` carries `spuId`, `userId`, `status`, `currentStepIndex`, `stepRecords[]`, `workInstructionTitle`. The active SPU work instruction (S4 of the previous PRD) is the source of truth for total step count.
- "Owner of the unit" maps cleanly to the operator who started the build. There is no separate ownership-transfer concept yet.

## Key Decisions (Owner-Approved)
1. **Show all in-progress SPUs**, not just the current operator's. Manufacturing is a shared line; everyone benefits from seeing what's in flight.
2. **One owner per widget** — the operator who created the draft SPU (`Spu.createdBy`, resolved to a username). If `Spu.owner` is set explicitly later, prefer that.
3. **Current step** is read from the latest `AssemblySession` for the SPU. If no session has been started yet, the widget shows "Not started" and a **Continue to Work Instruction** affordance.
4. **Click-through** on a widget routes the operator into the existing assembly session, or, if none exists, opens the active SPU work instruction (re-uses the `openWorkInstruction` action).
5. **Order:** most recently created first.
6. **In-progress definition:** `status ∈ {draft, assembling}`, `finalizedAt` null, `voidedAt` null. Once a unit is finalized, voided, or transitions past `assembling`, it disappears from this list.
7. **No new model fields, no new collections** — this is a presentation change over existing data.

## Stories

### S1: In-Progress SPU Loader
**As a** developer, **I want** the assembly page load to return a list of in-progress builds with step + owner data **so that** the page can render one widget per unit.

**Acceptance Criteria:**
- Modify `src/routes/assembly/+page.server.ts` `load` to also return `inProgressBuilds: Array<{ spuId, udi, ownerUsername, currentStepIndex, totalSteps, sessionId|null, status, assemblyStatus, createdAt }>`.
- Query: `Spu.find({ status: { $in: ['draft', 'assembling'] }, finalizedAt: null, voidedAt: null }).sort({ createdAt: -1 }).limit(50).lean()`.
- For each SPU:
  - Resolve `ownerUsername` — prefer `Spu.owner` (if a username/userId), fall back to `Spu.createdBy`. Resolve to a `User.username` via a single batched query.
  - Find the latest `AssemblySession` for that `spuId` (sorted by `startedAt` desc). If found, capture `currentStepIndex` and `_id` as `sessionId`.
  - Compute `totalSteps` from the active SPU work instruction's current version step count (already loaded via `getActiveSpuWorkInstruction()`); fall back to `null` if none active.
- Permission: load already requires `spu:read`; no change.

**Technical Notes:**
- Single batched `User.find({ _id: { $in: [...] } })` and `AssemblySession.find({ spuId: { $in: [...] } })` — do not query per-row.
- Serialize through `JSON.parse(JSON.stringify(...))` per CLAUDE.md.

### S2: In-Progress Widgets on the Page
**As an** operator, **I want** to see a card for every in-progress SPU **so that** I know what's on the line, who owns it, and where each unit is.

**Acceptance Criteria:**
- Modify `src/routes/assembly/+page.svelte` to render a section titled **In-Progress Builds** below the Start Assembly CTA and above any post-allocation cards.
- One `TronCard` per `inProgressBuilds[]` entry showing:
  - **UDI** in monospace, prominent.
  - **Step** label: `"Step {currentStepIndex + 1} of {totalSteps}"` if a session exists and totalSteps is known; `"Step {currentStepIndex + 1}"` if totalSteps is null; `"Not started"` if no session.
  - **Owner**: `ownerUsername` (or "—" if missing).
  - **Status pill**: `draft` or `assembling`.
  - Primary CTA on the card:
    - If `sessionId` present → link to `/assembly/{sessionId}`.
    - Else → POST to `?/openWorkInstruction` with `spuId` (re-uses S3 of the prior PRD).
- Empty state: when `inProgressBuilds.length === 0`, render a single muted line: "No builds in progress."
- Layout: stack vertically on mobile, two-column grid ≥768px.

**Technical Notes:**
- Only the assembly `+page.svelte` is touched here. `[spuId]` and per-session pages are unchanged.
- Use existing Tron classes; no new components.

### S3: Cleanup — Stale Drafts Indicator
**As an** operator, **I want** stale draft SPUs (created >24h ago, no session) flagged **so that** I can decide whether to resume or abandon.

**Acceptance Criteria:**
- For any in-progress SPU whose latest session is null AND `createdAt < now - 24h`, the widget shows a small `Stale` badge next to the status pill.
- No state change is performed; this is presentation only. Stale-cleanup actions are out of scope for this PRD.

**Technical Notes:**
- Compute `isStale` server-side and include in the load shape so the .svelte does not need to compare timestamps.

## Out of Scope
- Filtering/sorting controls (by owner, status, age).
- Reassigning an SPU's owner.
- Bulk-voiding stale drafts.
- WebSocket / live updates — page-load freshness is sufficient for v1.
- Showing finalized/voided SPUs (those belong to history pages).
