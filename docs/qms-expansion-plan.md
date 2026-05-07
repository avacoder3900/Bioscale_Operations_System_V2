# BIMS Quality Management System (QMS) Expansion Plan

**Version:** 1.0  
**Date:** 2026-05-07  
**Scope:** Comprehensive eQMS roadmap covering CAPA, Non-Conformance, document red-line diffs, training enforcement, management review, and internal audit frameworks.

---

## 1. ISO 13485 / 21 CFR Part 820 Compliance Posture Audit

This section inventories BIMS capabilities against key regulatory requirements. The table below summarizes current state (HAVE / PARTIAL / MISSING), gap severity (CRITICAL / HIGH / MEDIUM / LOW), and estimated effort to close.

| Module | Requirement | BIMS State | Gap Severity | Effort | Notes |
|--------|-------------|-----------|-------------|--------|-------|
| **Document Control** | Controlled docs, revision history, approval workflow, effective dating, retirement | HAVE | LOW | 1-2 weeks | `Document.revisions[]` with status, approvalSignatureId. Missing: red-line diffs, version comparison UI. |
| **Document Control** | Document retrieval & restricted access | HAVE | LOW | included | Role-based permissions via `hasPermission()` on routes. |
| **Work Instructions** | SOP version control & step-level tracking | HAVE | LOW | 1 week | `WorkInstruction.versions[].steps[]` fully structured. Missing: diff viewer for multi-step changes. |
| **Training Records** | Link training to controlled docs & sign-off | PARTIAL | MEDIUM | 2-3 weeks | `User.trainingRecords[]` exists; missing enforcement (re-training on doc rev). |
| **QC / Inspection** | Incoming material & in-process inspection, result tracking | PARTIAL | MEDIUM | 2 weeks | `InspectionResult` & `InspectionProcedureRevision` exist. Missing: formal disposition workflow. |
| **Corrective Actions (CAPA)** | Root cause analysis, action tracking, effectiveness check, closure | MISSING | CRITICAL | 4-5 weeks | None. Needs new `CAPA` model, workflow states, owner tracking, notification system. |
| **Non-Conformance (NC)** | NC detection, investigation, disposition, closure, traceability | MISSING | CRITICAL | 3-4 weeks | `WorkflowViolation` is operator-level deviation log, not formal NC. Needs `NonConformance` model. |
| **Deviation Handling** | SOP deviation recording, impact analysis, corrective action linkage | PARTIAL | MEDIUM | 2 weeks | `WorkflowViolation` partially handles SOP deviations. Missing formal deviation module & CAPA integration. |
| **Equipment Calibration** | Calibration records, due dates, out-of-spec alerts | PARTIAL | MEDIUM | 2 weeks | `CalibrationRecord` & `ToolConfirmation` exist. Missing: formal calibration state machine & out-of-spec NC auto-trigger. |
| **Management Review** | Periodic review of QMS effectiveness, documented decisions | MISSING | HIGH | 3-4 weeks | None. Needs `ManagementReview` record model & evidence linking. |
| **Internal Audit** | Planned audits, findings, follow-up, evidence | MISSING | HIGH | 3-4 weeks | Partial in `WorkflowViolation`. Needs formal `InternalAudit` model & scope tracking. |
| **Complaint Handling** | Customer complaint log, investigation, root cause, response | MISSING | HIGH | 2-3 weeks | Adjacent: approval workflow exists; can be extended for complaints. |
| **Risk Management** | Risk assessment, mitigation planning, effectiveness verification | MISSING | HIGH | 4-5 weeks | No model. Out of scope for Phase 1; flagged for Phase 4+. |
| **Design Controls** | Design inputs/outputs, design review, design verification/validation | MISSING | HIGH | 6+ weeks | Out of scope for this roadmap (device design-phase, not manufacturing ops). |
| **Supplier Management** | Supplier qualification, audit, performance monitoring | PARTIAL | MEDIUM | 3-4 weeks | `ReceivingLot` & inspection exist. Missing formal supplier scorecards. Phase 3+. |
| **Labeling & Packaging** | Labeling review, batch/lot tracking, expiry management | PARTIAL | MEDIUM | 2-3 weeks | `LotRecord` & shipping exist. Missing label control matrix & expiry enforcement. Phase 2+. |
| **Electronic Records / E-Signatures** | eRecord retention, audit trail, e-signature legal standards | PARTIAL | MEDIUM | 2 weeks | `ElectronicSignature` model exists with immutable middleware. Missing: comprehensive audit trail UI & evidence matrix. |

