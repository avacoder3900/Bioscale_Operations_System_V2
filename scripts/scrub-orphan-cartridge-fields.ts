/**
 * S7 — $unset the three orphan fields removed from CartridgeRecord schema.
 *   - waxFilling.transferTimeSeconds
 *   - storage.containerBarcode
 *   - finalizedAt
 *
 * Per PRD Equipment Connectivity v2 §S7. Schema removal already landed
 * (cartridge-record.ts); this scrubs any leftover values from existing docs.
 *
 * Usage: --plan or --apply.
 */
import mongoose from 'mongoose';
import * as dotenv from 'dotenv';
dotenv.config();
import { generateId } from '../src/lib/server/db/utils.js';

const MODE: 'plan' | 'apply' | null = (() => {
	if (process.argv.includes('--apply')) return 'apply';
	if (process.argv.includes('--plan')) return 'plan';
	return null;
})();
if (!MODE) { console.error('Usage: --plan or --apply'); process.exit(1); }

async function main() {
	await mongoose.connect(process.env.MONGODB_URI!);
	const db = mongoose.connection.db!;
	const carts = db.collection('cartridge_records');

	const tCount = await carts.countDocuments({ 'waxFilling.transferTimeSeconds': { $exists: true } });
	const cCount = await carts.countDocuments({ 'storage.containerBarcode': { $exists: true } });
	const fCount = await carts.countDocuments({ finalizedAt: { $exists: true } });
	const fSet = await carts.countDocuments({ finalizedAt: { $exists: true, $ne: null } });
	console.log(`Targets: transferTimeSeconds=${tCount}  containerBarcode=${cCount}  finalizedAt(any)=${fCount}  finalizedAt(set)=${fSet}`);

	if (MODE === 'plan') {
		console.log('PLAN — would $unset on docs above. No writes.');
	} else {
		// Skip docs where finalizedAt is non-null (sacred-doc gate). The orphan
		// fields themselves are the target of removal, but if a document had
		// finalizedAt actually set we leave it alone and audit-log the skip.
		const skipFinalized = await carts.find({ finalizedAt: { $exists: true, $ne: null } }).project({ _id: 1 }).toArray() as any[];
		console.log(`Skipping ${skipFinalized.length} finalized docs.`);

		const r1 = await carts.updateMany(
			{ 'waxFilling.transferTimeSeconds': { $exists: true }, finalizedAt: { $in: [null, undefined] } },
			{ $unset: { 'waxFilling.transferTimeSeconds': '' } }
		);
		const r2 = await carts.updateMany(
			{ 'storage.containerBarcode': { $exists: true }, finalizedAt: { $in: [null, undefined] } },
			{ $unset: { 'storage.containerBarcode': '' } }
		);
		const r3 = await carts.updateMany(
			{ finalizedAt: { $exists: true, $eq: null } },
			{ $unset: { finalizedAt: '' } }
		);
		console.log(`APPLIED — transferTimeSeconds.modified=${r1.modifiedCount}  containerBarcode.modified=${r2.modifiedCount}  finalizedAt.modified=${r3.modifiedCount}`);

		await db.collection('audit_logs').insertOne({
			_id: generateId(),
			tableName: 'cartridge_records',
			recordId: 'migration-orphan-scrub-2026-04-24',
			action: 'MIGRATION_SCRUB_ORPHAN_FIELDS',
			changedBy: 'system-orphan-scrub-2026-04-24',
			changedAt: new Date(),
			newData: {
				transferTimeSecondsCleared: r1.modifiedCount,
				containerBarcodeCleared: r2.modifiedCount,
				finalizedAtCleared: r3.modifiedCount,
				finalizedSkipped: skipFinalized.length
			}
		});
	}

	await mongoose.disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
