/**
 * Remove all inventory transactions seeded by user "nick" and recalculate
 * inventoryCount on affected PartDefinitions.
 *
 * The InventoryTransaction model has immutable middleware, so we use the
 * native MongoDB driver to bypass it.
 *
 * Usage: npx tsx scripts/remove-nick-inventory.ts [--dry-run]
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
	const txCollection = db.collection('inventory_transactions');
	const partCollection = db.collection('part_definitions');

	console.log(dryRun ? 'DRY RUN\n' : 'LIVE RUN\n');

	// Find nick's user ID from the users collection
	const nickUser = await db.collection('users').findOne({ username: 'nick' });
	const nickId = nickUser?._id as string | undefined;
	console.log(`Nick user ID: ${nickId ?? 'not found'}`);

	// Build query to match nick by username string or user ID
	const matchConditions: any[] = [
		{ performedBy: 'nick' },
		{ operatorUsername: 'nick' }
	];
	if (nickId) {
		matchConditions.push({ performedBy: nickId });
	}
	const query = { $or: matchConditions };

	// Find all of nick's transactions
	const nickTxs = await txCollection.find(query).toArray();
	console.log(`Found ${nickTxs.length} transactions by nick\n`);

	if (nickTxs.length === 0) {
		console.log('Nothing to clean up.');
		await mongoose.disconnect();
		return;
	}

	// Summarize by part
	const partSummary = new Map<string, { partNumber: string; totalQty: number; count: number }>();
	for (const tx of nickTxs) {
		const pid = tx.partDefinitionId as string;
		if (!pid) continue;
		const entry = partSummary.get(pid) ?? { partNumber: tx.partNumber ?? '?', totalQty: 0, count: 0 };
		entry.totalQty += tx.quantity ?? 0;
		entry.count++;
		partSummary.set(pid, entry);
	}

	console.log('Affected parts:');
	for (const [pid, info] of partSummary) {
		console.log(`  ${info.partNumber} (${pid}): ${info.count} txs, net quantity: ${info.totalQty}`);
	}
	console.log();

	if (dryRun) {
		console.log('Skipping deletion (dry run).');
		await mongoose.disconnect();
		return;
	}

	// Delete nick's transactions (native driver bypasses immutable middleware)
	const result = await txCollection.deleteMany(query);
	console.log(`Deleted ${result.deletedCount} transactions\n`);

	// Recalculate inventoryCount for each affected part
	const affectedPartIds = [...partSummary.keys()];
	console.log('Recalculating inventory counts...');
	for (const partId of affectedPartIds) {
		const agg = await txCollection.aggregate([
			{ $match: { partDefinitionId: partId } },
			{ $group: { _id: null, total: { $sum: '$quantity' } } }
		]).toArray();
		const newCount = agg[0]?.total ?? 0;

		const part = await partCollection.findOne({ _id: partId });
		const oldCount = (part as any)?.inventoryCount ?? 0;

		await partCollection.updateOne(
			{ _id: partId },
			{ $set: { inventoryCount: newCount } }
		);
		console.log(`  ${(part as any)?.partNumber ?? partId}: ${oldCount} → ${newCount}`);
	}

	console.log('\nDone.');
	await mongoose.disconnect();
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
