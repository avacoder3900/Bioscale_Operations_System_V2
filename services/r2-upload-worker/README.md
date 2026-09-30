# R2 Upload Worker

Cloudflare Worker that proxies image uploads to R2. Solves the TLS/SSL handshake issue between browsers/Vercel and R2's S3 API endpoint.

## Deploy

```bash
cd services/r2-upload-worker
npm install
npx wrangler login  # one-time auth
npx wrangler deploy
```

After deploy, the worker URL will be something like:
`https://brevitest-r2-upload.<your-subdomain>.workers.dev`

Add this URL to Vercel env vars as `R2_WORKER_URL`.

## Usage

```bash
# Upload
curl -X PUT "https://brevitest-r2-upload.xxx.workers.dev/upload/cv/project1/image.jpg" \
  -H "Content-Type: image/jpeg" \
  -H "X-Upload-Secret: brevitest-r2-upload-key-2026" \
  --data-binary @image.jpg

# Download
curl "https://brevitest-r2-upload.xxx.workers.dev/file/cv/project1/image.jpg" \
  -H "X-Upload-Secret: brevitest-r2-upload-key-2026"

# Existence + size (no body)
curl -I "https://brevitest-r2-upload.xxx.workers.dev/file/cv/project1/image.jpg"
```

## Direct browser uploads (`PUT /direct/:key`)

Added 2026-09-30 for sonic recordings, which are too big for Vercel's 4.5 MB function
body cap. The app server mints a token and the browser PUTs straight to the Worker:

```
token = hex( HMAC-SHA256( UPLOAD_SECRET, "<key>\n<expires-unix-seconds>\n<maxBytes>" ) )

PUT /direct/<url-encoded key>
  Content-Type:     <file type>
  Content-Length:   <required; must be <= maxBytes>
  X-Upload-Token:   <token>
  X-Upload-Expires: <expires-unix-seconds>
  X-Upload-Max:     <maxBytes>
```

The token is valid for one key, until `expires`, up to `maxBytes`; the shared secret never
leaves the server. Minting lives in `src/lib/server/sonic-direct.ts`. After the PUT the app
HEADs `/file/<key>` to confirm the object before it writes the record.

Rollout: `npx wrangler deploy` this Worker, then set `SONIC_DIRECT_UPLOAD=1` in the Vercel
Production env (and Preview if the Worker vars are added there). Without the flag the sonic
page keeps proxying uploads through Vercel and stays under 4.5 MB.
