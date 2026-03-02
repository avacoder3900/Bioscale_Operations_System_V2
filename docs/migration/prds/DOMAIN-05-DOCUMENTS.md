# DOMAIN-05-DOCUMENTS — Work Instructions & Controlled Documents

## Overview
**Domain:** Document Control, Work Instructions, Document Repository, File Upload
**Dependencies:** Auth
**MongoDB Collections:** `work_instructions`, `documents`, `document_repository`, `files`, `electronic_signatures`
**Test File:** `tests/contracts/05-documents.test.ts` (8 tests)
**Contract Registry Sections:** Document Control Routes, SPU Document Routes

---

## Story DOC-01: Controlled Documents CRUD & Revisions

### Description
Implement the controlled documents system — list, create, view detail with revision history, create new revisions.

### Routes Covered
- `GET /documents` — document list with category filter
- `GET /documents/new` — create document form
- `POST /documents/new` — create document
- `GET /documents/[id]` — document detail with revisions and user training
- `GET /documents/[id]/revise` — create new revision form
- `POST /documents/[id]/revise` — submit revision

### Contract References
**GET /documents returns:**
```typescript
{
  documents: {
    id: string, documentNumber: string, title: string, category: string | null,
    currentRevision: number, status: string, effectiveDate: Date | null,
    ownerId: string | null, ownerUsername: string | null, createdAt: Date
  }[]
  categories: string[]
  selectedCategory: string | null
}
```

**GET /documents/[id] returns:**
```typescript
{
  document: {
    id: string, documentNumber: string, title: string, category: string | null,
    currentRevision: number, status: string, effectiveDate: Date | null,
    retiredDate: Date | null, ownerId: string | null, ownerUsername: string | null,
    createdAt: Date, updatedAt: Date
  }
  revisions: {
    id: string, revision: number, content: string | null,
    changeDescription: string | null, status: string, createdAt: Date,
    createdBy: string | null, approvedAt: Date | null
  }[]
  userTraining: { id: string, documentRevisionId: string, trainedAt: Date, revision: number }[]
}
```

### MongoDB Models Used
- `Document` — revisions are **embedded** as `revisions[]`, training records embedded in each revision as `trainingRecords[]`

### MongoDB-Specific Notes
- Old code had `Document` + `DocumentRevision` + `DocumentTraining` as 3 separate collections — all embedded now
- Creating a revision: `Document.findByIdAndUpdate(id, { $push: { revisions: { ... } } })`
- `ownerUsername` needs to be denormalized or looked up from User collection
- Categories: `Document.distinct('category')`

### Acceptance Criteria
- Tests 1, 4 in `05-documents.test.ts` pass (document list, new document form)

---

## Story DOC-02: Approvals, Training & Electronic Signatures

### Description
Implement document approval workflow, training records, and electronic signature capture.

### Routes Covered
- `GET /documents/approvals` — pending approvals list
- `GET /documents/[id]/approve` — approval form
- `POST /documents/[id]/approve` — submit approval decision
- `GET /documents/training` — user's training records
- `GET /documents/[id]/train` — training form
- `POST /documents/[id]/train` — complete training

### Contract References
**GET /documents/approvals returns:**
```typescript
{
  pendingRevisions: {
    revisionId: string, revision: number, changeDescription: string | null,
    submittedAt: Date, submittedById: string | null, submittedByUsername: string | null,
    documentId: string, documentNumber: string, title: string, category: string | null
  }[]
}
```

**GET /documents/training returns:**
```typescript
{
  completedTraining: { trainingId: string, trainedAt: Date, notes: string | null, ... }[]
  pendingTraining: { documentId: string, documentNumber: string, ... }[]
}
```

**POST /documents/[id]/approve accepts:**
`{ decision: 'approve' | 'reject', comments?: string, password: string, meaning: string }`

### MongoDB Models Used
- `Document` — query for pending revisions across all documents (need aggregation to "unwind" embedded revisions)
- `ElectronicSignature` — create on approval/training completion
- `User` — verify password for e-signature

