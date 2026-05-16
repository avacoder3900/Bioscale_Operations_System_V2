# CV Refactor — Monday Quick-Start

**Branch:** `feature/cv-followups`
**Latest commit:** `163a8c4`
**Vercel preview:** look for the `feature/cv-followups` deployment

A guide for picking this back up on Monday. Skim the top sections, dive deeper as needed.

---

## TL;DR — what changed

The CV system was project-first (every image required a project). It is now **cartridge-first**: images belong to cartridges, projects are composable training sets that own deployable models.

Old mental model that no longer applies:
- "I capture an image → it goes into project X" ❌
- "Induct a cartridge from CV scan" ❌
- "Label is what makes an image meaningful" ❌
- "Master model is a special singleton" ❌

New mental model:
- "I capture an image of cartridge X at phase Y" ✓
- "Cartridges only enter the system through manufacturing (backing/wax-fill)" ✓
- "Labels are an optional QC field; images exist without them" ✓
- "A 'master' is just a project that composedOf every other project" ✓

---

## What's live on the preview

| Page | URL | State |
|---|---|---|
| Capture station | `/capture` | ✅ Functional. Scan + photo + sticky context. |
| Image stream | `/cv/stream` | ✅ All 1,445 existing images, chronological, filterable. |
| Label search | `/cv/label` | ✅ Search cartridges by any field, bulk label, add to project. |
| Project list | `/cv/projects` | ✅ Empty initially (post-wipe). Create new from this page. |
| Project detail | `/cv/projects/[id]` | ✅ Members \| Composition \| Deployment \| History tabs. |
| Cartridge DHR | `/cartridge-admin/dhr/[id]` | ✅ Unchanged. Shows all photos for a cartridge. |
| `/cv` | redirects to `/cv/stream` | ✅ |

## What's NOT verified end-to-end

| Concern | Why it matters | Mitigation |
|---|---|---|
| CV worker reachable from Vercel | Training and inference 502 if `CV_WORKER_URL` isn't pointing at a running worker. **Capture itself still works.** | Verify `CV_WORKER_URL` on Vercel; spin up `services/cv-worker/main.py` somewhere reachable. |
| Hardware USB scanner behavior | I built for keyboard-wedge mode (scanner types into hidden input, Enter triggers lookup). Untested with your specific scanner. | Plug in, scan a real cartridge ID at `/capture`; if focus mis-behaves, tweak `refocusScanner()` interval. |
| Python `camera_capture.py` against new endpoint | Backwards-compat preserved BUT now rejects QRs for cartridges not in BIMS (no auto-induct). | Try one capture from the bench; if it 400s, the cartridge needs upstream registration first. |
| Manufacturing inline buttons | `CaptureButton` component exists but isn't wired into wax-fill / reagent-fill / top-seal pages. | One-liner per page: `<CaptureButton cartridgeId={x} phase="wax_filled" />` |
| R&D forensic capture | Planned at `/cv/forensic-capture` (phase=`post_run`). Not built. | Use `/capture` with phase=`post_run` as workaround. |
| Browser camera permissions | First visit to `/capture` will prompt. | Allow; if denied, page still loads but capture button is disabled. |

---

## Mongo state right now

| Collection | Count | Notes |
|---|---|---|
| `cv_projects` | 0 | Wiped on 2026-05-16. Recreate as needed. |
| `cv_images` | 1,445 | All have `projectId: null`. 581 have a cartridgeTag + cartridgeImageNumber. 100 have `qcLabel` set. |
| `cv_inspections` | 0 | Never used in production; clean slate. |
| `cartridge_records` | 11,607 | Each has `photoSequence: 0+` (initialized; incremented on each capture). |
| `cv_samples` | 0 | Dead concept. Don't use. |
| `lab_cartridges` | 0 | Deleted model. Don't use. |

The pre-wipe project-to-image membership is preserved at `docs/CV-PROJECT-LEDGER-2026-05-16T02-41-34.md` — 1760 lines, every image accounted for. If you ever regret the wipe, training sets can be rebuilt from this ledger by hand.

---

## How to test each piece (Monday morning checklist)

### 1. `/capture` end-to-end (5 min)

1. Open `/capture` in Chrome on a workstation with a USB barcode scanner attached.
2. Camera permission prompt → allow.
3. Scan a real cartridge barcode that EXISTS in BIMS. Banner should turn green: "Locked on CART-XXX — N prior photos".
4. Press Space (or click "📷 Capture (Space)"). Photo should appear in the "Just captured" strip within ~2s.
5. Take a second photo of the same cartridge — `_002` should mint.
6. Scan a different cartridge → context should flip.
7. Scan a fake cartridge → red banner, no save.

If something doesn't work, look at:
- Browser console for camera errors
- Network tab for `/api/cv/capture` request/response
- Mongo `cv_images` collection for the new doc
- Mongo `cartridge_records.photoSequence` for the bumped counter

