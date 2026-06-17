# PRD: Cloudflare Worker Upload Proxy for R2

**Author:** Alejandro Valdez (via Agent001)
**Date:** 2026-03-30
**Status:** Draft
**Priority:** P1 — Unblocks image upload pipeline for CV and inspection features
**Branch:** `feature/r2-worker-proxy` (branch from `dev`)

---

## 1. Problem Statement

BIMS needs to upload and serve images (CV inspection photos, product images, training data) via Cloudflare R2. Direct browser-to-R2 uploads using the S3 API fail due to a TLS cipher mismatch (`ERR_SSL_VERSION_OR_CIPHER_MISMATCH`) between browsers and `r2.cloudflarestorage.com`.

The current presigned URL workaround in `feature/cv-bims-integration` works from server-side code but is unreliable from browser clients. We need a clean, production-ready upload + delivery solution.

## 2. Solution

Deploy a **Cloudflare Worker** as an upload/download proxy that sits between the browser and R2. The Worker uses an R2 **binding** (internal connection — no TLS issue) and handles:
- Authenticated uploads (PUT)
- Public or authenticated downloads (GET)
- File deletion (DELETE)
- Metadata/listing (optional)

## 3. Architecture

```
┌──────────┐     HTTPS      ┌────────────────────┐   R2 Binding   ┌──────────┐
│  Browser  │ ──────────────▶│  Cloudflare Worker  │ ──────────────▶│  R2      │
│ (SvelteKit│     PUT/GET    │  (r2-upload-proxy)  │   (internal)   │  Bucket  │
│  frontend)│◀──────────────│                    │◀──────────────│          │
└──────────┘                └────────────────────┘                └──────────┘
                                     │
                                     │ Auth via
                                     │ Bearer token
                                     │
                            ┌────────────────────┐
                            │  SvelteKit API      │
                            │  (+server.ts)       │
                            │  Generates upload   │
                            │  params + auth      │
                            └────────────────────┘
```

### Upload Flow (Step by Step)

1. User selects image file in SvelteKit frontend
2. Frontend calls SvelteKit API route (`POST /api/upload/request`)
3. SvelteKit API generates:
   - A unique object key (e.g., `inspections/{batchId}/{timestamp}-{uuid}.jpg`)
   - The Worker URL with the key path
   - A short-lived auth token or the shared Bearer token
4. Frontend PUTs the file directly to the Worker URL with `Authorization: Bearer <token>`
5. Worker validates auth, stores file in R2 via binding
6. Worker returns `{ key, size, etag }` on success
7. Frontend saves the returned key + metadata to MongoDB via SvelteKit API

### Download Flow

1. Frontend requests image: `GET https://r2-upload-proxy.<account>.workers.dev/{key}`
2. Worker fetches from R2 via binding
3. Worker returns file with correct `Content-Type` headers
4. (Future) Add Cloudflare Image Resizing via custom domain for on-the-fly transforms

## 4. Technical Specification

### 4.1 Cloudflare Worker

**Project name:** `r2-upload-proxy`
**Runtime:** Cloudflare Workers (TypeScript)
**R2 Bucket:** `brevitest-images` (existing bucket from CV branch work)

#### wrangler.jsonc

```jsonc
{
  "name": "r2-upload-proxy",
  "main": "src/index.ts",
  "compatibility_date": "2026-03-30",
  "r2_buckets": [
    {
      "binding": "BUCKET",
      "bucket_name": "brevitest-images"
    }
  ]
}
```

#### Environment Variables / Secrets

| Name | Type | Description |
|------|------|-------------|
| `AUTH_SECRET` | Secret | Bearer token for authenticating uploads. Set via `npx wrangler secret put AUTH_SECRET` |
| `ALLOWED_ORIGINS` | Variable | Comma-separated list of allowed CORS origins (e.g., `https://bioscale-operations-system-mongodb.vercel.app,http://localhost:5173`) |

#### Endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `PUT` | `/{key}` | Required (Bearer) | Upload a file. Key = full path in R2 bucket. |
| `GET` | `/{key}` | Optional | Download a file. Returns file with correct Content-Type. |
| `DELETE` | `/{key}` | Required (Bearer) | Delete a file from R2. |
| `HEAD` | `/{key}` | Optional | Check if file exists, get metadata. |
| `OPTIONS` | `*` | None | CORS preflight. |

#### Worker Source (`src/index.ts`)