### Key Takeaways

- **CRITICAL gaps:** CAPA, Non-Conformance. These are the highest regulatory priority and operationally enable all downstream QMS functions.
- **HIGH gaps:** Management Review, Internal Audit, Complaint Handling, Risk Management. Design Controls are out of scope for Phase 1.
- **ADJACENT/PARTIAL:** Training, QC, Calibration, Deviation. Can be promoted with modest rework.
- **Foundation strong:** Document control, e-signatures, work instructions, electronic records—all ready for QMS build-out.

---

## 2. CAPA System Design

### 2.1 Domain & Intent

Corrective and Preventive Actions (CAPA) is the systemic response to problems: a formal workflow that links triggers (NC, complaints, audits, deviations) → problem statement → root-cause analysis → action planning → execution → effectiveness check → closure.

CAPA distinguishes itself from ad-hoc fixes by enforcing documentation, ownership, deadlines, and evidence trails. CAPAs typically run 2-12 weeks depending on scope.

### 2.2 Data Model: CAPA

The CAPA model is comprehensive with fields for trigger source, root cause analysis, action items, effectiveness verification, and workflow gates. Key fields:
- `capaNumber`: Auto-generated identifier (CAPA-2026-001)
- `triggerSource`: non_conformance, customer_complaint, internal_audit, workflow_violation, management_review, other
- `state`: open → root_cause_analysis → action_planning → executing → effectiveness_check → closed
- `actionItems[]`: Owned, tracked, with due dates and completion evidence
- `effectivenessCheck`: Validates that actions solved the problem
- `signoffs[]`: Gate approvals with e-signatures at RCA, action plan, effectiveness, closure
- `auditHistory[]`: Full immutable trail of state changes

See section 2.2 full schema at end of document.

### 2.3 Routes & UI

**List & Dashboard:**
- `GET /quality/capa` → list open + overdue CAPAs, filter by owner, state, severity
- UI: kanban board or table with status/color-coding
- Dashboard metric: count open, count overdue, avg closure time, repeat root-causes

**Detail & Workflow:**
- `GET /quality/capa/[id]` → full CAPA detail, timeline view
- `PATCH /quality/capa/[id]` → update state, add RCA, complete action item
- `POST /quality/capa/[id]/signoff` → record signoff with e-signature
- `POST /quality/capa/[id]/action-items/[actionId]/complete` → mark action done
- `POST /quality/capa/[id]/effectiveness-check` → submit verification
- `POST /quality/capa/[id]/close` → transition to closed

**New CAPA Triggers:**
- `POST /quality/capa/from-nc` → auto-create CAPA from Non-Conformance
- `POST /quality/capa/from-violation` → create from repeated WorkflowViolation

### 2.4 Notifications & Escalation

- Overdue actions: Daily digest of CAPAs > due date
- Signoff pending: Notification to approver when gate awaits approval
- Escalation: If not updated for X days, escalate to department manager
- Closure approaching: Reminder 1 week before dueDate

### 2.5 Reporting

1. Open CAPA count by owner, severity, state
2. Average closure time (open date → closed date)
3. Repeat root-causes — flag if same root-cause appears 2+ times in 12 months
4. Action item compliance — % on-time completion
5. Effectiveness rate — % of CAPAs where effectiveness check passed on first try
6. NC-to-closure trend — time from NC detection to CAPA closure

---

## 3. Non-Conformance (NC) Tracking

### 3.1 Domain & Intent

A Non-Conformance is a **formal quality record** of any product, material, or process deviation that does not meet specification. This is distinct from `WorkflowViolation` (operator-level SOP deviation log) and becomes the trigger for investigation, containment, and disposition decisions (use-as-is, rework, scrap, return-to-vendor).

NCs are **regulatory artifacts** with legal audit trail & lifecycle requirements. Each NC drives a disposition workflow and may spawn a CAPA if systemic.

### 3.2 Data Model: NonConformance