### 2. `/cv/stream` (1 min)

1. Open `/cv/stream` — should see the most recent 48 images (including the ones you just captured).
2. Filter by phase or cartridge ID; verify pagination works.
3. Click a thumbnail → lightbox. Arrow keys navigate. Escape closes.

### 3. `/cv/label` flow (3 min)

1. Open `/cv/label`.
2. Set "Image label" filter to "Unlabeled" → Search.
3. Click 3–4 thumbnails to select them.
4. Click "✓ Approve N" → labels saved. Banner confirms.
5. Refresh — labels stick.

### 4. Project + training round-trip (10 min, requires cv-worker)

1. `/cv/projects` → "+ New project" → "Wax Fill QC".
2. From `/cv/label`, filter to images at phase wax_filled, approve ~5–10 of them, reject ~3.
3. Same /cv/label result — select them all, "Add to project" → Wax Fill QC.
4. Go to `/cv/projects/[wax-fill-qc-id]` → Members tab. Should see the images.
5. Deployment tab → check the `wax_filled` phase under "Deploy at phases" → Save deployment.
6. POST to `/api/cv/train` with `{"projectId":"...wax-fill-qc-id..."}` (curl or Postman). Should append a `trainedModels[]` entry and kick the worker.
7. After worker finishes (poll `GET /api/cv/train?projectId=...`), go back to Deployment tab, set the new version as activeModelVersion, Save.
8. Now scan + capture a new wax_filled cartridge at `/capture` → check the History tab on the project; a new `CvInspection` row should appear within seconds.

### 5. A/B shadow mode (when ready)

1. After step 4 succeeds, train a second time (different sample set or just again to get v2).
2. Deployment tab → set activeModelVersion to v1, shadowModelVersion to v2.
3. New captures at wax_filled produce TWO CvInspection rows each (one with `isShadow: false`, one with `true`).
4. Operator can promote v2 by swapping the dropdowns; old inspections are preserved with their `modelVersion` so audit replay works.

---

## Key file paths

### Schemas
- `src/lib/server/db/models/cv-image.ts` — image identity = cartridgeTag + capturedAt + cartridgeImageNumber
- `src/lib/server/db/models/cv-project.ts` — members, composedOf, deployAtPhases, trainedModels[], activeModelVersion, shadowModelVersion
- `src/lib/server/db/models/cv-inspection.ts` — modelVersion + modelPath + isShadow per inspection
- `src/lib/server/db/models/cartridge-record.ts` — photoSequence atomic counter

### Endpoints
- `src/routes/api/cv/capture/+server.ts` — single-call capture
- `src/routes/api/cv/capture-ingest/+server.ts` — Python script backwards-compat
- `src/routes/api/cv/images/presign/+server.ts` + `record/+server.ts` — legacy two-step (still works)
- `src/routes/api/cv/images/[id]/label/+server.ts` — qcLabel setter
- `src/routes/api/cv/images/[id]/link-cartridge/+server.ts` — retroactive cartridge linking
- `src/routes/api/cv/lookup-cartridge/+server.ts` — does this cartridge exist?
- `src/routes/api/cv/train/+server.ts` — versioned training kickoff
- `src/routes/api/cv/infer/+server.ts` — manual one-off inference
- `src/routes/api/cv/projects/+server.ts` + `[id]/+server.ts` — project CRUD

### Pages
- `src/routes/capture/+page.{server.ts,svelte}` — capture station
- `src/routes/cv/stream/+page.{server.ts,svelte}` — chronological gallery
- `src/routes/cv/label/+page.{server.ts,svelte}` — search-driven labeling
- `src/routes/cv/projects/+page.{server.ts,svelte}` — project list
- `src/routes/cv/projects/[id]/+page.{server.ts,svelte}` — project detail (4 tabs)

### Helpers / services
- `src/lib/server/cv/resolve-project-members.ts` — recursive composition (depth 5, cycle-safe)
- `src/lib/server/cv/run-inference.ts` — `runInferenceForProject` + `runPhaseInference`
- `src/lib/server/services/cv-bridge.ts` — HTTP client for Python cv-worker
- `src/lib/server/services/r2.ts` — R2 uploads via Cloudflare Worker proxy

### Components
- `src/lib/components/cv/CaptureButton.svelte` — drop-in inline capture button

### Scripts (one-offs, run as needed)
- `scripts/audit-lab-cartridges.ts` — survey LabCartridge / FirmwareCartridge / CartridgeGroup state
- `scripts/wipe-cv-projects-cartridge-first.ts` — already ran 2026-05-16; produced the project ledger
- `scripts/migrate-cv-image-model.ts` — already applied; idempotent so safe to re-run for verification

### PRDs (source of truth for design decisions)
- `docs/prds/CV-REFACTOR-1-IMAGE-MODEL.md`
- `docs/prds/CV-REFACTOR-2-CAPTURE-PIPELINE.md`
- `docs/prds/CV-REFACTOR-3-PROJECT-AS-MODEL.md`
- `docs/prds/CV-REFACTOR-4-ADMIN-UIS.md`

