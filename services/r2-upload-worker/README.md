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
```
