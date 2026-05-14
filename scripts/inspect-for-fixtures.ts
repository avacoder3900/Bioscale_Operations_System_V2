/**
 * One-off: query Mongo for real IDs to plug into Ask BIMS test fixtures.
 * Run with: npx tsx scripts/inspect-for-fixtures.ts
 */
import mongoose from 'mongoose';
import * as dotenv from 'dotenv';
import {
	CartridgeRecord, ProtocolDefinition, ReagentInventory
} from '../src/lib/server/db/models';

dotenv.config();

async function main() {
	await mongoose.connect(process.env.MONGODB_URI!);

	// 1. Real cart barcode that exists (any one).
	const anyCart = await CartridgeRecord.findOne()
		.select('_id status')
		.lean() as any;
	console.log('\n=== Cart sample (for trace_reagent_chain fixture) ===');
	console.log(anyCart);

	// 2. Active protocol — preferably one with empty cellMap (the integrity gap).
	const activeProtocols = await ProtocolDefinition.find({ status: 'active' })
		.select('_id name version cellMap category')
		.limit(10)
		.lean() as any[];
	console.log('\n=== Active protocols (first 10) ===');
	for (const p of activeProtocols) {
		const cellMapEmpty = !p.cellMap || Object.keys(p.cellMap).length === 0;
		console.log(`  ${p.name} (v${p.version}) — category=${p.category} — cellMap=${cellMapEmpty ? 'EMPTY' : Object.keys(p.cellMap).length + ' keys'}`);
	}

	// 3. Active Beads variants specifically (the fixture asks about this).
	const activeBeads = await ProtocolDefinition.find({
		name: { $regex: /active beads/i }
	})
		.select('_id name version status cellMap')
		.lean() as any[];
	console.log('\n=== Active Beads protocols in Mongo ===');
	for (const p of activeBeads) {
		const cellMapEmpty = !p.cellMap || Object.keys(p.cellMap).length === 0;
		console.log(`  ${p.name} (v${p.version}) — status=${p.status} — cellMap=${cellMapEmpty ? 'EMPTY' : Object.keys(p.cellMap).length + ' keys'}`);
	}

	await mongoose.disconnect();
}

main().catch(err => { console.error(err); process.exit(1); });
