# PRD: CV Refactor — Admin UIs

**Author:** Jacob Quick (decisions) + Claude (drafted)
**Date:** 2026-05-16
**Status:** Draft → ready to implement
**Priority:** P1 — needed so the new schema is actually usable
**Branch:** `feature/cv-followups`
**Depends on:** [PRD 1 — Image Model](./CV-REFACTOR-1-IMAGE-MODEL.md)

---

## 1. Problem

After the refactor, images are cartridge-first and project-agnostic. The old UIs (`/cv/projects/[id]`, `/cv/gallery`, `/cv/inspect`, `/cv/master`) were project-centric and no longer make sense. We need three new admin surfaces:

1. **`/cv/stream`** — chronological feed of every image regardless of project or source. The "look at what's coming in" view.
2. **`/cv/label`** — operator labels images by querying cartridges via arbitrary CartridgeRecord fields (assay, run, operator, date, status, lot, phase, etc.). Bulk-apply qcLabel.
3. **`/cv/projects` (rebuilt)** — list of projects (training sets). Click into project to view/edit members, configure composition, see training history, manage deployment.

## 2. Decisions

| # | Decision |
|---|---|
| 1 | **`/cv/stream` is the new default landing.** Replaces what `/cv/gallery` and `/cv/master` were doing. |
| 2 | **`/cv/label` is the only place to apply qcLabel.** Capture page never labels; manufacturing pages never label. |
| 3 | **Search is server-driven, paginated.** Filters compile to a Mongo aggregation; results stream back at 48/page. |
| 4 | **Existing pages get retired:** `/cv/gallery`, `/cv/inspect`, `/cv/history`, `/cv/master`, `/cv/training`. Delete or redirect. |
| 5 | **`/cv/projects` becomes the project browser**, not the capture station. Capture moves entirely to `/capture` (PRD 2). |

## 3. `/cv/stream` — chronological gallery

### Behavior
- Loads images sorted by `capturedAt` desc.
- Pagination: 48 per page, infinite-scroll or "Load more" button.
- Filters across the top: phase, cartridgeId, date range, qcLabel ("any | approved | rejected | unlabeled").
- Each thumbnail shows:
  - The image (R2-served via worker)
  - Cartridge chip (`CART-000123`)
  - Phase chip (`wax_filled`)
  - qcLabel chip if set
  - `cartridgeImageNumber` (`_001`, `_002`, etc.)
  - Captured-at relative time ("3m ago")
- Click thumbnail → lightbox with full image + metadata + nav to next/prev.

### Layout

```
┌──────────────────────────────────────────────────────────────────┐
│  /cv/stream                                                       │
│                                                                  │
│  Filters: [Phase ▾] [Cartridge ▾] [Date ▾] [Label ▾]   [Reset]   │
│                                                                  │
│  Today                                                           │
│  ┌────┐ ┌────┐ ┌────┐ ┌────┐ ┌────┐ ┌────┐ ┌────┐ ┌────┐         │
│  │ img│ │ img│ │ img│ │ img│ │ img│ │ img│ │ img│ │ img│         │
│  │CART│ │CART│ │CART│ │CART│ │CART│ │CART│ │CART│ │CART│         │
│  │_001│ │_002│ │_001│ │_001│ │_002│ │_003│ │_001│ │_001│         │
│  │wax │ │wax │ │seal│ │seal│ │seal│ │rgnt│ │rgnt│ │rgnt│         │
│  └────┘ └────┘ └────┘ └────┘ └────┘ └────┘ └────┘ └────┘         │
│                                                                  │
│  Yesterday                                                       │
│  ┌────┐ ┌────┐ ...                                               │
│                                                                  │
│  [Load more]                                                     │
└──────────────────────────────────────────────────────────────────┘
```

### Loader

```typescript
// /cv/stream/+page.server.ts
export const load: PageServerLoad = async ({ url, locals }) => {
  requirePermission(locals.user, 'cv:read');
  await connectDB();

  const phase = url.searchParams.get('phase');
  const cartridgeId = url.searchParams.get('cartridge');
  const labelFilter = url.searchParams.get('label'); // approved | rejected | unlabeled
  const fromDate = url.searchParams.get('from');
  const toDate = url.searchParams.get('to');
  const page = parseInt(url.searchParams.get('page') || '1');
  const limit = 48;

  const filter: any = {};
  if (phase) filter['cartridgeTag.phase'] = phase;
  if (cartridgeId) filter['cartridgeTag.cartridgeRecordId'] = { $regex: cartridgeId, $options: 'i' };
  if (labelFilter === 'unlabeled') filter.qcLabel = null;
  else if (labelFilter === 'approved' || labelFilter === 'rejected') filter.qcLabel = labelFilter;
  if (fromDate || toDate) {
    filter.capturedAt = {};
    if (fromDate) filter.capturedAt.$gte = new Date(fromDate);
    if (toDate) filter.capturedAt.$lte = new Date(toDate);
  }

  const [images, total] = await Promise.all([
    CvImage.find(filter).sort({ capturedAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
    CvImage.countDocuments(filter)
  ]);

  return {
    images: JSON.parse(JSON.stringify(images)),
    total,
    page,
    totalPages: Math.ceil(total / limit),
    filters: { phase, cartridgeId, labelFilter, fromDate, toDate }
  };
};
```

