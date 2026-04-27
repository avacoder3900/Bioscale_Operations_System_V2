/**
 * S2c migration — back-fill canonical Equipment._id for every deck reference.
 *   - cartridge_records.waxFilling.deckId
 *   - wax_filling_runs.deckId
 *   - reagent_batch_records.deckId
 *
 * Per PRD Equipment Connectivity v2 §S2c.
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

const OPERATOR = 'system-migrate-deck-2026-04-24';

async function migrateField(db: any, coll: string, field: string, map: Map<string, string>) {
	const filter: any = {};
	filter[field] = { $exists: true, $ne: null };
	const docs = await db.collection(coll).find(filter).project({ _id: 1, [field]: 1, finalizedAt: 1 }).toArray() as any[];
	let norm = 0, ok = 0, unresolved: Array<{ _id: string; value: string }> = [], skipped = 0;
	for (const d of docs) {
		const value = String(getNested(d, field) ?? '');
		const equipmentId = map.get(value);
		if (!equipmentId) { unresolved.push({ _id: d._id, value }); continue; }
		if (value === equipmentId) { ok++; continue; }
		if (d.finalizedAt) { skipped++; continue; }
		if (MODE === 'apply') {
			await db.collection(coll).updateOne({ _id: d._id }, { $set: { [field]: equipmentId } });
		}
		norm++;
	}
	return { norm, ok, skipped, unresolved };
}

function getNested(obj: any, path: string): any {
	return path.split('.').reduce((acc, key) => acc?.[key], obj);
}

async function main() {
	await mongoose.connect(process.env.MONGODB_URI!);
	const db = mongoose.connection.db!;

	const decks = await db.collection('equipment').find({ equipmentType: 'deck' }).project({ _id: 1, name: 1, barcode: 1 }).toArray() as any[];
	const map = new Map<string, string>();
	for (const d of decks) {
		const id = String(d._id);
		map.set(id, id);
		if (d.barcode) map.set(String(d.barcode), id);
		if (d.name) map.set(String(d.name), id);
	}
	console.log(`Resolver: ${decks.length} decks, ${map.size} keys.`);

	const cart = await migrateField(db, 'cartridge_records', 'waxFilling.deckId', map);
	const wax = await migrateField(db, 'wax_filling_runs', 'deckId', map);
	const reagent = await migrateField(db, 'reagent_batch_records', 'deckId', map);

	console.log(`\n=== ${MODE.toUpperCase()} ===`);
	console.log(`cartridge waxFilling.deckId:  norm=${cart.norm} ok=${cart.ok} skipped=${cart.skipped} unresolved=${cart.unresolved.length}`);
	console.log(`wax_filling_runs.deckId:     norm=${wax.norm} ok=${wax.ok} skipped=${wax.skipped} unresolved=${wax.unresolved.length}`);
	console.log(`reagent_batch_records.deckId: norm=${reagent.norm} ok=${reagent.ok} skipped=${reagent.skipped} unresolved=${reagent.unresolved.length}`);
	for (const u of [...cart.unresolved.slice(0, 3), ...wax.unresolved.slice(0, 3), ...reagent.unresolved.slice(0, 3)]) {
		console.log(`  unresolved: ${u._id} value="${u.value}"`);
	}

	if (MODE === 'apply') {
		await db.collection('audit_logs').insertOne({
			_id: generateId(),
			tableName: 'multi',
			recordId: 'migration-deck-2026-04-24',
			action: 'MIGRATION_DECK_NORMALIZE',
			changedBy: OPERATOR,
			changedAt: new Date(),
			newData: { cart, wax, reagent }
		});
		console.log('\nAudit log written.');
	}

	await mongoose.disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
