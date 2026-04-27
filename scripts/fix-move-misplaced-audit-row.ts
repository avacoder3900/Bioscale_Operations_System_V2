/**
 * Move the RECONCILE audit row I wrote to the wrong collection.
 *
 * My earlier reconciliation script (fix-add-34-backed-to-lot-7a1cdd32.ts)
 * wrote via raw collection.insertOne to `audit_logs` (plural). The Mongoose
 * AuditLog model maps to `audit_log` (singular). Move the row so audit
 * queries through the model see it.
 *
 * Run with --apply to execute. Without that flag, dry-run only.
 */
import mongoose from 'mongoose';
import * as dotenv from 'dotenv';
dotenv.config();

async function main() {
	const apply = process.argv.includes('--apply');
	console.log(`MODE: ${apply ? 'APPLY' : 'DRY-RUN'}\n`);

	await mongoose.connect(process.env.MONGODB_URI!);
	const db = mongoose.connection.db!;

	// Find any RECONCILE rows in the wrong collection
	const wrong = await db.collection('audit_logs').find({ action: 'RECONCILE' }).toArray();
	console.log(`Rows in WRONG collection (audit_logs plural): ${wrong.length}`);
	for (const r of wrong as any[]) {
		console.log(`  _id=${r._id} tableName=${r.tableName} recordId=${r.recordId} changedAt=${r.changedAt}`);
	}
	console.log('');

	// Check the canonical collection too — make sure we don't double-write
	const canonicalIds = (wrong as any[]).map((r: any) => r._id);
	const alreadyThere = canonicalIds.length
		? await db.collection('audit_log').find({ _id: { $in: canonicalIds } }).toArray()
		: [];
	console.log(`Of those, already in CANONICAL collection (audit_log singular): ${alreadyThere.length}`);
	console.log('');

	if (!apply) {
		console.log('DRY-RUN complete. Re-run with --apply to execute.');
		await mongoose.disconnect();
		return;
	}

	if (wrong.length === 0) {
		console.log('Nothing to move.');
		await mongoose.disconnect();
		return;
	}

	// Insert into canonical, skipping any already there. AuditLog has the
	// immutable middleware so we use the raw collection insert (the row is
	// the same row, just moved — not a new audit event).
	const toInsert = (wrong as any[]).filter((r: any) => !alreadyThere.find((a: any) => a._id === r._id));
	if (toInsert.length > 0) {
		await db.collection('audit_log').insertMany(toInsert);
		console.log(`✓ Inserted ${toInsert.length} row(s) into audit_log`);
	}

	// Remove from wrong collection
	const ids = canonicalIds;
	const result = await db.collection('audit_logs').deleteMany({ _id: { $in: ids } });
	console.log(`✓ Removed ${result.deletedCount} row(s) from audit_logs (plural)`);

	await mongoose.disconnect();
	console.log('\nDONE.');
}
main().catch((e) => { console.error(e); process.exit(1); });
