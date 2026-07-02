# CARTRIDGE-PHOTOS-01 — Cross-Repo Integration Handoff

**Status:** Feature complete + deployed to previews/prod; verified end-to-end locally and at the API layer. Remaining: merge research branch to its main, rotate `AGENT_API_KEY`, and one in-browser cloud spot-check. **Last updated: 2026-07-02.**

**One-liner:** Show each cartridge's photos (grouped by the capture STATE/phase they were taken in), tags, and notes next to every barcode in the **brevitest-research** app, sourced live from the **BIMS** (Bioscale Operations System V2) R2/Mongo photo pipeline.

Full product spec: [`CARTRIDGE-PHOTOS-01-barcode-enrichment.md`](./CARTRIDGE-PHOTOS-01-barcode-enrichment.md) (in both repos). This document is the **operational handoff** — what exists, where, how it's wired, what's verified, and what's left.

---

## 1. The two repos it bridges

| Side | Repo | Branch | Deploys to (Vercel, team **brevitest** `team_ArrRvYc8j1tIaEjM1pdG0RuE`) |
|---|---|---|---|
| **Producer** (photos) | `avacoder3900/Bioscale_Operations_System_V2` (BIMS) | `feat/cartridge-photos-agent-api` → **merged to `master`** | project `bioscale-operations-system-mongodb` — prod `https://bioscale-operations-system-mongodb.vercel.app` |
| **Consumer** (UI) | `leo3linbeck/brevitest-research` | `feat/cartridge-barcode-enrichment` (**not yet merged to main**) | project `brevitest-research` — preview `https://brevitest-research-d3tz1o6dq-brevitest.vercel.app` |

Key identity fact that makes the bridge work: a cartridge's **barcode = its `_id`** in BOTH systems (the scanned UUID). BIMS `CartridgeRecord._id` === research CouchDB cartridge `_id`. No mapping table needed.

---

## 2. Architecture / data flow

```
Browser (research UI, per barcode)
   │  same-origin fetch, cookie auth (userEmail)
   ▼
research:  GET /api/cartridge-photos?barcode=<id>        ← proxy, keeps AGENT_API_KEY server-side
   │  server-to-server, header x-api-key: AGENT_API_KEY, 8s timeout, 5-min in-memory cache
   ▼
BIMS(prod): GET /api/agent/cartridge/<id>/photos          ← AGENT_API_KEY-guarded agent endpoint
   │  CartridgeRecord.photos[]/notes[]  ⨝  cv_images(cartridgeTag.*)  → group by phase
   ▼
returns { found, photosByState:{phase:[Photo]}, tags[], notes[] }   (r2Url = PUBLIC Cloudflare Worker URLs)
   │
Browser renders <img src={r2Url}> directly from R2   ← image bytes never transit either server
```

