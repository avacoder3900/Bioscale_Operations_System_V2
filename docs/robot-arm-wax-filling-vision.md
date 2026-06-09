# Robot-Arm Wax Filling — Long-Term Vision

**Status:** Conceptual / North star. NOT for current implementation. Captured 2026-05-07 to align future architectural decisions with this direction.

## Why this doc

The current wax-filling flow involves multiple human handoffs across stages (backing, induction, deck loading, run start, removal, cooling, QC, storage). Each handoff is an opportunity for error, throughput loss, or untracked state. The user has indicated that the long-term direction is **a single continuous flow driven by a 6-axis robot arm**. This document captures what that future state looks like so today's decisions don't paint us into a corner.

This is not a build plan. It's a horizon line that informs:
- Whether new models should be robot-agnostic or assume Opentrons-only
- Whether new APIs should expose physical-state primitives (positions, velocities, gripper state) or keep operating at the run-aggregate level
- Whether the UI design language should treat human steps as first-class or as escape hatches

## The end-state, in one paragraph

A cartridge enters the wax-filling cell as a backing-completed unit. A vision system identifies it and reads its barcode. The robot arm picks it from the cooling tray, transports it to the deck, presents it to the dispense head, holds it during the wax-fill cycle, transports it to the cooling station, performs (or stages for) QC photo capture, and places it in the appropriate fridge bin — all without human touch. BIMS records every transition as an event keyed to the cartridge serial. Operators supervise via a single-pane dashboard that surfaces throughput, anomalies, and the next required human action (lot loading, error recovery, QC sign-off on flagged units). The current 12-step manual flow collapses to ~3 supervised checkpoints.

## What this implies for current architecture

### Models / schema
- **`Equipment`** needs to support arm-style robots cleanly, not just OT-2-style fluid dispensers. Don't hard-code OT-2 assumptions into new fields.
- **`WaxFillingRun.cartridgeIds[]`** is OK as a list. But for an arm-driven flow, "run" might become "shift" — many carts processed continuously, no clear run boundary. Plan for both shapes.
- **A new `PhysicalEvent` collection** may be needed to capture per-cartridge transport events (picked-from-tray, placed-on-deck, etc.) without polluting `CartridgeRecord` with hundreds of subdocs. Treat as event-sourced state; project current state into `CartridgeRecord` for fast reads.
- **Vision integration**: cartridge identification at pick-time relies on QR/barcode read. Today's `ScannerEvent` model assumes manual scans. Need to extend or fork for automated/in-line vision reads.

### APIs
- The current `/api/opentrons-lab/*` routes assume an OT-2 with HTTP API. A robot arm controller (Universal Robots, Doosan, Franka, etc.) typically uses ROS or a vendor-specific protocol over TCP/socket. Plan for **robot-agnostic abstraction layer** at the API boundary — the BIMS server shouldn't know which arm vendor it's talking to.
- WebSocket / SSE infrastructure for real-time arm state to the operator dashboard. Today's BIMS is request/response only.

### UI
- Today's `/manufacturing/wax-filling` page assumes operator-driven step transitions. The robot-arm equivalent is a passive **monitoring dashboard** with intervention affordances. Layout should already converge toward this — large status displays, exception-only interaction.
- Consolidating multiple manufacturing pages into a unified "floor monitor" view is the right direction. Per memory, a `/manufacturing/pipeline` page already exists — extending that pattern is the move.

### QMS
- Robot-arm processes still require validation under ISO 13485 / 21 CFR Part 820. Each automated step requires an Operational Qualification (OQ) and Performance Qualification (PQ) protocol. New models for `EquipmentQualification` (parallel to `CalibrationRecord`) will be needed.
- IQ/OQ/PQ protocol records linked to `Equipment` and `Document` (the qualification protocol itself). Out of scope today but on the horizon.

## What we should NOT do today

- Don't build hardware-specific abstractions for OT-2 that would have to be unwound for an arm
- Don't assume all manufacturing flows pass through human-driven page transitions — leave room for event-sourced state
- Don't tightly couple `CartridgeRecord` lifecycle to a specific number of stages (today: backing → wax_filling → wax_stored → reagent_filled → ...). The arm flow may compress these or add intermediate vision/QC steps.
- Don't lock the UI design language into operator-action-per-page. Some new pages should be **monitor-style** (status, exceptions, drilldowns) — and that pattern should be a peer to the current operator-action style, not a special case.

## What we SHOULD do today (small bets that pay off later)

1. **Robot-agnostic Equipment schema**: any new field added to `Equipment` should make sense for both OT-2 and an arm. If it doesn't, put it on a sub-doc keyed by `equipmentType`.
2. **Event-sourced state experiment**: try one new flow (e.g., post-QC fridge placement) as event-sourced (events on a new collection, current state projected) instead of nested subdocs. Validate the pattern before generalizing.
3. **Abstraction at the API boundary**: when adding new robot endpoints, name them around the *operation* (`/api/robots/[id]/pick`, `/api/robots/[id]/place`) rather than the platform (`/api/opentrons-lab/[id]/...`). Today's Opentrons can implement those endpoints; tomorrow's arm replaces the impl, not the API.
4. **Real-time channel**: stand up a simple SSE / WebSocket channel for one feature (e.g., live run progress) so the infra exists when arm telemetry needs it.

## What the operator experience would look like

**Today**: 12 page transitions, multiple confirmations, 3+ scans per cartridge.

**Future**: One screen. Header: cells running, units processed today, exceptions awaiting attention. Body: live throughput graph, current stage population (X carts in transit, Y in dispense, Z in cooling), exception list ("Cart abc-123 failed vision check at pick — investigate"). Footer: shift summary, next scheduled tasks (refill wax, calibration due).

**The intervention pattern**: operator only touches the system when there's an exception. Resolving an exception is one click + scan + decision. Routine operation is hands-off.

## Phased path (post-current-roadmap)

This is years out, gated by hardware + validation. Rough sketch:

1. **Year 0 (now)**: ERP + QMS + tighter Opentrons integration + scanner automation. Current roadmap. Prepares the operating ground.
2. **Year 1**: Single arm prototype on one wax-filling cell. Manual override always available. Event-sourced cartridge state in production. Real-time dashboard.
3. **Year 2**: Multi-arm cell, QMS/validation infra mature, vision-based QC integrated into the arm flow.
4. **Year 3+**: Lights-out wax filling for one assay. Operators supervise N cells from one console.

## Open questions for later

- Vendor: which arm? UR? Doosan? Franka? Custom? Decision drives integration approach.
- Vision: in-line cameras vs. dedicated QC station. Cost, accuracy, validation overhead.
- Throughput target: what's the production rate that justifies the capex?
- Validation strategy: who writes IQ/OQ/PQ protocols? Internal QMS team or contractor?
- Backup / failure modes: when the arm goes down mid-shift, how does the line continue?

---

*This doc deliberately doesn't propose to build any of this now. Its job is to make sure none of today's architectural decisions silently foreclose this future. Revisit annually.*