## 4. `/cv/label` — search-driven labeling

### Behavior

The killer feature: **filter cartridges by arbitrary CartridgeRecord fields**, then bulk-label all their photos.

Example operator flows:
- "Show me all cartridges from run RUN-42 → I want to mark their wax-fill photos as approved/rejected."
- "Show me all cartridges with assay CRP from last week."
- "Show me all cartridges that failed at top-seal QC."
- "Show me all cartridges from operator alejandro, today."

### Layout

```
┌────────────────────────────────────────────────────────────────────┐
│  /cv/label — Search & Label                                         │
│                                                                    │
│  ┌──────────────────────────────────────────────────────────┐      │
│  │  Build cartridge filter                                   │      │
│  │                                                          │      │
│  │  Assay         [CRP            ▾]                        │      │
│  │  Wax run       [Any            ▾]                        │      │
│  │  Reagent run   [Any            ▾]                        │      │
│  │  Operator      [Any            ▾]                        │      │
│  │  Status        [Any            ▾]                        │      │
│  │  Date          [2026-05-01 → 2026-05-16]                 │      │
│  │  Phase (image) [wax_filled     ▾]                        │      │
│  │  qcLabel       [Unlabeled      ▾]                        │      │
│  │                                                          │      │
│  │  [+ Add custom field filter]                             │      │
│  │                                                          │      │
│  │                                              [ Search ]  │      │
│  └──────────────────────────────────────────────────────────┘      │
│                                                                    │
│  47 cartridges, 132 photos                                         │
│                                                                    │
│  ☐ Select all on this page                                         │
│  ┌────┐ ┌────┐ ┌────┐ ┌────┐ ┌────┐ ┌────┐                         │
│  │ ☑  │ │ ☑  │ │ ☐  │ │ ☐  │ │ ☑  │ │ ☐  │                         │
│  │img │ │img │ │img │ │img │ │img │ │img │                         │
│  │CART│ │CART│ │CART│ │CART│ │CART│ │CART│                         │
│  │_001│ │_001│ │_002│ │_001│ │_001│ │_001│                         │
│  └────┘ └────┘ └────┘ └────┘ └────┘ └────┘                         │
│                                                                    │
│  Bulk actions:                                                     │
│  [Approve selected] [Reject selected] [Clear label]                │
│  [Add selected to project ▾]                                       │
└────────────────────────────────────────────────────────────────────┘
```

### Filter compilation

CartridgeRecord field filters are joined into the CvImage query via a two-step:

1. Query `CartridgeRecord` matching the cartridge filters, project `_id` only.
2. Use that cartridge ID list in the `CvImage` query: `filter['cartridgeTag.cartridgeRecordId'] = { $in: ids }`.

```typescript
async function buildImageFilterFromCartridgeFilter(cartridgeFilter: any, imageFilter: any) {
  if (Object.keys(cartridgeFilter).length > 0) {
    const matching = await CartridgeRecord.find(cartridgeFilter).select('_id').lean();
    imageFilter['cartridgeTag.cartridgeRecordId'] = { $in: matching.map(c => c._id) };
  }
  return imageFilter;
}
```

### Form action: bulk label

```typescript
// /cv/label/+page.server.ts
actions = {
  bulkLabel: async ({ request, locals }) => {
    requirePermission(locals.user, 'cv:write');
    const form = await request.formData();
    const imageIds = form.getAll('imageId').map(String);
    const label = form.get('label')?.toString(); // 'approved' | 'rejected' | 'clear'
    const newLabel = label === 'clear' ? null : label;

    await CvImage.updateMany(
      { _id: { $in: imageIds } },
      {
        $set: {
          qcLabel: newLabel,
          qcLabeledBy: { _id: locals.user._id, username: locals.user.username },
          qcLabeledAt: new Date()
        }
      }
    );

    // Audit log per change
    for (const id of imageIds) {
      await AuditLog.create({ ... }); // batched ideally
    }

    return { success: true, updated: imageIds.length };
  },

  addToProject: async ({ request, locals }) => { /* push imageIds into project.members */ }
}
```

## 5. `/cv/projects` — rebuilt project browser

### List view

