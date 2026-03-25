/**
 * One-time migration: rename CartridgeRecord.currentPhase → status
 * and remap assay_loaded → linked, testing → underway.
 *
 * Usage: npx tsx scripts/migrate-currentPhase-to-status.ts [--dry-run]
 */
import mongoose from 'mongoose';
import * as dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
dotenv.config({ path: resolve(__dirname, '..', '.env') });

const dryRun = process.argv.includes('--dry-run');

async function main() {
	await mongoose.connect(process.env.MONGODB_URI!);
	const db = mongoose.connection.db!;
	const col = db.collection('cartridge_records');

	console.log(dryRun ? 'DRY RUN\n' : 'LIVE RUN\n');

	// Step 1: Count documents with currentPhase
	const withCurrentPhase = await col.countDocuments({ currentPhase: { $exists: true } });
	const withStatus = await col.countDocuments({ status: { $exists: true } });
	const total = await col.countDocuments();

	console.log(`Total cartridge_records: ${total}`);
	console.log(`Documents with currentPhase: ${withCurrentPhase}`);
	console.log(`Documents with status (already migrated): ${withStatus}\n`);

	if (withCurrentPhase === 0) {
		console.log('Nothing to migrate — no documents have currentPhase field.');
		await mongoose.disconnect();
		return;
	}

	// Step 2: Copy currentPhase → status (only on docs that have currentPhase but not status)
	if (!dryRun) {
		const copyResult = await col.updateMany(
			{ currentPhase: { $exists: true }, status: { $exists: false } },
			[{ $set: { status: '$currentPhase' } }]
		);
		console.log(`Copied currentPhase → status: ${copyResult.modifiedCount} documents`);
	} else {
		const toCopy = await col.countDocuments({ currentPhase: { $exists: true }, status: { $exists: false } });
		console.log(`DRY RUN — would copy currentPhase → status on ${toCopy} documents`);
	}

	// Step 3: Remove currentPhase field
	if (!dryRun) {
		const unsetResult = await col.updateMany(
			{ currentPhase: { $exists: true } },
			{ $unset: { currentPhase: '' } }
		);
		console.log(`Removed currentPhase field: ${unsetResult.modifiedCount} documents`);
	} else {
		console.log(`DRY RUN — would remove currentPhase from ${withCurrentPhase} documents`);
	}

	// Step 4: Remap deprecated values
	const remaps = [
		{ from: 'assay_loaded', to: 'linked' },
		{ from: 'testing', to: 'underway' },
	];

	for (const { from, to } of remaps) {
		const count = await col.countDocuments({ status: from });
		if (count > 0) {
			if (!dryRun) {
				const result = await col.updateMany({ status: from }, { $set: { status: to } });
				console.log(`Remapped status '${from}' → '${to}': ${result.modifiedCount} documents`);
			} else {
				console.log(`DRY RUN — would remap '${from}' → '${to}' on ${count} documents`);
			}
		} else {
			console.log(`No documents with status '${from}' — skip`);
		}
	}

	// Step 5: Verify
	const remainingCurrentPhase = await col.countDocuments({ currentPhase: { $exists: true } });
	const finalStatusCount = await col.countDocuments({ status: { $exists: true } });
	console.log(`\nVerification:`);
	console.log(`  Documents still with currentPhase: ${remainingCurrentPhase}`);
	console.log(`  Documents with status: ${finalStatusCount}`);

	await mongoose.disconnect();
	console.log('\nDone.');
}

main().catch((err) => { console.error(err); process.exit(1); });
