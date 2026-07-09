/**
 * Pre-compute the cv-color-spatial-v1 embedding cache for existing photos so
 * in-process training (cv-bridge triggerTraining) doesn't have to embed at
 * train time — embedding hundreds of images inside a serverless request is
 * what caused training 504s.
 *
 * Idempotent: only touches images missing the current EMBEDDING_VERSION.
 * Failures (missing URL, fetch error, decode error) are counted and skipped.
 *
 * Usage:
 *   npx tsx scripts/backfill-embeddings.ts --labeled   # only qcLabel'd images (unblocks training)
 *   npx tsx scripts/backfill-embeddings.ts             # every image
 *   npx tsx scripts/backfill-embeddings.ts --limit 50  # smoke run
 */
import * as dotenv from 'dotenv';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import mongoose from 'mongoose';
import { embedImage, EMBEDDING_VERSION } from '../src/lib/server/services/cv-classifier.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: process.env.ENV_FILE ?? resolve(__dirname, '..', '.env') });

const uri = process.env.MONGODB_URI;
if (!uri) {
	console.error('MONGODB_URI not set (pass ENV_FILE=<path-to-env>)');
	process.exit(1);
}

const LABELED_ONLY = process.argv.includes('--labeled');
const limitArg = process.argv.indexOf('--limit');
const LIMIT = limitArg !== -1 ? Number(process.argv[limitArg + 1]) : 0;
const CONCURRENCY = 8;

const R2_PUBLIC_URL = (process.env.R2_PUBLIC_URL ?? '').replace(/\/$/, '');

function urlFor(img: any): string | null {
	if (img.imageUrl) return img.imageUrl;
	if (img.filePath && R2_PUBLIC_URL) return `${R2_PUBLIC_URL}/${img.filePath}`;
	return null;
}

await mongoose.connect(uri);
const db = mongoose.connection.db!;
console.log(`Connected to database: ${db.databaseName}`);

const coll = db.collection('cv_images');
const filter: Record<string, any> = { embeddingVersion: { $ne: EMBEDDING_VERSION } };
if (LABELED_ONLY) filter.qcLabel = { $ne: null };

const total = await coll.countDocuments(filter);
console.log(
	`Images missing ${EMBEDDING_VERSION} embedding${LABELED_ONLY ? ' (labeled only)' : ''}: ${total}` +
		`${LIMIT ? ` (processing at most ${LIMIT})` : ''}`
);

const cursor = coll.find(filter).project({ _id: 1, imageUrl: 1, filePath: 1 }).sort({ _id: 1 });

let processed = 0, embedded = 0, failed = 0, noUrl = 0;

async function handle(img: any): Promise<void> {
	const url = urlFor(img);
	if (!url) { noUrl++; return; }
	try {
		const res = await fetch(url);
		if (!res.ok) { failed++; return; }
		const bytes = Buffer.from(await res.arrayBuffer());
		const emb = await embedImage(bytes);
		await coll.updateOne(
			{ _id: img._id },
			{ $set: { embedding: emb, embeddingVersion: EMBEDDING_VERSION } }
		);
		embedded++;
	} catch {
		failed++;
	}
}

let batch: any[] = [];
for await (const img of cursor) {
	if (LIMIT && processed >= LIMIT) break;
	batch.push(img);
	processed++;
	if (batch.length >= CONCURRENCY) {
		await Promise.all(batch.map(handle));
		batch = [];
		if (processed % 80 === 0) {
			console.log(`  ${processed}/${LIMIT || total} — embedded ${embedded}, failed ${failed}, no-url ${noUrl}`);
		}
	}
}
if (batch.length > 0) await Promise.all(batch.map(handle));

console.log('='.repeat(64));
console.log(`Processed: ${processed} — embedded ${embedded}, failed ${failed}, no-url ${noUrl}`);
await mongoose.disconnect();
