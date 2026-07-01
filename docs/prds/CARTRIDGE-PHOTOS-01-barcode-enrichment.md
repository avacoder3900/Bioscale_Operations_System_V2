# PRD: Cartridge Photos, Tags & Notes on Every Barcode in brevitest-research

## 1. Title + one-line summary

**Cartridge Barcode Enrichment** — Wherever a cartridge barcode is shown in the brevitest-research app, render a reusable card that displays the barcode plus its BIMS-sourced tags, notes, and R2 photos grouped by the capture STATE (phase) in which each photo was taken.

---

## 2. Background & problem

In brevitest-research a "cartridge" is a CouchDB document whose `_id` **is** the scanned barcode/UUID string (`src/lib/types.ts` `Cartridge`; `src/lib/library/globals.ts` `patterns.cartridge`). Barcodes surface in at least four UI locations, but always as bare text or a raw JSON dump — no visual context, no photos, no provenance.

Separately, the BIMS Operations System V2 (production, `master` branch) runs a computer-vision capture pipeline that photographs each physical cartridge at multiple manufacturing/QC states and stores those images in Cloudflare R2, keyed by the **same** cartridge `_id`/barcode. Those photos, along with per-image tags (labels) and notes, are invisible to research users today.

The research app's own `Cartridge.photos: { [index: string]: string }` map exists in the type but is never fetched or rendered — the cartridge detail page just dumps the whole document into a `<JSONEditor>`. There are no `tags` or `notes` fields on the research cartridge at all.

**Problem:** Researchers looking at a barcode cannot see what the cartridge physically looked like at each production state, nor any QC tags/notes captured during manufacturing. The rich BIMS photo/tag/note data is stranded in another app.

---

## 3. Goals / Non-goals

### Goals
- Show, next to **every** barcode in the research app, a compact card with: the barcode, its tags, its notes, and a per-state photo strip.
- Pull photos + tags + notes from BIMS R2/Mongo by barcode (= cartridge `_id`), **grouped by capture state (phase)**.
- Build **one** reusable Svelte component used at all barcode display sites (single source of truth for barcode rendering).
- Introduce **one** research-app server endpoint that fetches/normalizes photos-by-state (plus tags/notes) from BIMS, so the browser never talks to BIMS directly.
- Keep image bytes served from R2's already-public Worker URLs (no proxying of bytes unless required).
- Degrade gracefully: if BIMS is unreachable or a barcode has no photos, the card still renders the barcode/tags/notes it does have.

### Non-goals
- No capture/upload of photos from the research app (read-only consumption).
- No changes to the BIMS capture pipeline itself.
- No wiring of the orphaned `LabelsCartridges.svelte` DataMatrix print sheet (tracked as an open question, not in scope).
- No migration of photos into CouchDB; photos remain in R2/BIMS and are referenced by URL.
- No editing of tags/notes from the research app in v1 (display only).

---

## 4. Current state (what exists today — cite files)

**Persistence & backend (research app):**
- `src/lib/server/couchdb.ts` — CouchDB HTTP layer (`fetchDocumentById(db, id)`, `bulkLoadDocuments`, etc.). Cartridges live in the `'research'` DB, keyed by `_id`.
- `src/lib/server/box.ts` — Box.com blob store (Excel workbooks only; not images). Closest template for streaming binary from an external store (`getClient()` singleton + `downloads.downloadFile()`).
- `src/lib/server/server.ts` — higher-level loaders (`loadCartridges`, `loadUser`, `getCartridgeAttributes`).
- `src/lib/library/client.ts` — client-side helpers that POST to `/api/*` (e.g. `loadExperimentArmCartridges`, `addCartridgeToArm`). Pattern to mirror for a new photo helper.
- `src/routes/api/create-document/+server.ts`, `src/routes/api/remove-experiment-arm/+server.ts` — canonical `/api` endpoint shape: `export async function POST({ request })`, `await request.json()`, return `json({ success, ... })`. **No API-key check** on internal endpoints; they are same-origin only. There is **no** `hooks.server.ts`; `src/app.d.ts` is an empty stub. Page auth is cookie-based (`cookies.get('userEmail')`).

**Types:**
- `src/lib/types.ts` — `Cartridge` (has `photos: { [index: string]: string }`; **no** `barcode`, `tags`, or `notes`), `FetchedCartridge` (list shape, **no** `photos`), `ArmCartridge` (`{ barcode, status, quantity }` — the only literal `barcode` field, referencing the cartridge `_id`), `ExperimentArm`, `Experiment`.
- `src/lib/attributes.js` — confirms no `barcode`/`tags`/`notes` cartridge attributes; only `device.notes` exists.