```typescript
interface Env {
  BUCKET: R2Bucket;
  AUTH_SECRET: string;
  ALLOWED_ORIGINS: string;
}

const ALLOWED_CONTENT_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  "image/svg+xml",
  "application/pdf",
];

const MAX_FILE_SIZE = 25 * 1024 * 1024; // 25 MB

function getCorsHeaders(request: Request, env: Env): HeadersInit {
  const origin = request.headers.get("Origin") || "";
  const allowed = (env.ALLOWED_ORIGINS || "").split(",").map((s) => s.trim());
  const isAllowed = allowed.includes(origin) || allowed.includes("*");

  return {
    "Access-Control-Allow-Origin": isAllowed ? origin : "",
    "Access-Control-Allow-Methods": "GET, PUT, DELETE, HEAD, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Max-Age": "86400",
  };
}

function isAuthorized(request: Request, env: Env): boolean {
  const auth = request.headers.get("Authorization");
  return auth === `Bearer ${env.AUTH_SECRET}`;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const key = url.pathname.slice(1); // Remove leading "/"
    const corsHeaders = getCorsHeaders(request, env);

    // CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    // All responses get CORS headers
    const respond = (body: BodyInit | null, init: ResponseInit = {}) => {
      const headers = new Headers(init.headers);
      Object.entries(corsHeaders).forEach(([k, v]) => headers.set(k, v));
      return new Response(body, { ...init, headers });
    };

    // Key is required for all operations
    if (!key) {
      return respond(JSON.stringify({ error: "Missing object key in URL path" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    switch (request.method) {
      case "PUT": {
        // Auth required for uploads
        if (!isAuthorized(request, env)) {
          return respond(JSON.stringify({ error: "Unauthorized" }), {
            status: 401,
            headers: { "Content-Type": "application/json" },
          });
        }

        // Validate content type
        const contentType = request.headers.get("Content-Type") || "";
        if (!ALLOWED_CONTENT_TYPES.some((t) => contentType.startsWith(t))) {
          return respond(
            JSON.stringify({
              error: `Invalid content type: ${contentType}`,
              allowed: ALLOWED_CONTENT_TYPES,
            }),
            { status: 400, headers: { "Content-Type": "application/json" } }
          );
        }

        // Validate file size
        const contentLength = parseInt(request.headers.get("Content-Length") || "0");
        if (contentLength > MAX_FILE_SIZE) {
          return respond(
            JSON.stringify({
              error: `File too large. Max: ${MAX_FILE_SIZE / 1024 / 1024} MB`,
            }),
            { status: 413, headers: { "Content-Type": "application/json" } }
          );
        }

        // Upload to R2
        const object = await env.BUCKET.put(key, request.body, {
          httpMetadata: { contentType },
          customMetadata: {
            uploadedAt: new Date().toISOString(),
            uploadedBy: request.headers.get("X-Uploaded-By") || "unknown",
          },
        });

        if (!object) {
          return respond(JSON.stringify({ error: "Upload failed" }), {
            status: 500,
            headers: { "Content-Type": "application/json" },
          });
        }

        return respond(
          JSON.stringify({
            success: true,
            key: object.key,
            size: object.size,
            etag: object.etag,
            uploaded: object.uploaded.toISOString(),
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }

      case "GET": {
        const object = await env.BUCKET.get(key);
        if (!object) {
          return respond(JSON.stringify({ error: "Not found" }), {
            status: 404,
            headers: { "Content-Type": "application/json" },
          });
        }

        const headers = new Headers();
        object.writeHttpMetadata(headers);
        headers.set("etag", object.httpEtag);
        headers.set("Cache-Control", "public, max-age=31536000, immutable");
        Object.entries(corsHeaders).forEach(([k, v]) => headers.set(k, v));

        return new Response(object.body, { headers });
      }

      case "DELETE": {
        if (!isAuthorized(request, env)) {
          return respond(JSON.stringify({ error: "Unauthorized" }), {
            status: 401,
            headers: { "Content-Type": "application/json" },
          });
        }

        await env.BUCKET.delete(key);
        return respond(JSON.stringify({ success: true, deleted: key }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      case "HEAD": {
        const object = await env.BUCKET.head(key);
        if (!object) {
          return respond(null, { status: 404 });
        }

        const headers = new Headers();
        object.writeHttpMetadata(headers);
        headers.set("etag", object.httpEtag);
        Object.entries(corsHeaders).forEach(([k, v]) => headers.set(k, v));

        return new Response(null, { status: 200, headers });
      }

      default:
        return respond(JSON.stringify({ error: "Method not allowed" }), {
          status: 405,
          headers: { "Content-Type": "application/json" },
        });
    }
  },
} satisfies ExportedHandler<Env>;
```

### 4.2 SvelteKit Integration

#### New API Route: `src/routes/api/upload/request/+server.ts`

This route generates upload parameters for the frontend:

```typescript
import { json, error } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { R2_WORKER_URL, R2_AUTH_SECRET } from "$env/static/private";
import crypto from "crypto";

export const POST: RequestHandler = async ({ request, locals }) => {
  // Require authenticated user
  if (!locals.user) throw error(401, "Unauthorized");

  const { folder, filename, contentType } = await request.json();

  if (!folder || !filename || !contentType) {
    throw error(400, "Missing folder, filename, or contentType");
  }

  // Generate unique key
  const ext = filename.split(".").pop() || "jpg";
  const uniqueName = `${Date.now()}-${crypto.randomUUID()}.${ext}`;
  const key = `${folder}/${uniqueName}`;

  return json({
    uploadUrl: `${R2_WORKER_URL}/${key}`,
    key,
    headers: {
      Authorization: `Bearer ${R2_AUTH_SECRET}`,
      "Content-Type": contentType,
      "X-Uploaded-By": locals.user.username || locals.user._id,
    },
  });
};
```

#### New Frontend Component: `src/lib/components/ImageUpload.svelte`

```svelte
<script>
  let { folder = "uploads", onUpload = () => {}, maxSizeMB = 25 } = $props();

  let uploading = $state(false);
  let error = $state("");
  let progress = $state(0);

  async function handleFileSelect(event) {
    const file = event.target.files?.[0];
    if (!file) return;

    // Validate size
    if (file.size > maxSizeMB * 1024 * 1024) {
      error = `File too large. Max ${maxSizeMB} MB.`;
      return;
    }

    // Validate type
    if (!file.type.startsWith("image/") && file.type !== "application/pdf") {
      error = "Only images and PDFs are allowed.";
      return;
    }

    error = "";
    uploading = true;
    progress = 0;

    try {
      // Step 1: Get upload URL from SvelteKit API
      const reqRes = await fetch("/api/upload/request", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          folder,
          filename: file.name,
          contentType: file.type,
        }),
      });

      if (!reqRes.ok) throw new Error("Failed to get upload URL");
      const { uploadUrl, key, headers } = await reqRes.json();

      // Step 2: Upload directly to Worker
      progress = 10;
      const uploadRes = await fetch(uploadUrl, {
        method: "PUT",
        headers,
        body: file,
      });

      if (!uploadRes.ok) {
        const err = await uploadRes.json();
        throw new Error(err.error || "Upload failed");
      }

      progress = 100;
      const result = await uploadRes.json();

      // Step 3: Callback with result
      onUpload({ key: result.key, size: result.size, etag: result.etag, contentType: file.type, originalName: file.name });
    } catch (err) {
      error = err.message || "Upload failed";
    } finally {
      uploading = false;
    }
  }
</script>

<div class="upload-container">
  <input
    type="file"
    accept="image/*,.pdf"
    onchange={handleFileSelect}
    disabled={uploading}
  />
  {#if uploading}
    <div class="progress-bar">
      <div class="progress-fill" style="width: {progress}%"></div>
    </div>
    <span>Uploading...</span>
  {/if}
  {#if error}
    <p class="error">{error}</p>
  {/if}
</div>
```

### 4.3 MongoDB Schema Addition

Add image reference fields to relevant models (e.g., Inspection, CVProject, PartDefinition):

```typescript
// Example: Add to existing model as needed
const imageSchema = {
  r2Key: { type: String, required: true },        // R2 object key
  originalName: { type: String },                   // Original filename
  contentType: { type: String },                    // MIME type
  size: { type: Number },                           // File size in bytes
  uploadedBy: { type: Schema.Types.ObjectId, ref: "User" },
  uploadedAt: { type: Date, default: Date.now },
};
```

## 5. Environment Variables (Vercel + Worker)

### Vercel (.env)
```
R2_WORKER_URL=https://r2-upload-proxy.<account>.workers.dev
R2_AUTH_SECRET=<same secret set in Worker>
```

### Cloudflare Worker
```bash
npx wrangler secret put AUTH_SECRET    # Same value as R2_AUTH_SECRET in Vercel
# Set ALLOWED_ORIGINS in wrangler.jsonc or via dashboard:
# "vars": { "ALLOWED_ORIGINS": "https://bioscale-operations-system-mongodb.vercel.app,http://localhost:5173" }
```

## 6. R2 Bucket Configuration

**Bucket name:** `brevitest-images` (already exists)

**CORS policy** (set via dashboard or API — may already be configured):
```json
[
  {
    "AllowedOrigins": ["https://bioscale-operations-system-mongodb.vercel.app", "http://localhost:5173"],
    "AllowedMethods": ["GET", "PUT", "DELETE", "HEAD"],
    "AllowedHeaders": ["*"],
    "MaxAgeSeconds": 86400
  }
]
```

Note: CORS on the R2 bucket itself is mainly needed for presigned URL flows. With the Worker proxy, CORS is handled by the Worker. But it's good practice to configure both.

## 7. Folder Structure (R2 Keys)