Key fields:
- `ncNumber`: Auto-generated (NC-2026-0042)
- `detectionSource`: receiving_inspection, in_process_inspection, field_failure, customer_complaint, internal_audit, equipment_failure, manual_report
- `severity`: minor, major, critical
- `productAffected`, `lotAffected`: Links to CartridgeRecord, ReceivingLot, WaxFillingRun, ReagentBatchRecord
- `investigation`: rootCauseIdentified, investigationComplete, completedBy with e-signature
- `disposition`: type (use_as_is, rework, scrap, return_to_vendor), rationale, sign-off
- `linkedCapaIds[]`: CAPAs spawned from this NC
- `state`: open → under_investigation → awaiting_disposition → disposition_approved → closed
- `auditHistory[]`: Immutable trail

See full schema at end of document.

### 3.3 Routes & UI

**List & Dashboard:**
- `GET /quality/non-conformances` → list all NCs, filter by state, severity, detection source
- Dashboard: count open, distribution by severity, by source, closure rate

**Detail & Investigation:**
- `GET /quality/non-conformances/[id]` → full NC record with investigation, disposition, audit trail
- `PATCH /quality/non-conformances/[id]` → update investigation notes
- `POST /quality/non-conformances/[id]/disposition` → record disposition decision + sign-off
- `POST /quality/non-conformances/[id]/create-capa` → spawn linked CAPA
- `POST /quality/non-conformances/[id]/close` → transition to closed

**Auto-Triggers:**

The system auto-creates NCs when:
1. **QC reject above threshold** — if >X% of samples fail
2. **Equipment out-of-spec** — if consecutive readings >spec for >X minutes
3. **Operator-initiated scrap** — if operator marks cartridge as scrap
4. **Receiving inspection total failure** — if all inspection steps for a lot fail

### 3.4 NC-to-Product Traceability

- ReceivingLot → product lot → affected cartridges (via CartridgeRecord.lotId)
- CartridgeRecord → shipping lot (via ShippingLot)
- Trace forward to customer if shipped

**UI:** `GET /quality/non-conformances/[id]/traceability` → map of affected products, lots, shipped status.

---

## 4. Document Red-Line / Version Diff Viewer

### 4.1 Intent

Operators and auditors need to see *what changed* between document revisions for training and compliance.

### 4.2 Design: Diff Routes

**For text-based diffs (Markdown / plain-text):**
- `GET /documents/[id]/diff?from=REV-001&to=REV-002`
- Response: `{ from, to, diffBlocks: [{type, content, lineNo}] }`
- UI: side-by-side or unified diff view, green/red highlighting

**For structured diffs (WorkInstruction steps):**
- `GET /work-instructions/[id]/diff?from=V1&to=V2`
- Response: `{ from, to, stepDiffs: [{stepNumber, type, title, details}], summary }`
- UI: step-level change cards

### 4.3 Diff Algorithm

1. **Markdown/plain-text:** Split by line, use diffMatchPatch to identify insertions/deletions/modifications
2. **WorkInstruction.versions[].steps[]:** Compare arrays by step number; detect added/removed/modified steps
3. **Compute on-the-fly** (cheaper for occasional queries)

### 4.4 E-Signature Integration

When a revision is approved, record approver's e-signature:
- `approvalSignatureId`: ElectronicSignature._id

Diff viewer can link to signature for audit trail.

### 4.5 Acceptance Criteria

- Diff route returns accurate line-by-line (markdown) or step-by-step changes
- UI renders side-by-side with color-coding (green/red)
- Links to revision metadata (author, date, approval)
- For work instructions, diff includes field-level changes
- Performance: diff computation < 500ms for docs up to 50 KB
- Works with e-signature verification

---

## 5. Training Records Enforcement

### 5.1 Intent

When a controlled document is revised, operators who trained on the old revision should be marked for re-training on the new one.

### 5.2 Design: Training Requirement Generation

When a `Document` revision is **approved**:
1. Query all users with a `trainingRecord` for the old revision
2. Create new **training requirement records** (`TrainingRequirement` model)
3. Flag in operator UI as "Your trainings to complete"

**TrainingRequirement Model:**
- `userId`, `documentId`, `documentRevision`
- `requiredReason`: document_revision, role_assignment, audit_finding, regulatory_requirement
- `requiredAt`, `dueDate` (30 days default)
- `isCompleted`, `completedAt`, `trainerId`, `signatureId`
- `isOverdue`: computed