**Barcode display sites (integration points):**
1. `src/routes/experiment/+page.svelte` — arm cartridge rows render `{cartridge.barcode}` as centered text (the main arms view). Scan entry via `handleKeyPress` → `addCartridgeToArm`. `src/routes/experiment/+page.server.ts` loads the experiment and flat-maps `arm.cartridges → cartridge.barcode`.
2. `src/routes/cartridges/+page.svelte` — list rows render `{cartridge._id}` (the barcode) + program/arm/assay/status, linking to `/cartridge?id={cartridge._id}`. Loaded by `src/routes/cartridges/+page.server.ts` (`loadCartridges` → `cartridgeMap`).
3. `src/routes/cartridge/+page.svelte` — detail page; dumps the full cartridge doc (incl. `photos`) into a `<JSONEditor>`. `src/routes/cartridge/+page.server.ts` loads it via `fetchDocumentById('research', id)` (full doc, includes `photos`).
4. `src/routes/analysis/+page.svelte` — "Completed Cartridges" panel renders each `{cartridge._id}` as a chip; barcodes loaded via `src/routes/api/load-experiment-arm-cartridges/+server.ts` (`bulkLoadDocuments` returns full docs).
5. `src/lib/component/label/LabelsCartridges.svelte` — the only scannable-graphic renderer (bwip-js DataMatrix). **Orphaned** (imported by no route). Out of scope.

**BIMS photo model (production = `master` branch):**
- Cartridge barcode = `CartridgeRecord._id` (`src/lib/server/db/models/cartridge-record.ts`, master). `photos[]` elements: `{ imageId, phase, capturedAt, r2Key, r2Url, cartridgeImageNumber }`; plus `photoSequence` counter and `notes[]` (`{ _id, body, phase, author, createdAt }`).
- `src/lib/server/db/models/cv-image.ts` (master) — `cv_images` collection, queried by `cartridgeTag.cartridgeRecordId` (indexed); carries `cartridgeTag.phase`, `cartridgeTag.labels[]`, `cartridgeTag.notes`, `imageUrl`, `thumbnailPath`, `qcLabel`.
- `src/lib/server/services/r2.ts` (master) — `getR2Url(key)` → `${R2_WORKER_URL}/file/{key}` (public GET) or `${R2_PUBLIC_URL}/{key}`. Stored `r2Url`/`imageUrl` are **directly fetchable without signing**.
- Existing photos-by-barcode endpoints, **all session-cookie gated** (no API key): `GET /api/cartridge-admin/dhr/[cartridgeId]` (best fit — returns `timeline[].photos` grouped by phase + flat `photos[]`), `GET /api/traceability/cartridge/[cartridgeId]`, `GET /api/cv/lookup-cartridge?code=`.

> **Branch caveat:** The photo pipeline exists only on `master` (production), not on the current `spudashchange-stalefork` branch. Any BIMS-side endpoint work must target `master`.

---

## 5. Proposed solution

### 5.1 Architecture / data flow

```
Browser (research app UI)
        │  (same-origin fetch, cookie auth)
        ▼
research: GET /api/cartridge-photos?barcode=<id>   ◄── NEW research endpoint
        │  (server-to-server, x-api-key: AGENT_API_KEY)
        ▼
BIMS(master): GET /api/agent/cartridge/{barcode}/photos   ◄── NEW BIMS agent endpoint
        │  CartridgeRecord.findById(barcode) → photos[]/notes[] + CvImage tags
        ▼
returns { barcode, photosByState, tags[], notes[] }  (r2Url values are PUBLIC)
        │
Browser renders <img src={r2Url}> directly from R2 Worker /file  (bytes bypass both servers)
```

Two new endpoints and one new shared component:

1. **BIMS agent endpoint (on `master`)** — `GET /api/agent/cartridge/[barcode]/photos`, guarded by `AGENT_API_KEY` (header `x-api-key` / `x-agent-api-key`, per BIMS CLAUDE.md pattern). Does `connectDB()`, `CartridgeRecord.findById(barcode)`, reads `photos[]` and `notes[]`, augments with `cv_images` tags (`cartridgeTag.labels`, `cartridgeTag.notes`, `qcLabel`) by `cartridgeTag.cartridgeRecordId`, groups by `phase`, and returns the contract in §7. This is required because every existing BIMS photo endpoint is session-gated and the research app has no BIMS cookie.