Design choices: the proxy exists so the browser stays same-origin (matching the research app's cookie auth) and the BIMS key never reaches the client. Image **bytes** bypass both servers (public R2 URLs). Everything degrades gracefully — if BIMS is unreachable or the barcode is unknown, the card still shows the barcode.

---

## 3. What was built — BIMS side (producer)

**Commit `f977234a`** (on `master` via fast-forward; deploy log at `7cb80211`).

- **`src/routes/api/agent/cartridge/[barcode]/photos/+server.ts`** — new `GET`, guarded by `requireAgentApiKey()` (`$lib/server/api-auth`, accepts `x-api-key` / `x-agent-api-key` / `Bearer`). Does `connectDB()`, then:
  - `CartridgeRecord.findById(barcode).select('photos notes')`
  - `CvImage.find({ 'cartridgeTag.cartridgeRecordId': barcode })`
  - Merges the two (dedupe by `imageId` / `cartridgeImageNumber`; embedded `photos[]` wins for the authoritative stored `r2Url`; `cv_images` enriches `labels`, `notes`, `qcLabel`, thumbnail), groups by `phase` into `photosByState` (sorted oldest→newest), unions all labels + qc verdicts into card-level `tags[]`, returns operator `notes[]` (`{body, phase, author, createdAt}`).
  - Unknown barcode → `200 { found:false, photosByState:{}, tags:[], notes:[] }` (single simple success path for the proxy). Bad/missing key → `401`.
- URLs come from `getR2Url()` (`$lib/server/services/r2.ts`) → public Worker `/file/<key>` path.

**Contract (200):**
```json
{
  "barcode": "…", "found": true,
  "photosByState": { "wax_filled": [ { "imageId":"…","phase":"wax_filled","capturedAt":"ISO",
      "r2Url":"https://…workers.dev/file/…","thumbnailUrl":"…","cartridgeImageNumber":"…",
      "qcLabel":"approved|rejected|null","labels":["…"],"note":"…" } ] },
  "tags": ["…"], "notes": [ { "body":"…","phase":"…","author":"…","createdAt":"ISO" } ]
}
```

---

## 4. What was built — research side (consumer)

**Branch `feat/cartridge-barcode-enrichment`** (feature at `88bf806`; empty redeploy commit `ef6fb80`).

| File | What |
|---|---|
| `src/lib/types.ts` (edit) | `CartridgePhoto`, `CartridgePhotosByState`, `CartridgeNote`, `CartridgePhotosResponse` |
| `src/lib/library/phase-labels.ts` (new) | `phaseLabel(phase)` + `phaseOrder(phase)` — raw phase → display label + stable order |
| `src/lib/library/client.ts` (edit) | `loadCartridgePhotos(barcode)` — fetches the proxy, module-level per-barcode cache, safe fallback |
| `src/lib/server/bims.ts` (new) | `getCartridgePhotos(barcode)` — outbound fetch to BIMS w/ `AGENT_API_KEY`, 8s timeout, 5-min cache, graceful `success:false` if unconfigured/unreachable. Uses **`$env/dynamic/private`** (runtime read, so missing config never breaks the build) |
| `src/routes/api/cartridge-photos/+server.ts` (new) | `GET` proxy — cookie-gated (`cookies.get('userEmail')`, else 401), reads `?barcode=` (400 if absent), calls `getCartridgePhotos`, normalizes BIMS `found`→`success` |
| `src/lib/component/cartridge/CartridgePhotos.svelte` (new) | one photo strip per state (ordered by `phaseOrder`), thumbnails, qc badges, capturedAt, click-to-lightbox |
| `src/lib/component/cartridge/BarcodeCard.svelte` (new) | barcode + tags + notes + `<CartridgePhotos>`; **lazy** load (IntersectionObserver / hover / expand, unless `eager`); variants `chip` / `row` / `detail` |
| `src/routes/{cartridge,analysis,cartridges,experiment}/+page.svelte` (edit) | `<BarcodeCard>` wired into all four barcode display sites (detail=eager; others lazy row/chip). Server loaders untouched — fetch is client-side/lazy |

Svelte 5 (runes) throughout. Gotcha fixed during build: `let data: T|null = $state(null)` wasn't honoring the annotation → use the generic `$state<T|null>(null)` and annotate derived (`const photosByState: CartridgePhotosByState = $derived(...)`).

---

## 5. Deployments (as of 2026-07-02)

- **BIMS prod:** `https://bioscale-operations-system-mongodb.vercel.app` — `master` @ `7cb80211`, deployed via GitHub integration (merge to master). Endpoint is **live**.
- **Research preview:** `https://brevitest-research-d3tz1o6dq-brevitest.vercel.app` — redeploy of `feat/cartridge-barcode-enrichment` after env vars were added. **Behind Vercel SSO** (see gotchas).
- Deploy discipline followed: **no local `vercel deploy`** for BIMS; all via git push → GitHub integration. BIMS `progress.txt` has the M1 + deployment log entries.

### Environment variables (Vercel project `brevitest/brevitest-research`, **Production + Preview**)
| Name | Value | Notes |
|---|---|---|
| `BIMS_BASE_URL` | `https://bioscale-operations-system-mongodb.vercel.app` | BIMS prod (stable). Change if BIMS domain changes |
| `AGENT_API_KEY` | (same value as BIMS `AGENT_API_KEY`) | Must match BIMS. **Rotate before wider use** |

> Local dev needs a `.env` with these two **plus** dummy `COUCHDB_BASEURL`, `COUCHDB_BASE64_CREDENTIAL`, `BOX_CLIENT_ID/SECRET`, `BOX_ENTERPRISE_ID`, `BOX_ROOT_FOLDER_ID` (the app imports those via `$env/static/private`, which are required at **build** time). `.env` is gitignored.

---

## 6. Verification performed ✅

- **BIMS prod endpoint:** no key → `401`; valid key + real barcode `f722aa11-fb74-4cc1-8abe-e27464e8b612` → `found:true`, **8 photos / 3 states** (`wax_filled` 4, `reagent_filled` 2, `post_mortem` 2).
- **R2 image:** `GET` → `HTTP 200 image/jpeg` (~173 KB) — publicly renderable. (HEAD returns 404 — the worker has no HEAD handler; use GET.)
- **Research proxy (local, wired to BIMS prod):** no cookie → `401`; missing barcode → `400`; cookie + real barcode → `success:true` with the same 8 photos.
- **UI (local production `preview` build):** screenshot confirmed all three `BarcodeCard` variants rendering the 8 real cartridge photos, grouped and labeled by state with timestamps. (Local screenshot artifact was in scratch; not committed.)

---

## 7. Known gotchas (read before continuing)

1. **Research preview URLs are behind Vercel SSO** (redirect to `vercel.com/sso-api`). `curl` can't reach them; a Vercel-authenticated **browser** can. To automate cloud tests, add a *Protection Bypass for Automation* secret to the project and pass `x-vercel-protection-bypass`.
2. **The test barcode `f722…` is BIMS-only** — it has no doc in the research CouchDB, so `/cartridge?id=f722…` 500s. For a visible cloud test, open the research **Cartridges** page and pick a cartridge that was actually manufactured/captured (its `_id` will resolve in BOTH systems and the card will show photos). A throwaway `/_phototest` route can render any barcode if needed.
3. **Local `vite dev` crashes** on Node 22 + HTTPS (vite-plugin-mkcert) at the HMR websocket upgrade (`shouldUpgradeCallback is not a function`). Use `npm run build && npm run preview` for browser testing.
4. **Empty git commits don't trigger a new Vercel deploy** (same source tree → skipped). To force a redeploy after changing env vars, use `vercel redeploy <url>` (env vars only apply to NEW deployments).
5. **`AGENT_API_KEY` needs rotating** (flagged pre-existing). Rotate on BIMS and update the research env var in lockstep.

---

## 8. Remaining work / go-live checklist

- [ ] **In-browser cloud spot-check** — open the research preview, navigate to a real captured cartridge, confirm photos render (env vars already set for Preview + Production).
- [ ] **Merge `feat/cartridge-barcode-enrichment` → research `main`** (open PR on `leo3linbeck/brevitest-research`). Production env vars are already set, so prod works on merge.
- [ ] **Rotate `AGENT_API_KEY`** (BIMS + research env var together).
- [ ] Optional: confirm `R2_WORKER_URL` is set in BIMS prod (it is — R2 URLs verified public). If ever falling back to `*.r2.dev`, ensure that bucket has public read.
- [ ] Optional: automation-bypass secret on `brevitest-research` if CI should test previews.

---

## 9. Quick reference (commands)

```bash
# BIMS prod endpoint (needs AGENT_API_KEY)
curl -H "x-api-key: $KEY" https://bioscale-operations-system-mongodb.vercel.app/api/agent/cartridge/<barcode>/photos

# research proxy (local dev/preview; needs userEmail cookie)
curl -k -H "Cookie: userEmail=x@y.com" "https://127.0.0.1:4173/api/cartridge-photos?barcode=<barcode>"

# local prod preview (browser-testable; needs full .env incl. dummy COUCHDB_*/BOX_*)
npm run build && npm run preview -- --host 127.0.0.1 --port 4173

# vercel env (scope matters — always brevitest)
vercel env ls --scope brevitest --token "$VERCEL_TOKEN"
vercel redeploy <preview-url> --scope brevitest --token "$VERCEL_TOKEN"
```
