/**
 * One-off (2026-11-12): register the two SPU build buckets already in use, so
 * scanning their QR stickers on /spu/assembly-wi/build opens the right bucket.
 *
 *   Bucket 1 = 01883d73-e4dc-4530-b82a-54555d4c500f
 *   Bucket 2 = fbc6f691-28dd-4741-a778-db1835f55fca
 *
 * Writes the same shape SpuBucket (src/lib/server/db/models/spu-bucket.ts)
 * creates, plus its unique indexes and an audit_log row per bucket. Later
 * buckets are added from the page ("Add a new bucket" / scanning an unknown QR).
 *
 * Dry-run by default; APPLY=1 to write. Idempotent: a bucket already
 * registered with the same number and QR code is left alone, and any clash
 * (QR code under another number, number taken by another QR code) is reported
 * and skipped, never overwritten.
 *
 *   npx tsx scripts/register-spu-buckets-2026-11-12.ts
 *   APPLY=1 npx tsx scripts/register-spu-buckets-2026-11-12.ts
 */
import mongoose from 'mongoose';
import { nanoid } from 'nanoid';
import * as dotenv from 'dotenv';
dotenv.config();

const APPLY = process.env.APPLY === '1';
const BUCKETS = [
	{ number: 1, qrCode: '01883d73-e4dc-4530-b82a-54555d4c500f' },
	{ number: 2, qrCode: 'fbc6f691-28dd-4741-a778-db1835f55fca' }
];

async function main() {
	await mongoose.connect(process.env.MONGODB_URI!);
	const db = mongoose.connection.db!;
	const buckets = db.collection('spu_buckets');
	const audit = db.collection('audit_log');
	console.log(`${APPLY ? 'APPLY' : 'DRY RUN'} against database "${db.databaseName}"`);

	if (APPLY) {
		await buckets.createIndex({ number: 1 }, { unique: true });
		await buckets.createIndex({ qrCode: 1 }, { unique: true });
	}

	for (const b of BUCKETS) {
		const byQr = await buckets.findOne({ qrCode: b.qrCode });
		const byNumber = await buckets.findOne({ number: b.number });
		if (byQr && byQr.number === b.number) {
			console.log(`  Bucket ${b.number}: already registered (${b.qrCode}) — nothing to do`);
			continue;
		}
		if (byQr) {
			console.log(`  Bucket ${b.number}: SKIPPED — ${b.qrCode} is already Bucket ${byQr.number}`);
			continue;
		}
		if (byNumber) {
			console.log(`  Bucket ${b.number}: SKIPPED — number ${b.number} already belongs to ${byNumber.qrCode}`);
			continue;
		}
		console.log(`  Bucket ${b.number}: ${APPLY ? 'registering' : 'would register'} ${b.qrCode}`);
		if (!APPLY) continue;
		const now = new Date();
		const _id = nanoid();
		await buckets.insertOne({
			_id: _id as any,
			number: b.number,
			qrCode: b.qrCode,
			active: true,
			addedBy: { name: 'Setup script (register-spu-buckets-2026-11-12)', userId: null, username: null },
			addedAt: now,
			createdAt: now,
			updatedAt: now
		});
		await audit.insertOne({
			_id: nanoid() as any,
			tableName: 'spu_buckets',
			recordId: _id,
			action: 'INSERT',
			newData: { operation: 'spu_bucket_register', number: b.number, qrCode: b.qrCode, source: 'scripts/register-spu-buckets-2026-11-12.ts' },
			changedAt: now,
			changedBy: 'script'
		});
	}

	console.log('\nspu_buckets now:');
	for (const row of await buckets.find({}).sort({ number: 1 }).toArray()) console.log(`  Bucket ${row.number}  ${row.qrCode}${row.active === false ? '  (inactive)' : ''}`);
	await mongoose.disconnect();
}

main().catch(async (e) => {
	console.error(e);
	await mongoose.disconnect();
	process.exit(1);
});