```
┌────────────────────────────────────────────────────────────────────┐
│  /cv/projects                                       [ + New ]      │
│                                                                    │
│  ┌──────────────────────────────────────────────────────────┐      │
│  │ Wax Fill QC                                              │      │
│  │ 168 images · trained · deploys at wax_filled · active v2 │      │
│  └──────────────────────────────────────────────────────────┘      │
│  ┌──────────────────────────────────────────────────────────┐      │
│  │ Reagent Fill QC                                          │      │
│  │ 90 images · untrained · no deployment                    │      │
│  └──────────────────────────────────────────────────────────┘      │
│  ...                                                               │
└────────────────────────────────────────────────────────────────────┘
```

### Project detail tabs (`/cv/projects/[id]`)

| Tab | Contents |
|---|---|
| **Members** | Grid of all images in `members[]` (and live-composed children if applicable). Add/remove via checkboxes + "Remove from project" / "Add from /cv/label". |
| **Composition** | `composedOf[]` configuration. Toggle `isLiveComposition`. Pick child projects from a list. |
| **Training** | "Train new model" button. Shows current `modelStatus`. Tail of training log. |
| **Deployment** | `deployAtPhases[]` checkboxes. `activeModelVersion` dropdown (pick from `trainedModels[]`). `shadowModelVersion` dropdown. Promote/demote actions. |
| **History** | `trainedModels[]` table: version, trained-at, sample count, performance metrics if available. Click to inspect. |
| **Recent inspections** | Latest CvInspection results for this project. |

## 6. Files

### New routes

| File | Purpose |
|---|---|
| `src/routes/cv/stream/+page.server.ts` | Chronological feed loader |
| `src/routes/cv/stream/+page.svelte` | Gallery UI |
| `src/routes/cv/label/+page.server.ts` | Search + bulk label loader + actions |
| `src/routes/cv/label/+page.svelte` | Search & label UI |
| `src/routes/cv/projects/+page.server.ts` | UPDATE — list with new schema |
| `src/routes/cv/projects/+page.svelte` | UPDATE — project list rendering |
| `src/routes/cv/projects/[id]/+page.server.ts` | REBUILD — project detail with tabs |
| `src/routes/cv/projects/[id]/+page.svelte` | REBUILD — Members/Composition/Training/Deployment/History tabs |

### Deletes / redirects

| Path | Action |
|---|---|
| `src/routes/cv/gallery/` | DELETE — replaced by `/cv/stream` |
| `src/routes/cv/inspect/` | DELETE — manual inspection moves to per-image action in `/cv/stream` |
| `src/routes/cv/history/` | DELETE — replaced by `/cv/stream` + CvInspection list per project |
| `src/routes/cv/master/` | DELETE — master is now just a regular composed project |
| `src/routes/cv/training/` | DELETE — training is per-project under `/cv/projects/[id]?tab=training` |

### Nav

| File | Update |
|---|---|
| `src/routes/+layout.svelte` | Update Cartridges / CV nav entries: add Stream, Label, Projects, Capture |
| `src/routes/cv/+layout.svelte` | Update sidebar tabs |

## 7. Implementation order

1. Build `/cv/stream` first — pure read, no schema dependencies beyond PRD 1. Lowest risk.
2. Build `/cv/label` second — needs cartridge-record filtering, more complex.
3. Rebuild `/cv/projects` list (third).
4. Rebuild `/cv/projects/[id]` detail tabs (fourth, biggest UI lift).
5. Delete retired routes + redirect nav links.
6. Type-check + visual QA on preview deploy.

## 8. Acceptance

- [ ] `/cv/stream` loads all 1,445 images chronologically, paginates without crashing on the first day.
- [ ] Filter combinations on `/cv/stream` produce correct image subsets.
- [ ] Clicking a thumbnail opens lightbox; navigation works.
- [ ] `/cv/label` filter on assay/run/operator/date returns matching cartridges and shows their photos.
- [ ] Bulk-approve writes `qcLabel` + `qcLabeledBy` + `qcLabeledAt` on every selected image.
- [ ] Bulk "Add to project" pushes imageIds into `project.members[]`.
- [ ] `/cv/projects` lists projects with member counts, model status, deployment summary.
- [ ] Project detail page tabs all functional; promote/set-shadow buttons hit the right endpoints.
- [ ] `/cv/gallery`, `/cv/inspect`, `/cv/history`, `/cv/master`, `/cv/training` return 404 (or redirect cleanly).
- [ ] Sidebar nav reflects the new structure.

## 9. Out of scope

- Image-level inspections triggered from `/cv/stream` (could be a follow-up — "Run inspection" button per image).
- Per-project performance dashboards (precision/recall/false-positive rate over time).
- Side-by-side model version comparison ("v1 vs v2 on the same 100 images").
- Importing labels from external sources.