```
brevitest-images/
├── cv/
│   ├── projects/{projectId}/
│   │   ├── training/{timestamp}-{uuid}.jpg
│   │   └── results/{timestamp}-{uuid}.jpg
│   └── gallery/{timestamp}-{uuid}.jpg
├── inspections/
│   ├── {batchId}/{timestamp}-{uuid}.jpg
│   └── seals/{timestamp}-{uuid}.jpg
├── parts/
│   └── {partNumber}/{timestamp}-{uuid}.jpg
├── equipment/
│   └── {equipmentId}/{timestamp}-{uuid}.jpg
└── temp/
    └── {timestamp}-{uuid}.jpg    # Auto-cleanup after 24h via R2 lifecycle rule
```

## 8. Security Considerations

- **Bearer token auth** on all write operations (PUT, DELETE)
- **Content-Type validation** — only allow image/* and application/pdf
- **File size limit** — 25 MB max (configurable)
- **CORS** — restrict to known origins only
- **No directory listing** — Worker only serves individual keys
- **Custom metadata** — every upload tagged with user + timestamp for audit trail
- **R2 lifecycle rule** — auto-delete files in `temp/` after 24 hours

## 9. Deployment Steps

```bash
# 1. Create Worker project (if not already created)
npm create cloudflare@latest r2-upload-proxy

# 2. Copy wrangler.jsonc and src/index.ts from this PRD

# 3. Set the auth secret
npx wrangler secret put AUTH_SECRET
# Enter a strong random string

# 4. Deploy
npx wrangler deploy

# 5. Note the Worker URL (e.g., https://r2-upload-proxy.brevitest.workers.dev)

# 6. Add to Vercel env vars:
#    R2_WORKER_URL = <worker URL from step 5>
#    R2_AUTH_SECRET = <same secret from step 3>

# 7. Redeploy BIMS on Vercel to pick up new env vars
```

## 10. Future Enhancements (Phase 2)

| Enhancement | Description | Effort |
|-------------|-------------|--------|
| Custom domain | Serve images from `images.bioscale.health` instead of `workers.dev` | 15 min |
| Image Resizing | Add Cloudflare Image Resizing for on-the-fly transforms (`?width=400&format=auto`) | 1 hour |
| Multipart upload | For files > 100 MB (CV training datasets) — chunked parallel upload | 4 hours |
| Thumbnail generation | Worker generates thumbnail on upload, stores as separate key | 2 hours |
| Signed download URLs | Time-limited download URLs for sensitive images (HIPAA) | 2 hours |
| Batch upload | Upload multiple images in one request | 3 hours |

## 11. Testing Checklist

- [ ] Worker deploys successfully (`npx wrangler deploy`)
- [ ] `PUT` with valid auth uploads file and returns key/size/etag
- [ ] `PUT` without auth returns 401
- [ ] `PUT` with invalid content type returns 400
- [ ] `PUT` with file > 25 MB returns 413
- [ ] `GET` returns file with correct Content-Type and caching headers
- [ ] `GET` for non-existent key returns 404
- [ ] `DELETE` with valid auth removes file
- [ ] `DELETE` without auth returns 401
- [ ] `HEAD` returns metadata without body
- [ ] CORS preflight returns correct headers
- [ ] SvelteKit `/api/upload/request` generates correct URL and headers
- [ ] Full flow: select file → upload → save to MongoDB → display image
- [ ] Works from `localhost:5173` (dev) and Vercel production URL

## 12. Files to Create/Modify

### New Files
| File | Description |
|------|-------------|
| `r2-upload-proxy/` (separate project or monorepo subfolder) | Cloudflare Worker project |
| `r2-upload-proxy/src/index.ts` | Worker source code |
| `r2-upload-proxy/wrangler.jsonc` | Wrangler config with R2 binding |
| `src/routes/api/upload/request/+server.ts` | SvelteKit upload request endpoint |
| `src/lib/components/ImageUpload.svelte` | Reusable upload component |

### Modified Files
| File | Change |
|------|--------|
| `.env` / Vercel env vars | Add `R2_WORKER_URL` and `R2_AUTH_SECRET` |
| Relevant Mongoose models | Add image reference fields where needed |
| Pages that need image upload | Import and use `ImageUpload.svelte` component |

## 13. Acceptance Criteria

1. A user can upload an image from the BIMS frontend and see it displayed after upload
2. Images are stored in R2 with correct folder structure and metadata
3. Image URLs are saved in MongoDB with the upload metadata
4. The upload works reliably from both localhost and production Vercel
5. No TLS errors — the browser never talks directly to `r2.cloudflarestorage.com`
6. Unauthorized upload attempts are rejected with 401
7. Invalid file types and oversized files are rejected with appropriate errors