2. **Research proxy endpoint** — `src/routes/api/cartridge-photos/+server.ts` (`GET`, mirroring the `create-document` shape). Reads `?barcode=`, calls the BIMS agent endpoint server-to-server with `AGENT_API_KEY` (kept server-side, never exposed to the browser), normalizes/caches the result, and returns `{ success, photosByState, tags, notes }`. This keeps the browser same-origin (matching current cookie auth) and keeps the BIMS key secret. Image **bytes** are still fetched directly by the browser from the public R2 Worker URLs — the proxy returns only JSON metadata + URLs, not binary.

3. **Shared component** — `src/lib/component/cartridge/BarcodeCard.svelte`, used at all four display sites, that renders the barcode + tags + notes + a per-state photo strip. It lazily calls `loadCartridgePhotos(barcode)` (new `client.ts` helper) on mount/hover so list views are not blocked on BIMS latency.

### 5.2 Photo source of truth
Prefer **`cv_images`** as the read source on the BIMS side (more complete; some legacy `cartridge_records.photos[]` were malformed and are self-healed by `/api/cv/capture`), falling back to the embedded `photos[]` when `cv_images` is empty. Merge both by `imageId`, dedupe, group by `phase`. (Decision flagged in §9.)

### 5.3 Caching
- **Server (research proxy):** in-memory `Map<barcode, { data, expiresAt }>` with a short TTL (default 5 min) to collapse repeated list-row fetches. R2 URLs are stable, so this is safe.
- **Client:** a module-level cache in `client.ts` keyed by barcode so re-rendering a barcode elsewhere in the same session is instant.
- **Images:** rely on browser HTTP caching of the public R2 Worker URLs; request `thumbnailUrl` in strips and full `r2Url`/`imageUrl` only on click/expand.
- **Lazy fetch:** `BarcodeCard` fetches photo metadata only when the card is expanded or scrolled into view (IntersectionObserver) in list contexts, to avoid N parallel BIMS calls on `/cartridges` and `/analysis`.

---

## 6. Detailed changes

### (a) Backend photo-fetch endpoints

| File | Create/Edit | Change |
|---|---|---|
| **BIMS (master)** `src/routes/api/agent/cartridge/[barcode]/photos/+server.ts` | Create | `GET` guarded by `AGENT_API_KEY` (`x-api-key`/`x-agent-api-key`). `connectDB()`; `CartridgeRecord.findById(params.barcode).select('photos notes')`; also query `CvImage.find({ 'cartridgeTag.cartridgeRecordId': barcode })`. Merge, group by `phase`, build response in §7. 401 on bad key, 404 if cartridge not found (still return empty `photosByState`). |
| **research** `src/routes/api/cartridge-photos/+server.ts` | Create | `GET({ url, cookies })`. Enforce existing cookie auth (`cookies.get('userEmail')`, else 401). Read `?barcode=`. Check server cache; on miss `fetch(`${BIMS_BASE_URL}/api/agent/cartridge/${barcode}/photos`, { headers: { 'x-api-key': AGENT_API_KEY } })`. Normalize + cache + `json({ success, barcode, photosByState, tags, notes })`. On BIMS error return `{ success: false, error }` with `photosByState: {}` so UI degrades. |
| **research** `src/lib/server/bims.ts` | Create | Thin helper module: `getCartridgePhotos(barcode)` encapsulating the outbound `fetch` + `AGENT_API_KEY` header + timeout + server-side cache. Mirrors the `box.ts` "external service singleton" style so the endpoint stays thin. |
| **research** `.env` / deploy secrets (`$env/static/private`) | Edit | Add `BIMS_BASE_URL` (prod BIMS origin) and `AGENT_API_KEY`. Read via `$env/static/private` exactly like `COUCHDB_BASEURL` / `BOX_CLIENT_ID`. |
| **research** `src/lib/library/client.ts` | Edit | Add `loadCartridgePhotos(barcode: string)` client helper that `fetch('/api/cartridge-photos?barcode=' + encodeURIComponent(barcode))`, mirroring `loadExperimentArmCartridges`. Add module-level per-barcode cache. |
| **research** `src/lib/types.ts` | Edit | Add `CartridgePhoto`, `CartridgePhotosByState`, `CartridgeTag`, `CartridgeNote`, and `CartridgePhotosResponse` interfaces (shapes in §7). Do **not** alter `Cartridge`/`FetchedCartridge`. |