### 5.3 Workflow Hooks

When Document revision approved:
- Find all users with prior training on this doc
- Create TrainingRequirement for each
- Set dueDate = now + 30 days

### 5.4 Operator UI: Training Inbox

- `GET /documents/training/requirements` → list operator's incomplete trainings (overdue flagged in red)
- `POST /documents/training/requirements/[reqId]/complete` → upload signature, trainer confirms
- Notification: daily digest of overdue trainings

### 5.5 Admin UI: Training Compliance Dashboard

- `GET /admin/training/compliance` → per-document, per-user completion rate
- Report: "85% of ops trained on WI-002 REV-004; 3 overdue"

### 5.6 Acceptance Criteria

- Training requirements auto-created on doc revision approval
- Operator sees pending trainings in dashboard
- Overdue trainings flagged + notification sent
- Admin can see compliance % by doc & user
- E-signature captures trainer + date on completion
- Operator cannot perform certain tasks if required training is overdue

---

## 6. Management Review & Internal Audit (Stub Models)

### 6.1 Intent

Both are formal periodic reviews with documented evidence. Rather than full-featured modules in Phase 1, design lightweight stubs that store records and link to evidence (CAPAs, NCs, metrics).

### 6.2 Data Models

**ManagementReview:**
- `reviewNumber`, `title`, `description`
- `scheduledDate`, `actualDate`, `attendees[]`
- `evidenceLinks[]`: CAPA metrics, NC trends, inspection data, audit findings, customer feedback
- `findings`: summary of review
- `improvements[]`: improvement items with owner, targetDate, status
- `linkedCapaIds[]`: CAPAs initiated from this review
- `signatureId`: ElectronicSignature._id

**InternalAudit:**
- `auditNumber`, `title`, `description`
- `auditDate`, `auditScope`, `auditedArea`, `auditedBy[]`
- `findings[]`: findingCategory (non_conformance, observation, strength), severity, description, evidence, linked NC/CAPA
- `auditReport`: full report text
- `reportFileId`: link to File model
- `followUpRequired`, `followUpDate`, `followUpFindings`
- `signatureId`: ElectronicSignature._id

### 6.3 Routes (Minimal)

- `GET /quality/management-reviews` → list reviews
- `POST /quality/management-reviews` → create review
- `GET /quality/management-reviews/[id]` → view + linked CAPAs
- `PATCH /quality/management-reviews/[id]` → update findings
- `GET /quality/internal-audits` → list audits
- `POST /quality/internal-audits` → create audit
- `GET /quality/internal-audits/[id]` → view audit + findings
- `POST /quality/internal-audits/[id]/findings/[findingId]/create-nc` → spawn NC from finding

---

## 7. Phased Rollout & Implementation Plan

### Phase 1: Non-Conformance System (Weeks 1–3)

**Goal:** Formal NC tracking with disposition workflow.

**Deliverables:**
- NonConformance model with investigation, disposition, linkage to products
- Routes: list, detail, auto-create triggers (QC reject, equipment OOS, scrap)
- UI: list, detail/investigation, disposition decision form
- Auto-NC creation from QC fail, equipment out-of-spec, operator scrap
- Traceability: product lot impact map
- Reporting: count open, distribution by source/severity

**Acceptance Criteria:**
- Create NC via form + via auto-trigger
- Investigate & disposition (use-as-is, rework, scrap, RTV) with sign-off
- Traceability shows affected product lots & cartridges
- Create CAPA from NC
- Audit trail captures all state changes

**Estimated Effort:** 120–160 hours (3–4 eng-weeks)

---

### Phase 2: CAPA System (Weeks 4–6)

**Goal:** Full CAPA workflow with root-cause analysis, action planning, effectiveness verification.

**Deliverables:**
- CAPA model with root-cause analysis, action items, effectiveness check
- Routes: list, detail, state transitions, action item tracking
- Workflow gates: RCA approval, action plan approval, effectiveness approval, closure
- Notifications: overdue actions, pending signoffs, escalation
- Reporting: open count, avg closure time, repeat root-causes, effectiveness rate

