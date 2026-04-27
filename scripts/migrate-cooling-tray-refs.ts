/**
 * S2b migration — back-fill canonical Equipment._id for every reference to
 * a cooling tray. Two collections affected:
 *   - cartridge_records.waxStorage.coolingTrayId
 *   - wax_filling_runs.coolingTrayId
 *
 * Per PRD Equipment Connectivity v2 §S2b.
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

const OPERATOR = 'system-migrate-cooling-tray-2026-04-24';

async function main() {
	await mongoose.connect(process.env.MONGODB_URI!);
	const db = mongoose.connection.db!;

	const trays = await db.collection('equipment').find({ equipmentType: 'cooling_tray' }).project({ _id: 1, name: 1, barcode: 1 }).toArray() as any[];
	const map = new Map<string, string>();
	for (const t of trays) {
		const id = String(t._id);
		map.set(id, id);
		if (t.barcode) map.set(String(t.barcode), id);
		if (t.name) map.set(String(t.name), id);
	}
	console.log(`Resolver: ${trays.length} cooling trays, ${map.size} keys.`);

	// Phase 1: cartridge_records.waxStorage.coolingTrayId
	const carts = await db.collection('cartridge_records').find({
		'waxStorage.coolingTrayId': { $exists: true, $ne: null }
	}).project({ _id: 1, 'waxStorage.coolingTrayId': 1, finalizedAt: 1 }).toArray() as any[];
	let cartNorm = 0, cartOk = 0, cartUnresolved: Array<{ _id: string; value: string }> = [];
	let cartSkipped = 0;
	for (const c of carts) {
		const value = String(c.waxStorage?.coolingTrayId ?? '');
		const equipmentId = map.get(value);
		if (!equipmentId) { cartUnresolved.push({ _id: c._id, value }); continue; }
		if (value === equipmentId) { cartOk++; continue; }
		if (c.finalizedAt) { cartSkipped++; continue; }
		if (MODE === 'apply') {
			await db.collection('cartridge_records').updateOne({ _id: c._id }, { $set: { 'waxStorage.coolingTrayId': equipmentId } });
		}
		cartNorm++;
	}

	// Phase 2: wax_filling_runs.coolingTrayId
	const runs = await db.collection('wax_filling_runs').find({
		coolingTrayId: { $exists: true, $ne: null }
	}).project({ _id: 1, coolingTrayId: 1 }).toArray() as any[];
	let runNorm = 0, runOk = 0, runUnresolved: Array<{ _id: string; value: string }> = [];
	for (const r of runs) {
		const value = String(r.coolingTrayId ?? '');
		const equipmentId = map.get(value);
		if (!equipmentId) { runUnresolved.push({ _id: r._id, value }); continue; }
		if (value === equipmentId) { runOk++; continue; }
		if (MODE === 'apply') {
			await db.collection('wax_filling_runs').updateOne({ _id: r._id }, { $set: { coolingTrayId: equipmentId } });
		}
		runNorm++;
	}

	console.log(`\n=== ${MODE.toUpperCase()} ===`);
	console.log(`cartridge waxStorage.coolingTrayId: norm=${cartNorm} ok=${cartOk} skipped_finalized=${cartSkipped} unresolved=${cartUnresolved.length}`);
	console.log(`wax_filling_runs.coolingTrayId:    norm=${runNorm} ok=${runOk} unresolved=${runUnresolved.length}`);
	for (const u of cartUnresolved.slice(0, 5)) console.log(`  cart  ${u._id} value="${u.value}"`);
	for (const u of runUnresolved.slice(0, 5)) console.log(`  run   ${u._id} value="${u.value}"`);

	if (MODE === 'apply') {
		await db.collection('audit_logs').insertOne({
			_id: generateId(),
			tableName: 'multi',
			recordId: 'migration-cooling-tray-2026-04-24',
			action: 'MIGRATION_COOLING_TRAY_NORMALIZE',
			changedBy: OPERATOR,
			changedAt: new Date(),
			newData: { cartNorm, cartOk, cartSkipped, cartUnresolved: cartUnresolved.slice(0, 50), runNorm, runOk, runUnresolved: runUnresolved.slice(0, 50) }
		});
		console.log('\nAudit log written.');
	}

	await mongoose.disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