### (b) Shared BarcodeCard / CartridgePhotos component

| File | Create/Edit | Change |
|---|---|---|
| **research** `src/lib/component/cartridge/BarcodeCard.svelte` | Create | Props: `{ barcode: string; variant?: 'chip' \| 'row' \| 'detail'; eager?: boolean }`. Renders barcode text (and, in `detail`, optionally a bwip-js DataMatrix reusing `LabelsCartridges` logic), a tags row, a notes list, and `<CartridgePhotos>`. Lazily calls `loadCartridgePhotos` (IntersectionObserver unless `eager`). Loading/empty/error states. |
| **research** `src/lib/component/cartridge/CartridgePhotos.svelte` | Create | Props: `{ photosByState: CartridgePhotosByState }`. Renders one horizontal photo strip **per state** with a state header (human-readable phase label), thumbnails (`thumbnailUrl` ?? `r2Url`), lightbox/expand to full `r2Url`, and `capturedAt`/`qcLabel` badges. |
| **research** `src/lib/library/phase-labels.ts` | Create | Map raw BIMS `phase` strings (`wax_filling`, `wax_qc`, `reagent_filling`, `reagent_inspection`, `top_seal`, `oven_cure`, `storage`, `qa_qc`, `shipping`, `post_run`, …) → display labels + a stable display order. Unknown phases fall back to titleized raw value. |

### (c) Barcode display sites to update

| File | Edit | Change |
|---|---|---|
| **research** `src/routes/experiment/+page.svelte` | Edit | Replace the plain `{cartridge.barcode}` text in each arm cartridge row with `<BarcodeCard barcode={cartridge.barcode} variant="row" />`. Preserve existing quantity-edit / remove handlers (they key off `cartridge.barcode`). |
| **research** `src/routes/cartridges/+page.svelte` | Edit | Replace `{cartridge._id}` text with `<BarcodeCard barcode={cartridge._id} variant="row" />`; keep the link to `/cartridge?id={cartridge._id}`. Lazy fetch so the long list is not blocked. |
| **research** `src/routes/cartridge/+page.svelte` | Edit | Above the existing `<JSONEditor>`, add `<BarcodeCard barcode={data.cartridge._id} variant="detail" eager />` so the detail page leads with the photo gallery + tags + notes. JSONEditor remains for raw inspection. |
| **research** `src/routes/analysis/+page.svelte` | Edit | Replace each `{cartridge._id}` chip in "Completed Cartridges" with `<BarcodeCard barcode={cartridge._id} variant="chip" />` (thumbnail-only compact mode). |
| **research** `src/routes/experiment/+page.server.ts`, `src/routes/analysis/+page.server.ts`, `src/routes/cartridges/+page.server.ts` | No change (preferred) | Photo fetch is lazy/client-side via the new endpoint, so server loaders are untouched. (Alternative eager path in §9.) |

---

## 7. Data contracts

### 7.1 BIMS agent endpoint
`GET /api/agent/cartridge/{barcode}/photos`
Headers: `x-api-key: <AGENT_API_KEY>` (or `x-agent-api-key`).

**200 response:**
```json
{
  "barcode": "b1f2c3d4-...",
  "found": true,
  "photosByState": {
    "wax_filling": [
      {
        "imageId": "cvimg_abc123",
        "phase": "wax_filling",
        "capturedAt": "2026-06-30T14:12:03.000Z",
        "r2Url": "https://<worker>/file/cv%2Fcaptures%2F...",
        "thumbnailUrl": "https://<worker>/file/cv%2Fcaptures%2F..._thumb",
        "cartridgeImageNumber": "b1f2c3d4-..._003",
        "qcLabel": "approved",
        "labels": ["bubble", "reviewed"],
        "note": "slight meniscus"
      }
    ],
    "reagent_inspection": [ /* … */ ]
  },
  "tags": ["bubble", "reviewed"],
  "notes": [
    { "body": "re-imaged after top seal", "phase": "top_seal", "author": "liza", "createdAt": "2026-06-30T15:01:00.000Z" }
  ]
}
```
- `404`-equivalent when the cartridge is unknown: `{ "barcode": "...", "found": false, "photosByState": {}, "tags": [], "notes": [] }` (HTTP 200 to keep the research proxy simple; `found: false` signals absence).
- `401 { "error": "Unauthorized" }` on bad/missing key.

