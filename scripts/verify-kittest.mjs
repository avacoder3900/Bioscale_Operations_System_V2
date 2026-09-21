/**
 * Read-only inspection of the bioscale_kittest mirror.
 *
 * Run it BEFORE pressing "Withdraw SPU Kit" to capture the starting balances,
 * and again AFTER to see exactly what moved. Also re-asserts that the live
 * `bioscale` database was not touched.
 *
 * Usage:
 *   node scripts/verify-kittest.mjs
 */

import { MongoClient } from 'mongodb';
import { readFileSync } from 'node:fs';

const SOURCE_DB = 'bioscale';
const TARGET_DB = 'bioscale_kittest';
const IN_BUILD = ['draft', 'assembling'];

function readUri() {
	const raw = readFileSync('C:/Users/aleja/.env', 'utf8');
	for (const line of raw.split(/\r?\n/)) {
		const m = line.match(/^\s*MONGODB_URI\s*=\s*(.*)$/);
		if (m) return m[1].trim().replace(/^["']|["']$/g, '');
	}
	throw new Error('MONGODB_URI not found in C:/Users/aleja/.env');
}

async function main() {
	const client = new MongoClient(readUri(), { serverSelectionTimeoutMS: 15000 });
	await client.connect();

	const src = client.db(SOURCE_DB);
	const dst = client.db(TARGET_DB);

	console.log(`=== mirror: ${TARGET_DB} ===\n`);

	// Units eligible for withdrawal.
	const inBuild = await dst
		.collection('spus')
		.find({ status: { $in: IN_BUILD } })
		.project({ _id: 1, udi: 1, barcode: 1, status: 1 })
		.toArray();

	console.log(`in-build SPUs (eligible for withdrawal): ${inBuild.length}`);
	for (const s of inBuild.slice(0, 8)) {
		console.log(`  ${s.udi ?? s.barcode ?? s._id}  [${s.status}]`);
	}
	if (inBuild.length > 8) console.log(`  ... and ${inBuild.length - 8} more`);

	// Ledger state.
	const txns = await dst.collection('inventory_transactions').countDocuments();
	const kitTxns = await dst
		.collection('inventory_transactions')
		.countDocuments({ notes: { $regex: '^SPU kit withdrawal' } });
	console.log(`\ninventory_transactions: ${txns} total, ${kitTxns} from kit withdrawals`);

	const audits = await dst
		.collection('audit_log')
		.countDocuments({ 'newData.operation': 'spu_kit_withdrawal' });
	console.log(`audit_log kit-withdrawal entries: ${audits}`);

	// If a withdrawal has run, show what it moved.
	if (kitTxns > 0) {
		const rows = await dst
			.collection('inventory_transactions')
			.find({ notes: { $regex: '^SPU kit withdrawal' } })
			.sort({ performedAt: -1 })
			.limit(60)
			.toArray();

		const parts = await dst
			.collection('part_definitions')
			.find({ _id: { $in: [...new Set(rows.map((r) => r.partDefinitionId))] } })
			.project({ partNumber: 1, name: 1, inventoryCount: 1 })
			.toArray();
		const byId = new Map(parts.map((p) => [p._id, p]));

		console.log('\n--- what the withdrawal moved ---');
		const table = rows.map((r) => {
			const p = byId.get(r.partDefinitionId);
			return {
				part: p?.partNumber ?? r.partDefinitionId,
				qty: r.quantity,
				before: r.previousQuantity,
				after: r.newQuantity,
				live: p?.inventoryCount,
				ok: r.newQuantity === p?.inventoryCount ? 'yes' : 'MISMATCH'
			};
		});
		console.table(table);

		const bad = table.filter((t) => t.ok !== 'yes');
		console.log(
			bad.length === 0
				? `\nledger vs part_definitions: all ${table.length} lines agree`
				: `\nWARNING: ${bad.length} line(s) disagree with part_definitions`
		);
	}

	// The belt, called out specifically.
	const belt = await dst
		.collection('part_definitions')
		.findOne({ partNumber: 'PT-SPU-032' }, { projection: { partNumber: 1, name: 1, inventoryCount: 1, unitOfMeasure: 1 } });
	if (belt) {
		console.log(
			`\nPT-SPU-032 timing belt: ${belt.inventoryCount} ${belt.unitOfMeasure ?? '(unset)'}`
		);
	}

	// Prod must be untouched.
	const srcTxns = await src.collection('inventory_transactions').countDocuments();
	const srcKit = await src
		.collection('inventory_transactions')
		.countDocuments({ notes: { $regex: '^SPU kit withdrawal' } });
	console.log(`\n=== live ${SOURCE_DB} (must be untouched) ===`);
	console.log(`inventory_transactions: ${srcTxns}`);
	console.log(`kit-withdrawal rows:    ${srcKit}  <-- must stay 0`);

	await client.close();
}

main().catch((err) => {
	console.error('FAILED:', err.message);
	process.exit(1);
});