### MongoDB-Specific Notes
- Finding pending revisions across documents: `Document.aggregate([{ $unwind: '$revisions' }, { $match: { 'revisions.status': 'in_review' } }])`
- Training records are embedded in document revisions: `revisions[].trainingRecords[]`
- Training per user: aggregate across all documents to find which user has/hasn't trained on current revisions
- Electronic signature: separate immutable collection, referenced by `signatureId` from revision/training

### Acceptance Criteria
- Tests 2-3 in `05-documents.test.ts` pass (approvals page, training page)
- Approval flow works with e-signature
- Training completion creates training record + e-signature

---

## Story DOC-03: Work Instructions

### Description
Implement work instructions with versioned steps, part requirements, tool requirements, and field definitions.

### Routes Covered
- `GET /spu/documents/instructions` — work instruction list
- `POST /spu/documents/instructions` (action: create)
- `GET /spu/documents/instructions/[id]` — instruction detail with steps and runs
- `GET /spu/documents/instructions/[id]/fields` — field definitions

### Contract References
**GET /spu/documents/instructions returns:**
```typescript
{
  workInstructions: {
    id: string, title: string, documentNumber: string, version: number,
    status: string, category: string | null, createdAt: Date, updatedAt: Date
  }[]
}
```
Note: test checks for key `workInstructions`.

**GET /spu/documents/instructions/[id] returns:**
```typescript
{
  instruction: {
    id: string, title: string, documentNumber: string, version: number,
    status: string, category: string | null, content: string | null,
    steps: { id: string, stepNumber: number, title: string, description: string, fields: unknown[] }[],
    createdAt: Date, updatedAt: Date
  }
  runs: { id: string, runNumber: string, status: string, startedAt: Date, completedAt: Date | null, operatorName: string }[]
}
```

### MongoDB Models Used
- `WorkInstruction` — versions, steps, part/tool requirements, and field definitions are ALL **embedded**
- `ProductionRun` — for listing runs associated with a work instruction

### MongoDB-Specific Notes
- Old code: 7 separate collections (`WorkInstructions`, `WorkInstruction`, `WorkInstructionVersion`, `WorkInstructionStep`, `StepPartRequirement`, `StepToolRequirement`, `StepFieldDefinition`) — all collapsed into one document
- One query loads the entire work instruction tree
- ⚠️ Image warning: if `imageData` (base64) > 500KB per step, store externally

### Acceptance Criteria
- Tests 5-6 in `05-documents.test.ts` pass (SPU documents, work instructions)

---

## Story DOC-04: Document Repository, Upload & Box Integration

### Description
Implement the file repository, file upload, build logs page, and Box.com integration stub.

### Routes Covered
- `GET /spu/documents/repository` — file repository list
- `GET /spu/documents/upload` — upload form
- `POST /spu/documents/upload` — file upload
- `GET /spu/documents/build-logs` — production run build logs
- `GET /spu/documents/box` — Box.com integration page (stub)

### Contract References
**GET /spu/documents/repository returns:**
```typescript
{
  documents: {
    id: string, title: string, fileName: string, fileType: string,
    fileSize: number, category: string | null, uploadedAt: Date,
    uploadedByUsername: string, url: string
  }[]
}
```

### MongoDB Models Used
- `DocumentRepository` — file metadata
- `File` — raw file records
- `ProductionRun` — for build logs
- `Integration` — for Box.com connection status (type: 'box')

### MongoDB-Specific Notes
- Box.com integration is **deferred** — implement as a stub that shows connection status but doesn't do actual Box API calls
- File upload: store file metadata in `document_repository`, actual file in Supabase Storage or local filesystem
- Build logs come from `ProductionRun` collection

### Acceptance Criteria
- Tests 7-8 in `05-documents.test.ts` pass (repository, build logs)
- File upload works
- Box page loads (stub is fine)
