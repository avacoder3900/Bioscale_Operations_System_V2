/**
 * Rebase every PartDefinition.inventoryCount to what the transaction
 * history says it should be.
 *
 *   - Parts with no transactions → inventoryCount = 0
 *   - Parts with transactions   → inventoryCount = signed sum per
 *     transaction type:
 *         receipt | creation    → +quantity
 *         consumption | scrap   → -quantity
 *         deduction             → -quantity
 *         retraction            → -quantity  (undoes a receipt)
 *         adjustment            → +quantity  (already signed by caller)
 *
 * Signs match src/lib/server/services/inventory-transaction.ts so the
 * result equals replaying every transaction from a zero baseline.
 *
 * Usage:
 *   npx tsx scripts/rebase-inventory-from-transactions.ts --dry-run
 *   npx tsx scripts/rebase-inventory-from-transactions.ts          # writes
 *
 * Always run --dry-run first. The script prints a per-part diff
 * (old → new) and never touches the InventoryTransaction collection.
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
	if (!process.env.MONGODB_URI) {
		console.error('MONGODB_URI is not set.');
		process.exit(1);
	}
	await mongoose.connect(process.env.MONGODB_URI);
	const db = mongoose.connection.db!;
	const txCollection = db.collection('inventory_transactions');
	const partCollection = db.collection('part_definitions');

	console.log(dryRun ? '=== DRY RUN ===\n' : '=== LIVE RUN ===\n');

	// Aggregate signed total per part from transactions.
	const pipeline = [
		{ $match: { partDefinitionId: { $exists: true, $ne: null } } },
		{
			$group: {
				_id: '$partDefinitionId',
				total: {
					$sum: {
						$switch: {
							branches: [
								{ case: { $in: ['$transactionType', ['receipt', 'creation']] }, then: { $abs: '$quantity' } },
								{ case: { $in: ['$transactionType', ['consumption', 'scrap', 'deduction', 'retraction']] }, then: { $multiply: [{ $abs: '$quantity' }, -1] } },
								{ case: { $eq: ['$transactionType', 'adjustment'] }, then: '$quantity' }
							],
							default: 0
						}
					}
				},
				txCount: { $sum: 1 }
			}
		}
	];

	const byPart = new Map<string, { total: number; txCount: number }>();
	for await (const row of txCollection.aggregate(pipeline)) {
		byPart.set(String(row._id), { total: row.total, txCount: row.txCount });
	}

	// Walk every active part. Any part not in byPart gets reset to 0.
	const parts = await partCollection.find({}).project({ _id: 1, partNumber: 1, name: 1, inventoryCount: 1 }).toArray();

	let zeroedNoHistory = 0;
	let rebasedWithHistory = 0;
	let unchanged = 0;
	const changes: Array<{ partNumber: string; name: string; from: number; to: number; txCount: number }> = [];

	for (const part of parts) {
		const pid = String(part._id);
		const rec = byPart.get(pid);
		const newCount = rec ? rec.total : 0;
		const oldCount = part.inventoryCount ?? 0;

		if (newCount === oldCount) {
			unchanged++;
			continue;
		}

		changes.push({
			partNumber: part.partNumber ?? '(no partNumber)',
			name: part.name ?? '(no name)',
			from: oldCount,
			to: newCount,
			txCount: rec?.txCount ?? 0
		});

		if (rec) rebasedWithHistory++;
		else zeroedNoHistory++;

		if (!dryRun) {
			await partCollection.updateOne({ _id: part._id }, { $set: { inventoryCount: newCount } });
		}
	}

	// Sort by largest delta for readability
	changes.sort((a, b) => Math.abs(b.to - b.from) - Math.abs(a.to - a.from));
	console.log(`Parts scanned:           ${parts.length}`);
	console.log(`Unchanged:               ${unchanged}`);
	console.log(`Rebased (had history):   ${rebasedWithHistory}`);
	console.log(`Zeroed (no history):     ${zeroedNoHistory}`);
	console.log(`Total changed:           ${changes.length}\n`);

	if (changes.length) {
		console.log('Changes (old → new, tx count):');
		for (const c of changes) {
			console.log(
				`  ${c.partNumber.padEnd(14)} ${c.name.slice(0, 40).padEnd(40)} ${String(c.from).padStart(8)} → ${String(c.to).padStart(8)}   [${c.txCount} tx]`
			);
		}
	}

	if (dryRun) console.log('\nNo writes performed. Re-run without --dry-run to apply.');
	else console.log('\nWrites applied.');

	await mongoose.disconnect();
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
