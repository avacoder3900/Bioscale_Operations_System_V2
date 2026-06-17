/**
 * Consolidate the legacy `audit_logs` (plural) collection into the canonical
 * `audit_log` (singular). The Mongoose AuditLog model is pinned to the
 * singular collection — every line of production app code writes there.
 * The plural collection only exists because ~10 hand-run scripts in
 * /scripts use raw `db.collection('audit_logs')` calls that bypass the
 * model. This script merges those orphaned entries back and drops the
 * stray collection.
 *
 * Safety: confirmed 0 _id collisions between the two collections at the
 * time of writing (269 plural / 10641 singular). The merge uses
 * insertMany with ordered:false so any unexpected collision is reported
 * but doesn't abort the rest of the copy.
 *
 * Usage:
 *   npx tsx scripts/consolidate-audit-logs.ts --dry-run   (default — no writes)
 *   npx tsx scripts/consolidate-audit-logs.ts --execute   (perform the merge + drop)
 *   npx tsx scripts/consolidate-audit-logs.ts --execute --keep-plural   (merge but don't drop)
 */
import mongoose from 'mongoose';
import * as dotenv from 'dotenv';
dotenv.config();

const URI = process.env.MONGODB_URI;
if (!URI) { console.error('MONGODB_URI missing'); process.exit(1); }

const args = new Set(process.argv.slice(2));
const EXECUTE = args.has('--execute');
const KEEP_PLURAL = args.has('--keep-plural');
const DRY_RUN = !EXECUTE;

async function main() {
	await mongoose.connect(URI!);
	const db = mongoose.connection.db!;

	console.log(DRY_RUN ? '*** DRY RUN — no writes will occur ***' : '*** EXECUTE — writing changes ***');
	console.log();

	const singularBefore = await db.collection('audit_log').countDocuments({});
	const pluralBefore = await db.collection('audit_logs').countDocuments({});
	console.log(`audit_log (singular) before: ${singularBefore}`);
	console.log(`audit_logs (plural) before:  ${pluralBefore}`);

	if (pluralBefore === 0) {
		console.log('Plural collection is empty — nothing to merge.');
		await mongoose.disconnect();
		return;
	}

	// Read all plural entries and check for _id collisions against singular
	const pluralDocs = await db.collection('audit_logs').find({}).toArray();
	const pluralIds = pluralDocs.map((d: any) => d._id);
	const collisions = await db.collection('audit_log')
		.find({ _id: { $in: pluralIds } }, { projection: { _id: 1 } } as any)
		.toArray();

	console.log(`\nCollision check: ${collisions.length} of ${pluralDocs.length} plural _ids already exist in singular`);
	if (collisions.length > 0) {
		console.log('Colliding _ids (first 10):', collisions.slice(0, 10).map((c: any) => c._id));
		console.log('Colliding entries will be SKIPPED on insert (insertMany ordered:false).');
	}

	const toInsert = pluralDocs.filter((d: any) => !collisions.some((c: any) => c._id === d._id));
	console.log(`\nWould insert ${toInsert.length} entries into audit_log.`);

	// Sample a few to make the audit trail human-readable
	console.log('\nSample of entries that will be merged (first 5):');
	for (const d of toInsert.slice(0, 5) as any[]) {
		console.log(`  ${d.changedAt?.toISOString?.() ?? d.changedAt} · action=${d.action} · table=${d.tableName} · cart=${d.recordId} · by=${d.changedBy}`);
	}

	if (DRY_RUN) {
		console.log('\nDry run complete. Re-run with --execute to perform the merge.');
		await mongoose.disconnect();
		return;
	}

	// EXECUTE
	if (toInsert.length > 0) {
		const result = await db.collection('audit_log').insertMany(toInsert as any[], { ordered: false });
		console.log(`\ninsertMany inserted: ${result.insertedCount}`);
	}

	const singularAfter = await db.collection('audit_log').countDocuments({});
	console.log(`audit_log (singular) after:  ${singularAfter}  (delta +${singularAfter - singularBefore})`);

	if (KEEP_PLURAL) {
		console.log('\n--keep-plural set: leaving audit_logs in place. Drop it manually when satisfied.');
	} else {
		await db.collection('audit_logs').drop();
		console.log('\nDropped audit_logs collection.');
	}

	// Final state
	const remaining = await db.listCollections({ name: 'audit_logs' }).toArray();
	console.log(`audit_logs collection exists post-run: ${remaining.length > 0}`);

	await mongoose.disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
