/**
 * One-Time Data Cleanup: Parts & Accession
 *
 * Fixes corrupted data from the barcode concatenation bug:
 * 1. Deletes/fixes lot LOT-20260324-0002 (concatenated barcode)
 * 2. Verifies all existing lots have valid part._id references
 * 3. Verifies inventoryCount accuracy on affected parts
 * 4. Logs all actions to AuditLog
 *
 * Usage:
 *   npx tsx scripts/cleanup-accession-data.ts              # Execute cleanup
 *   npx tsx scripts/cleanup-accession-data.ts --dry-run    # Preview only
 */

import mongoose from 'mongoose';
import * as dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import { nanoid } from 'nanoid';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
dotenv.config({ path: resolve(__dirname, '../.env') });

const dryRun = process.argv.includes('--dry-run');

async function main() {
	const uri = process.env.MONGODB_URI;
	if (!uri) throw new Error('MONGODB_URI not set');

	console.log(`[cleanup] Connecting to MongoDB...${dryRun ? ' (DRY RUN)' : ''}`);
	await mongoose.connect(uri);
	const db = mongoose.connection.db!;

	const receivingLots = db.collection('receiving_lots');
	const partDefinitions = db.collection('part_definitions');
	const auditLogs = db.collection('audit_logs');

	// Step 1: Find and fix/delete the concatenated barcode lot
	console.log('\n--- Step 1: Fix concatenated barcode lot ---');
	const badLot = await receivingLots.findOne({ lotNumber: 'LOT-20260324-0002' });
	if (badLot) {
		console.log(`  Found lot ${badLot.lotNumber} with lotId: "${badLot.lotId?.substring(0, 40)}..."`);
		console.log(`  lotId length: ${badLot.lotId?.length} (normal is ~36 chars)`);

		if (!dryRun) {
			await receivingLots.deleteOne({ _id: badLot._id });
			console.log(`  DELETED lot ${badLot.lotNumber}`);

			// Reverse inventory impact if part exists
			if (badLot.part?._id) {
				const quantity = badLot.quantity ?? 0;
				if (quantity > 0) {
					await partDefinitions.updateOne(
						{ _id: badLot.part._id },
						{ $inc: { inventoryCount: -quantity } }
					);
					console.log(`  Reversed ${quantity} units from part ${badLot.part.partNumber}`);
				}
			}

			await auditLogs.insertOne({
				_id: nanoid(),
				tableName: 'receiving_lots',
				recordId: badLot._id,
				action: 'DELETE',
				oldData: { lotNumber: badLot.lotNumber, lotId: badLot.lotId, quantity: badLot.quantity },
				newData: null,
				changedAt: new Date(),
				changedBy: 'system:cleanup-script',
				reason: 'Cleanup: concatenated barcode from input bug'
			});
		} else {
			console.log(`  Would delete lot ${badLot.lotNumber}`);
		}
	} else {
		console.log('  Lot LOT-20260324-0002 not found (may already be cleaned up)');
	}

	// Step 2: Verify all lots have valid part references
	console.log('\n--- Step 2: Verify lot → part references ---');
	const allLots = await receivingLots.find({}).toArray();
	console.log(`  Total lots: ${allLots.length}`);

	let orphanCount = 0;
	for (const lot of allLots) {
		const partId = lot.part?._id;
		if (!partId) {
			console.log(`  WARNING: Lot ${lot.lotNumber} has no part._id`);
			orphanCount++;
			continue;
		}
		const part = await partDefinitions.findOne({ _id: partId });
		if (!part) {
			console.log(`  ORPHAN: Lot ${lot.lotNumber} references part ${partId} which does not exist`);
			orphanCount++;
		} else {
			console.log(`  OK: Lot ${lot.lotNumber} → Part ${part.partNumber} (${part.name})`);
		}
	}
	console.log(`  Orphaned lots: ${orphanCount}`);

	// Step 3: Verify inventory counts
	console.log('\n--- Step 3: Verify inventory counts ---');
	const partsWithLots = await receivingLots.aggregate([
		{ $match: { 'part._id': { $exists: true } } },
		{ $group: { _id: '$part._id', totalReceived: { $sum: '$quantity' } } }
	]).toArray();

	for (const agg of partsWithLots) {
		const part = await partDefinitions.findOne({ _id: agg._id });
		if (part) {
			console.log(`  Part ${part.partNumber}: inventoryCount=${part.inventoryCount}, totalReceived=${agg.totalReceived}`);
			if ((part.inventoryCount ?? 0) < 0) {
				console.log(`    WARNING: Negative inventory count!`);
			}
		}
	}

	// Log completion
	if (!dryRun) {
		await auditLogs.insertOne({
			_id: nanoid(),
			tableName: 'system',
			recordId: 'cleanup-accession-data',
			action: 'MIGRATION',
			oldData: null,
			newData: { lotsChecked: allLots.length, orphanCount, badLotFound: !!badLot },
			changedAt: new Date(),
			changedBy: 'system:cleanup-script',
			reason: 'Parts & accession data cleanup script completed'
		});
	}

	console.log('\n--- Cleanup complete ---');
	await mongoose.disconnect();
}

main().catch((err) => {
	console.error('Cleanup failed:', err);
	process.exit(1);
});