---

## Deliberate decisions / why things are this way

| Decision | Rationale |
|---|---|
| Images don't have a `projectId` field at all | Project membership is a curation act, not an identity property. Membership lives on `CvProject.members[]`. |
| Labels demoted to optional `qcLabel` | An image is meaningful as soon as it's captured — labels come later, sparsely (today only 7% of images are labeled). |
| Induction killed | A CV camera scanning a fresh QR shouldn't conjure a CartridgeRecord. If a cartridge isn't registered, that's an upstream gap to fix, not a CV-side workaround. |
| `cartridgeImageNumber` is denormalized human-readable string | `_id` stays as nanoid for stability. The number (`CART-X_001`) is for display + R2 filenames + log readability. Atomic `$inc` on `CartridgeRecord.photoSequence` prevents collisions. |
| Master model is just a regular composed project | One less special case in the schema; flexible — operator can create OTHER aggregator projects (e.g., "all wax stages combined"). |
| trainedModels[] is append-only | Compliance + DHR replay. We must be able to answer "which model passed this cartridge" forever. Old ONNX files in R2 stay forever; new ones get new keys. |
| Shadow inference creates parallel CvInspection rows | Both decisions captured, with `isShadow: true` flag distinguishing. Lets operators compare v1 vs v2 over the same captures without affecting production decisions. |
| Hardware QR scanner replaces in-browser jsQR | jsQR is slow (~500ms poll) and unreliable on small phone-camera-quality streams. USB scanners are instant + 100% accurate in hardware. The scan event IS the photo trigger. |
| Capture endpoint is multipart, fire-and-forget on inference | Operator never waits on cv-worker. Photo lands in <2s; inference shows up later in the project History tab. |

---

## Known gotchas / where I cut corners

1. **`CaptureButton` not wired into manufacturing pages.** Component exists, drop-in is trivial, but I didn't want to guess at placement on the wax-fill / reagent-fill / top-seal WI pages — they're operator-facing and need eyeballed UX. Add this Monday.

2. **No CV contract tests.** The codebase has 84 contract tests; none cover CV. Adding tests would be a separate PR. For now: the schema is small enough that smoke-testing via the UIs is reasonable.

3. **Permissions are lenient.** All CV endpoints check `locals.user` only (not a specific `cv:*` permission). The pre-refactor CV pages worked the same way. Hardening is a separate concern.

4. **No project-soft-delete.** Deleting a project from `/cv/projects/[id]` is permanent (the project doc is gone). Images aren't touched, but if an inspection referenced a deleted project, that inspection is orphaned. Workaround: rename the project to "[ARCHIVED] X" instead of deleting.

5. **Phase enum is open.** `cartridgeTag.phase` is just a String. The `/capture` dropdown lists common values, but the API accepts any string. Operators could type "post_run" or "wax_filled" or anything — no validation.

6. **Composition cycle handling is silent.** If you accidentally set up A → composedOf B and B → composedOf A with live composition on, the resolver silently breaks the cycle (returns what it found, lists skipped in `cycleSkipped`). Doesn't error. UI doesn't warn yet.

7. **Old `/cv/projects/[id]` URL muscle memory is dead.** Anyone with bookmarks pointing to the legacy capture station inside a project now sees the new training-set view. The capture station moved to `/capture`.

---

## If you need to roll back

The branch is `feature/cv-followups`. To get back to dev as it was:

```bash
git checkout dev
```

The cv worktree's branch keeps everything. To undo the Mongo state:
1. `cv_projects` is empty — recreating projects manually is the only path. The pre-wipe ledger has full content.
2. `cv_images.projectId` is null — to "restore" projectIds, you'd re-process the ledger and `$set` projectId on each image. There's no script for this; you'd write one.
3. `cv_images.label` is gone (renamed to `qcLabel`). Reverse with `$rename qcLabel → label` if needed.

Practically: forward is easier than back. The cleanup was thorough on purpose.

---

## What I'd tackle first on Monday (suggested)

1. **Verify `/capture` works with your USB scanner** (5 min). If it does, you've validated the most important piece end-to-end.
2. **Verify `cv-worker` is reachable from Vercel** (check `CV_WORKER_URL` env var; hit `${URL}/health`). If it isn't, training + inference will need infra work.
3. **Wire `CaptureButton` into wax-filling page** (one-line component drop-in). Operator gets immediate value: photo from the WI without context-switching.
4. **First real-world training round** — capture 10–20 wax-fill photos, label them in `/cv/label`, create a "Wax Fill QC" project, add them, train. See if the model produces sensible scores.
5. **Decide on the post_run R&D capture flow.** PRD 2 has the spec; could build it Monday afternoon if you want it for the next R&D batch.

That's a half-day of validation and gives you ground truth on the whole stack.