**Acceptance Criteria:**
- Create CAPA (manual or from NC)
- State machine: open → RCA → action planning → executing → effectiveness → closed
- Signoff gates at 4 checkpoints
- Action items assigned to owners with due dates
- Overdue notifications
- Effectiveness check
- Repeat root-cause detection
- Closure requires effectiveness approval

**Estimated Effort:** 160–200 hours (4–5 eng-weeks)

---

### Phase 3: Document Diff Viewer & Training Enforcement (Weeks 7–8)

**Goal:** Operators see revision changes; auto-training requirements on doc updates.

**Deliverables:**
- Diff routes: `/documents/[id]/diff`, `/work-instructions/[id]/diff`
- Diff UI: side-by-side, green/red highlighting
- TrainingRequirement model
- Training requirement auto-creation on doc approval
- Operator training inbox
- Admin compliance dashboard

**Acceptance Criteria:**
- Diff API returns accurate changes
- UI renders diffs in < 500ms
- Training requirements auto-created on doc revision approval
- Operator sees pending trainings (overdue flagged)
- Completion via e-signature
- Admin sees compliance % by doc/user
- Task execution blocks if training overdue

**Estimated Effort:** 100–120 hours (2–3 eng-weeks)

---

### Phase 4: Management Review & Internal Audit (Weeks 9–10)

**Goal:** Lightweight stubs for periodic reviews.

**Deliverables:**
- ManagementReview model
- InternalAudit model
- Routes: list, create, view, link to CAPAs/NCs
- Audit report attachment
- Evidence linking

**Acceptance Criteria:**
- Create review/audit with date, attendees, scope
- Record findings
- Attach evidence files
- Link findings to auto-created CAPAs/NCs
- E-signature for review sign-off
- Search & filter

**Estimated Effort:** 80–100 hours (2 eng-weeks)

---

### Phase 5: QMS Dashboard & Reporting (Weeks 11–12)

**Goal:** Unified QMS operations dashboard + scheduled reports.

**Deliverables:**
- `/quality` hub: NC metrics, CAPA status, training compliance, audit schedule
- Reports: daily digest, weekly NC summary, monthly CAPA effectiveness
- 10 Ask BIMS tools for QMS queries
- Email scheduling for reports

**Acceptance Criteria:**
- QMS dashboard shows: open NCs, open CAPAs, training compliance %
- Metrics auto-update
- Ask BIMS tools return correct counts
- Email reports send on schedule

**Estimated Effort:** 60–80 hours (1–2 eng-weeks)

---

## 8. Ask BIMS Integration: New Tools

10 new tools extend the Ask BIMS system for QMS queries:

1. **list_open_ncs** — List open NCs by state, severity; filter by source
2. **find_capa_by_target** — Find CAPAs by owner, state, dueDate
3. **nc_metrics** — Count open NCs, severity distribution, detection trends
4. **capa_metrics** — Open count, avg closure time, effectiveness rate, repeat root-causes
5. **training_status_for_user** — User's pending/overdue trainings
6. **document_training_compliance** — % of staff trained on a document, who's overdue
7. **nc_to_product_impact** — Trace NC to affected products, lots, shipped status
8. **linked_capas_for_nc** — Find CAPAs spawned from an NC
9. **suggest_capa_from_violations** — Detect repeated WorkflowViolation patterns, suggest CAPA
10. **capa_effectiveness_trends** — Analyze CAPA effectiveness over time, by severity

Each tool:
- Queries MongoDB with appropriate filters
- Returns clean JSON object with human-readable summary
- Denies access if user lacks `quality:read` permission
- Respects pagination (limit, offset)
- Logs query to AskBimsCostLog

---

## 9. Integration with Existing Models

### 9.1 Non-Conformance ↔ Product Records

NCs link backward to source material/process and forward to shipped products:

```
ReceivingLot → Non-Conformance.receivingLotIds
           → CartridgeRecord.lotId → Traceability forward
```

Disposition propagates:
```
NonConformance.disposition.type == 'scrap'
  → Mark CartridgeRecord.status = 'scrapped'
  → Create InventoryTransaction
```

### 9.2 Document ↔ Training Records ↔ TrainingRequirement

```
Document.revisions[].approvedAt
  → Find all User.trainingRecords[].documentId == thisDoc
  → Create TrainingRequirement for each user
```

