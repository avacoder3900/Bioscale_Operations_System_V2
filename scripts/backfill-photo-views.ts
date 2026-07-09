/**
 * Backfill cv_images.view for existing photos using barcode presence
 * (CV-PIPELINE-V2 top/bottom split; see src/lib/server/services/barcode-detect.ts).
 *
 * For every image with view null/absent: fetch the pixels from R2, detect
 * whether a barcode is present, and set view 'top' (barcode) / 'bottom' (none)
 * with viewSource 'barcode-auto'. Undetectable images (fetch failure, decode
 * error/timeout) are left untagged and counted. Already-tagged images are never
 * touched, so the script is idempotent and safe to re-run.
 *
 * Writes use the raw driver (immune to schema drift). Env: MONGODB_URI and the
 * R2 public URL vars — pass ENV_FILE=<path> to load a specific env file.
 *
 * Usage:
 *   npx tsx scripts/backfill-photo-views.ts             # process everything untagged
 *   npx tsx scripts/backfill-photo-views.ts --limit 20  # smoke run on 20 images
 */
import * as dotenv from 'dotenv';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import mongoose from 'mongoose';
import { detectBarcodePresence, BARCODE_VIEW, NO_BARCODE_VIEW } from '../src/lib/server/services/barcode-detect.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: process.env.ENV_FILE ?? resolve(__dirname, '..', '.env') });

const uri = process.env.MONGODB_URI;
if (!uri) {
	console.error('MONGODB_URI not set (pass ENV_FILE=<path-to-env>)');
	process.exit(1);
}

const limitArg = process.argv.indexOf('--limit');
const LIMIT = limitArg !== -1 ? Number(process.argv[limitArg + 1]) : 0;
const CONCURRENCY = 8;

// Public R2 base for images that only carry filePath (mirror of getR2Url).
const R2_PUBLIC_URL = (process.env.R2_PUBLIC_URL ?? '').replace(/\/$/, '');

function urlFor(img: any): string | null {
	if (img.imageUrl) return img.imageUrl;
	if (img.filePath && R2_PUBLIC_URL) return `${R2_PUBLIC_URL}/${img.filePath}`;
	return null;
}

async function fetchBytes(url: string): Promise<Buffer | null> {
	try {
		const res = await fetch(url);
		if (!res.ok) return null;
		return Buffer.from(await res.arrayBuffer());
	} catch {
		return null;
	}
}

await mongoose.connect(uri);
const db = mongoose.connection.db!;
console.log(`Connected to database: ${db.databaseName}`);

const coll = db.collection('cv_images');
const filter = { $or: [{ view: null }, { view: { $exists: false } }] };
const total = await coll.countDocuments(filter);
console.log(`Untagged images: ${total}${LIMIT ? ` (processing at most ${LIMIT})` : ''}`);

const cursor = coll
	.find(filter)
	.project({ _id: 1, imageUrl: 1, filePath: 1 })
	.sort({ _id: 1 });

let processed = 0, top = 0, bottom = 0, undetectable = 0, noUrl = 0, fetchFailed = 0;

async function handle(img: any): Promise<void> {
	const url = urlFor(img);
	if (!url) { noUrl++; return; }
	const bytes = await fetchBytes(url);
	if (!bytes) { fetchFailed++; return; }
	const hasBarcode = await detectBarcodePresence(bytes);
	if (hasBarcode === null) { undetectable++; return; }
	const view = hasBarcode ? BARCODE_VIEW : NO_BARCODE_VIEW;
	await coll.updateOne({ _id: img._id }, { $set: { view, viewSource: 'barcode-auto' } });
	if (hasBarcode) top++; else bottom++;
}

let batch: any[] = [];
for await (const img of cursor) {
	if (LIMIT && processed >= LIMIT) break;
	batch.push(img);
	processed++;
	if (batch.length >= CONCURRENCY) {
		await Promise.all(batch.map(handle));
		batch = [];
		if (processed % 40 === 0) {
			console.log(`  ${processed}/${LIMIT || total} — top ${top}, bottom ${bottom}, undetectable ${undetectable}, fetch-failed ${fetchFailed}, no-url ${noUrl}`);
		}
	}
}
if (batch.length > 0) await Promise.all(batch.map(handle));

console.log('='.repeat(64));
console.log(`Processed:     ${processed}`);
console.log(`  -> top:          ${top} (barcode found)`);
console.log(`  -> bottom:       ${bottom} (no barcode)`);
console.log(`  -> undetectable: ${undetectable} (decode error/timeout — left untagged)`);
console.log(`  -> fetch failed: ${fetchFailed} (left untagged)`);
console.log(`  -> no URL:       ${noUrl} (left untagged)`);

await mongoose.disconnect();