### 7.2 Research proxy endpoint
`GET /api/cartridge-photos?barcode=<id>` (same-origin, cookie auth).

**Response:**
```json
{
  "success": true,
  "barcode": "b1f2c3d4-...",
  "photosByState": { "...": [ /* CartridgePhoto */ ] },
  "tags": ["..."],
  "notes": [ /* CartridgeNote */ ]
}
```
Failure: `{ "success": false, "error": "...", "photosByState": {}, "tags": [], "notes": [] }`.

### 7.3 TypeScript shapes (`src/lib/types.ts`)
```ts
export interface CartridgePhoto {
  imageId: string;
  phase: string;
  capturedAt: string;          // ISO
  r2Url: string;               // public, directly <img>-able
  thumbnailUrl?: string;
  cartridgeImageNumber?: string;
  qcLabel?: 'approved' | 'rejected' | null;
  labels?: string[];
  note?: string;
}
export type CartridgePhotosByState = { [phase: string]: CartridgePhoto[] };
export interface CartridgeNote {
  body: string; phase?: string; author?: string; createdAt?: string;
}
export interface CartridgePhotosResponse {
  success: boolean;
  barcode: string;
  photosByState: CartridgePhotosByState;
  tags: string[];
  notes: CartridgeNote[];
  error?: string;
}
```

**Per-state grouping shape** is `CartridgePhotosByState` (object keyed by raw `phase` string → array of `CartridgePhoto`, each already carrying its own `phase`). Display order is imposed by `phase-labels.ts`, not by object key order.

---

## 8. Tags & notes: where they're stored and how they render

**Where they live:** The research app has **no** cartridge `tags`/`notes` fields (`src/lib/types.ts`, `src/lib/attributes.js`). The authoritative source is BIMS:
- **Tags** ← `CvImage.cartridgeTag.labels[]` (per-photo) and, optionally, `qcLabel`. The agent endpoint unions all `labels` across a cartridge's photos into the card-level `tags[]`, while each `CartridgePhoto` also keeps its own `labels[]`/`qcLabel` for per-photo badges.
- **Notes** ← `CartridgeRecord.notes[]` (`{ body, phase, author, createdAt }`) plus `CvImage.cartridgeTag.notes`. The endpoint returns these as the card-level `notes[]`, each optionally tagged with the `phase` it belongs to.

**How they render on the card (`BarcodeCard.svelte`):**
- **Barcode:** monospace text at the top; in `variant="detail"`, optionally the DataMatrix graphic (bwip-js, reusing `LabelsCartridges` rendering).
- **Tags:** a horizontal row of pill/chips beneath the barcode (union of labels), with `qcLabel` shown as a colored badge (green approved / red rejected).
- **Notes:** a small list under the tags, each line `body` with a muted `phase · author · date` subline; collapsible when more than N in `row`/`chip` variants.
- **Photos:** `<CartridgePhotos>` renders one labeled strip per state (ordered by `phase-labels.ts`), each thumbnail expandable to full R2 image, with per-photo `capturedAt`/`qcLabel`.

> v1 is **display-only**. Editing tags/notes from research is out of scope (see Non-goals).

---

## 9. Open questions / decisions needed

1. **Production branch confirmation.** All BIMS photo code is on `master`, not the checked-out `spudashchange-stalefork`. Confirm prod runs `master` and target BIMS edits there.
2. **R2 URL publicness.** Confirm `R2_WORKER_URL` is set in prod (stored `r2Url` = public Worker `/file` URLs, no signing needed). If it falls back to `.r2.dev`, verify that bucket has public read enabled — otherwise the research proxy must stream bytes via BIMS `/api/r2/files` (signed), a heavier design. **Decision:** default to public Worker URLs; add a byte-proxy fallback only if not public.
3. **Auth model between apps.** Chosen: new `AGENT_API_KEY`-guarded BIMS route + server-side research proxy (browser stays same-origin cookie-auth). Confirm the research app can hold `AGENT_API_KEY` as a server secret, and **rotate `AGENT_API_KEY`** first (memory flags it needs rotating).
4. **Photo source of truth.** `cv_images` (more complete, what dhr/traceability query) vs embedded `cartridge_records.photos[]` (authoritative-by-barcode but historically had malformed entries). **Proposed:** read `cv_images`, fall back to `photos[]`, merge by `imageId`.
5. **`Cartridge.photos` map in research CouchDB.** Its string values' format (public URL? R2 key? BIMS id? filename?) is undocumented in the research repo. **Decision:** treat BIMS as the source of truth and ignore the CouchDB `photos` map for v1; revisit only if it holds URLs not present in BIMS.
6. **Identifier equality.** Confirm research cartridge `_id` (scanned UUID) === BIMS `CartridgeRecord._id`. Memory strongly implies yes ("cartridge _id IS the scanned UUID"), but validate against a real cartridge before rollout.
7. **Eager vs lazy fetch.** Chosen: lazy client-side fetch to avoid blocking list pages on BIMS latency. Revisit if product wants photos in the initial SSR payload for `/cartridge` detail (could be eager there only).
8. **Reuse `getCartridgeAttributes`?** The research `src/routes/api/get-cartridge-attributes/+server.ts` is misnamed (it deletes an arm). Do not touch; confirm attribute export flow (`generate-experiment-export`) is unrelated.
9. **Orphaned `LabelsCartridges.svelte`.** Is DataMatrix printing done elsewhere? Out of scope, but affects whether `variant="detail"` should render a scannable graphic.

