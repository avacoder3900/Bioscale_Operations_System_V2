/**
 * Migrate R2 CV images from `cv/{projectId}/...` to `cv/{projectNameSlug}/...`.
 *
 * Safe two-phase flow:
 *   1. npx tsx scripts/migrate-r2-to-bims-names.ts               → dry-run, report only
 *   2. npx tsx scripts/migrate-r2-to-bims-names.ts --execute     → copy to new keys + update Mongo
 *   3. npx tsx scripts/migrate-r2-to-bims-names.ts --cleanup     → delete old keys (reads log file)
 *
 * Extra flags:
 *   --project <id-or-name>   limit to one CV project
 *   --limit <n>              process at most N images
 */
import mongoose from 'mongoose';
import * as dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { S3Client, CopyObjectCommand, DeleteObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
dotenv.config({ path: resolve(__dirname, '..', '.env') });
dotenv.config({ path: resolve(__dirname, '..', '.env.local'), override: true });

const LOG_PATH = resolve(__dirname, 'r2-migration-log.json');

const args = process.argv.slice(2);
const DRY_RUN = !args.includes('--execute') && !args.includes('--cleanup');
const CLEANUP = args.includes('--cleanup');
const projectFilter = getFlag('--project');
const limit = getFlag('--limit') ? parseInt(getFlag('--limit')!) : undefined;

function getFlag(name: string): string | undefined {
	const i = args.indexOf(name);
	return i >= 0 ? args[i + 1] : undefined;
}

const MONGODB_URI = process.env.MONGODB_URI;
const R2_ACCOUNT_ID = process.env.R2_ACCOUNT_ID;
const R2_ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID;
const R2_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY;
const R2_BUCKET_NAME = process.env.R2_BUCKET_NAME || 'brevitest-cv';
const R2_PUBLIC_URL = process.env.R2_PUBLIC_URL || `https://${R2_BUCKET_NAME}.r2.dev`;
const R2_WORKER_URL = process.env.R2_WORKER_URL;

if (!MONGODB_URI) { console.error('MONGODB_URI not found'); process.exit(1); }
if (!R2_ACCOUNT_ID || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY) {
	console.error('R2 credentials missing (R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY)');
	process.exit(1);
}

// --- slug helper (mirrors src/lib/server/services/r2.ts) ---

function slugifyProjectName(name: string): string {
	const slug = name.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
	return slug || 'unnamed';
}

function getR2Url(key: string): string {
	if (R2_WORKER_URL) return `${R2_WORKER_URL}/file/${encodeURIComponent(key)}`;
	return `${R2_PUBLIC_URL}/${key}`;
}

// --- S3 client ---

const s3 = new S3Client({
	region: 'auto',
	endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
	credentials: {
		accessKeyId: R2_ACCESS_KEY_ID!,
		secretAccessKey: R2_SECRET_ACCESS_KEY!
	},
	requestChecksumCalculation: 'WHEN_REQUIRED',
	responseChecksumValidation: 'WHEN_REQUIRED'
});

async function r2Exists(key: string): Promise<boolean> {
	try {
		await s3.send(new HeadObjectCommand({ Bucket: R2_BUCKET_NAME, Key: key }));
		return true;
	} catch (err: any) {
		if (err.$metadata?.httpStatusCode === 404 || err.name === 'NotFound') return false;
		throw err;
	}
}

async function r2Copy(oldKey: string, newKey: string): Promise<void> {
	await s3.send(new CopyObjectCommand({
		Bucket: R2_BUCKET_NAME,
		CopySource: `/${R2_BUCKET_NAME}/${oldKey.split('/').map(encodeURIComponent).join('/')}`,
		Key: newKey
	}));
}

async function r2Delete(key: string): Promise<void> {
	await s3.send(new DeleteObjectCommand({ Bucket: R2_BUCKET_NAME, Key: key }));
}

// --- main ---

type MigrationEntry = { imageId: string; oldKey: string; newKey: string; oldThumb?: string; newThumb?: string };

async function runCleanup() {
	if (!existsSync(LOG_PATH)) {
		console.error(`No log at ${LOG_PATH}. Run --execute first.`);
		process.exit(1);
	}
	const log: MigrationEntry[] = JSON.parse(readFileSync(LOG_PATH, 'utf-8'));
	console.log(`Cleanup: ${log.length} entries`);
	let deleted = 0;
	let failed = 0;
	for (const e of log) {
		try {
			await r2Delete(e.oldKey);
			if (e.oldThumb) await r2Delete(e.oldThumb);
			deleted++;
			if (deleted % 25 === 0) console.log(`  deleted ${deleted}/${log.length}`);
		} catch (err: any) {
			console.error(`  FAIL ${e.oldKey}: ${err.message}`);
			failed++;
		}
	}
	console.log(`Cleanup done. Deleted: ${deleted}, Failed: ${failed}`);
}

async function runMigrate() {
	await mongoose.connect(MONGODB_URI!);
	const db = mongoose.connection.db!;
	const projects = db.collection('cv_projects');
	const images = db.collection('cv_images');
	const cartridges = db.collection('cartridge_records');

	// Load projects
	const projFilter: any = {};
	if (projectFilter) {
		projFilter.$or = [{ _id: projectFilter }, { name: projectFilter }];
	}
	const projList = await projects.find(projFilter).toArray();
	const projById = new Map(projList.map(p => [String(p._id), p]));
	console.log(`Projects in scope: ${projList.length}`);

	// Load images
	const imgFilter: any = {};
	if (projectFilter) imgFilter.projectId = { $in: projList.map(p => p._id) };
	const cursor = images.find(imgFilter);

	const log: MigrationEntry[] = [];
	let processed = 0;
	let skippedAlreadyMigrated = 0;
	let skippedNoProject = 0;
	let skippedNoPath = 0;
	let failed = 0;

	for await (const img of cursor) {
		if (limit && processed >= limit) break;

		const proj = projById.get(img.projectId);
		if (!proj) {
			if (!projectFilter) { /* project might not be in filter */ }
			skippedNoProject++;
			continue;
		}
		const oldKey = img.filePath as string | undefined;
		if (!oldKey) { skippedNoPath++; continue; }

		const slug = slugifyProjectName(proj.name);
		if (oldKey.startsWith(`cv/${slug}/`)) {
			skippedAlreadyMigrated++;
			continue;
		}

		// Build new key. Preserve the last path segment (id.ext or id_name.ext).
		const lastSlash = oldKey.lastIndexOf('/');
		const tail = lastSlash >= 0 ? oldKey.slice(lastSlash + 1) : oldKey;
		const newKey = `cv/${slug}/${tail}`;

		const oldThumb = img.thumbnailPath as string | undefined;
		let newThumb: string | undefined;
		if (oldThumb) {
			const tLast = oldThumb.lastIndexOf('/');
			const tTail = tLast >= 0 ? oldThumb.slice(tLast + 1) : oldThumb;
			newThumb = `cv/${slug}/thumbs/${tTail}`;
		}

		processed++;
		console.log(`[${processed}] ${proj.name}`);
		console.log(`   ${oldKey}`);
		console.log(`   → ${newKey}`);
		if (oldThumb && newThumb) {
			console.log(`   thumb: ${oldThumb} → ${newThumb}`);
		}

		if (DRY_RUN) continue;

		try {
			// Copy main (R2 server-side copy — no download)
			await r2Copy(oldKey, newKey);

			// Copy thumbnail if present
			if (oldThumb && newThumb) {
				try {
					await r2Copy(oldThumb, newThumb);
				} catch (err: any) {
					console.error(`   thumb copy failed (continuing): ${err.message}`);
					newThumb = undefined; // don't record; don't update Mongo thumbnailPath
				}
			}

			// Update Mongo
			const newUrl = getR2Url(newKey);
			const set: any = { filePath: newKey, imageUrl: newUrl };
			if (newThumb) set.thumbnailPath = newThumb;
			await images.updateOne({ _id: img._id }, { $set: set });

			// Update cartridge record photo entries
			await cartridges.updateMany(
				{ 'photos.imageId': img._id },
				{ $set: { 'photos.$[p].r2Key': newKey, 'photos.$[p].r2Url': newUrl } },
				{ arrayFilters: [{ 'p.imageId': img._id }] }
			);

			log.push({
				imageId: String(img._id),
				oldKey,
				newKey,
				oldThumb,
				newThumb
			});
		} catch (err: any) {
			console.error(`   FAIL: ${err.message}`);
			failed++;
		}
	}

	console.log(`\nSummary`);
	console.log(`  processed: ${processed}`);
	console.log(`  already migrated: ${skippedAlreadyMigrated}`);
	console.log(`  no project: ${skippedNoProject}`);
	console.log(`  no filePath: ${skippedNoPath}`);
	console.log(`  failed: ${failed}`);
	console.log(`  mode: ${DRY_RUN ? 'DRY-RUN (no changes)' : 'EXECUTE'}`);

	if (!DRY_RUN && log.length) {
		writeFileSync(LOG_PATH, JSON.stringify(log, null, 2));
		console.log(`\nLog written: ${LOG_PATH}`);
		console.log(`Run with --cleanup to delete old R2 keys when you're satisfied.`);
	}

	await mongoose.disconnect();
}

(CLEANUP ? runCleanup() : runMigrate()).catch(e => {
	console.error(e);
	process.exit(1);
});