### 9.3 CAPA ↔ Non-Conformance ↔ Management Review

```
Non-Conformance → CAPA (via linkedCapaIds)
CAPA → ManagementReview (via linkedCapaIds in review evidence)
ManagementReview → new CAPA if improvement item created
```

### 9.4 Permission Model

New permissions for QMS:
- `quality:read` — view NC, CAPA, training, audit records
- `quality:create` — create NC, CAPA, training requirement
- `quality:approve` — signoff gates
- `quality:admin` — delete, re-open, escalate, override

Default roles:
- Operator: quality:read
- QA Manager: quality:create, quality:approve
- Operations Manager: quality:read, quality:create
- Admin: quality:admin

---

## 10. Migration & Deployment Notes

### 10.1 Database Migrations

All new models are additive; no destructive migrations.

Create indexes:
```
db.non_conformances.createIndex({ ncNumber: 1 }, { unique: true })
db.capas.createIndex({ capaNumber: 1 }, { unique: true })
db.capas.createIndex({ state: 1, dueDate: 1 })
db.training_requirements.createIndex({ userId: 1, isCompleted: 0 })
```

### 10.2 Cron Jobs

1. NC Auto-Triggers (hourly): Scan InspectionResult fails, Equipment OOS, manual scrap entries
2. CAPA Notifications (daily): Overdue CAPAs & action items
3. Training Compliance (daily): Overdue TrainingRequirements

### 10.3 Rollout Strategy

- Week 1: Deploy Phase 1 models + routes (manual NC creation)
- Week 2: Enable auto-triggers in staging
- Week 3: Prod deployment (Phase 1 complete)
- Weeks 4–6: Phase 2 (CAPA)
- Weeks 7–8: Phase 3 (training, diff viewer)
- Weeks 9–12: Phases 4–5

---

## 11. Success Metrics & Acceptance Criteria

### By Phase 1 Completion (Week 3)
- ≥ 90% of products receiving inspection failures auto-generate NCs
- NC list UI loads in < 1 second (100 records)
- Operators create manual NCs in < 2 minutes
- Traceability accurate for test data
- No data loss in NC → CAPA linkage

### By Phase 2 Completion (Week 6)
- CAPA creation from NC < 30 seconds
- State transitions trigger e-signature challenge
- Overdue notifications sent within 1 hour
- Repeat root-cause detection within 1 day
- Effectiveness check prevents closure if unsolved

### By Phase 3 Completion (Week 8)
- Diff API < 500ms for 50 KB docs
- Training requirement auto-created within 5 min of doc approval
- Operator dashboard loads < 1 sec
- Training completion blocks task execution if overdue

### By Phase 5 Completion (Week 12)
- QMS dashboard loads < 2 seconds
- All Ask BIMS tools respond < 5 seconds
- Email reports on schedule
- Zero data loss in integration tests

---

## 12. Risk & Mitigation

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|-----------|
| Auto-NC triggers too aggressive | High | High | Conservative thresholds; env var disable; manual review |
| CAPA gate bottleneck | Medium | High | Escalation timeout; delegate approvers; auto-approve after 7 days |
| E-signature complexity | Medium | Medium | Use existing ElectronicSignature model; test early |
| Training explosion | Medium | Medium | Batch trainings; optional for minor doc changes |
| NC-to-product incomplete | Medium | High | Validate links; test all paths |
| Ask BIMS tool cost | Low | Low | Aggregation pipelines; caching; query timeouts |

---

## 13. Glossary

- **CAPA:** Corrective and Preventive Action
- **NC:** Non-Conformance — quality defect record
- **Disposition:** Decision on non-conforming product (use-as-is, rework, scrap, RTV)
- **Root Cause Analysis (RCA):** Investigation to find underlying cause
- **Effectiveness Check:** Verification that CAPA actions solved problem
- **Gate / Sign-off:** Approval checkpoint in workflow
- **Escalation:** Elevation when stalled
- **E-Signature:** Electronic signature on regulatory artifact
- **Management Review:** Periodic assessment of QMS effectiveness
- **Internal Audit:** Planned compliance review
- **Traceability:** Link product lot to source material & customer

---

**Document Version:** 1.0  
**Last Updated:** 2026-05-07  
**Status:** Ready for Phase 1 Kickoff