---

## 10. Rollout / testing plan

**BIMS side (master):**
- Unit-test the agent endpoint: valid key → grouped photos; bad key → 401; unknown barcode → `found:false` empty payload; a barcode with `cv_images` but empty `photos[]` (and vice-versa) → merged correctly.
- Verify against a real production cartridge that stored `r2Url`s are publicly fetchable (curl the Worker `/file` URL unauthenticated).
- Deploy on master; log branch/commit/URL per deploy discipline. Expect the known Vercel "failure→success" flip; don't panic.

**Research side:**
- `npm run check` (SvelteKit type check) and `npm run lint` must pass.
- Endpoint tests for `/api/cartridge-photos`: cookie present/absent (401), cache hit vs miss, BIMS 5xx/timeout → `success:false` graceful payload.
- Component tests / manual: `BarcodeCard` in all four variants — loading, empty (no photos), error, and fully-populated states; verify thumbnails lazy-load via IntersectionObserver on `/cartridges` (no N-fan-out on initial paint).
- Manual e2e: scan/open a known cartridge on `/cartridge`, confirm per-state strips match the BIMS DHR view for the same barcode.

**Feature gating:** guard the photo fetch behind an env flag (e.g. `PUBLIC_ENABLE_CARTRIDGE_PHOTOS`) so `BarcodeCard` renders barcode+tags+notes even if the BIMS integration is disabled; flip on after BIMS endpoint is live and key rotated.

**Rollout order:** (1) ship BIMS agent endpoint (dark, key-guarded) → (2) verify with curl → (3) ship research proxy + `BarcodeCard` behind flag → (4) enable flag on `/cartridge` detail first, then `/analysis`, `/cartridges`, `/experiment`.

---

## 11. Milestones (ordered work chunks)

1. **M1 — BIMS agent endpoint (master).** Create `src/routes/api/agent/cartridge/[barcode]/photos/+server.ts`; `AGENT_API_KEY` guard; merge `cv_images` + `cartridge_records.photos[]`/`notes[]`; group by phase; return §7.1 contract. Add tests. Rotate `AGENT_API_KEY`. Deploy + curl-verify public URLs.
2. **M2 — Research types + client helper.** Add interfaces to `src/lib/types.ts`; add `loadCartridgePhotos` (+ client cache) to `src/lib/library/client.ts`; add `phase-labels.ts`.
3. **M3 — Research proxy endpoint.** Create `src/lib/server/bims.ts` (outbound fetch + key + server cache + timeout) and `src/routes/api/cartridge-photos/+server.ts`; wire `BIMS_BASE_URL`/`AGENT_API_KEY` via `$env/static/private`. Tests for auth/cache/error.
4. **M4 — Shared components.** Build `CartridgePhotos.svelte` (per-state strips + lightbox) then `BarcodeCard.svelte` (barcode + tags + notes + photos, lazy fetch, variants). Behind `PUBLIC_ENABLE_CARTRIDGE_PHOTOS` flag.
5. **M5 — Wire display sites.** Swap in `<BarcodeCard>` at `/cartridge` (detail, eager), then `/analysis` (chip), `/cartridges` (row, lazy), `/experiment` (row, lazy). Keep existing handlers intact.
6. **M6 — QA + rollout.** Full `npm run check`/lint, e2e cross-check against BIMS DHR, enable flag site-by-site, monitor. Resolve open questions #2/#4/#6 with real-data verification before flag-on.