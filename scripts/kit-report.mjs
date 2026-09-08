/**
 * Post-withdrawal unit report for the bioscale_kittest mirror.
 *
 * Shows what one SPU kit withdrawal did to stock: every deducted part with its
 * before/after balance, and every excluded part with its (unchanged) balance so
 * you can see it was genuinely left alone rather than quietly missed.
 *
 * Read-only.
 */

import { MongoClient } from 'mongodb';
import { readFileSync } from 'node:fs';

const TARGET_DB = 'bioscale_kittest';

// The parts the kit is defined not to withdraw.
const EXCLUDED = [
	'PT-SPU-031',
	'PT-SPU-056',
	'PT-SPU-057',
	'PT-SPU-058',
	'PT-SPU-059',
	'PT-SPU-070',
	'PT-SPU-072',
	'PT-SPU-099',
	'PT-SPU-101',
	'PT-SPU-102',
	'PT-SPU-103'
];

function readUri() {
	const raw = readFileSync('C:/Users/aleja/.env', 'utf8');
	for (const line of raw.split(/\r?\n/)) {
		const m = line.match(/^\s*MONGODB_URI\s*=\s*(.*)$/);
		if (m) return m[1].trim().replace(/^["']|["']$/g, '');
	}
	throw new Error('MONGODB_URI not found');
}

async function main() {
	const client = new MongoClient(readUri(), { serverSelectionTimeoutMS: 15000 });
	await client.connect();
	const dst = client.db(TARGET_DB);

	const rows = await dst
		.collection('inventory_transactions')
		.find({ notes: { $regex: '^SPU kit withdrawal' } })
		.toArray();

	const ids = [...new Set(rows.map((r) => r.partDefinitionId))];
	const parts = await dst
		.collection('part_definitions')
		.find({ _id: { $in: ids } })
		.project({ partNumber: 1, name: 1, inventoryCount: 1, unitOfMeasure: 1 })
		.toArray();
	const byId = new Map(parts.map((p) => [p._id, p]));

	const deducted = rows
		.map((r) => {
			const p = byId.get(r.partDefinitionId);
			return {
				part: p?.partNumber ?? String(r.partDefinitionId),
				name: (p?.name ?? '').slice(0, 34),
				used: r.quantity,
				before: r.previousQuantity,
				after: r.newQuantity,
				unit: p?.unitOfMeasure ?? ''
			};
		})
		.sort((a, b) => a.part.localeCompare(b.part));

	console.log(`DEDUCTED - ${deducted.length} parts, ${deducted.reduce((s, d) => s + d.used, 0)} units total\n`);
	console.table(deducted);

	const exParts = await dst
		.collection('part_definitions')
		.find({ partNumber: { $in: EXCLUDED } })
		.project({ partNumber: 1, name: 1, inventoryCount: 1 })
		.toArray();
	const exByNum = new Map(exParts.map((p) => [p.partNumber, p]));

	const excluded = EXCLUDED.map((pn) => {
		const p = exByNum.get(pn);
		return {
			part: pn,
			name: (p?.name ?? 'no part definition in inventory').slice(0, 34),
			used: 0,
			stock: p ? p.inventoryCount : 'n/a',
			changed: 'no'
		};
	});

	console.log(`\nEXCLUDED - ${excluded.length} parts, 0 units deducted, balances untouched\n`);
	console.table(excluded);

	const negatives = deducted.filter((d) => d.after < 0);
	if (negatives.length) {
		console.log(`\nNEGATIVE BALANCES (${negatives.length}) - stock now below zero:`);
		for (const n of negatives) console.log(`  ${n.part}  ${n.before} -> ${n.after}`);
	}

	await client.close();
}

main().catch((e) => {
	console.error('FAILED:', e.message);
	process.exit(1);
});
