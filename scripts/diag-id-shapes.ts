import mongoose from 'mongoose';
import * as dotenv from 'dotenv';
dotenv.config();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NANOID_RE = /^[A-Za-z0-9_-]{15,25}$/; // rough shape

function classify(id: string) {
	if (UUID_RE.test(id)) return 'UUID';
	if (NANOID_RE.test(id)) return 'nanoid';
	return 'other';
}

async function main() {
	await mongoose.connect(process.env.MONGODB_URI!);
	const db = mongoose.connection.db!;

	console.log('=== Shape of CartridgeRecord._id split by status ===\n');
	const groups = [
		{ label: 'WI-01 placeholders (current status=backing)', filter: { status: 'backing' } },
		{ label: 'Voided placeholders (consumed-lot cleanup)', filter: { status: 'voided' } },
		{ label: 'Wax-filling flow (wax_filled/wax_stored)', filter: { status: { $in: ['wax_filled', 'wax_stored'] } } },
		{ label: 'Later pipeline (completed/shipped/linked)', filter: { status: { $in: ['completed', 'shipped', 'linked'] } } }
	];

	for (const g of groups) {
		const sample = await db.collection('cartridge_records').find(g.filter).limit(30).project({ _id: 1 }).toArray();
		const shapes: Record<string, number> = { UUID: 0, nanoid: 0, other: 0 };
		for (const s of sample as any[]) shapes[classify(String(s._id))]++;
		const total = await db.collection('cartridge_records').countDocuments(g.filter);
		console.log(`  ${g.label}  (total=${total})`);
		console.log(`    sample(${sample.length}): UUID=${shapes.UUID}  nanoid=${shapes.nanoid}  other=${shapes.other}`);
		console.log(`    examples: ${(sample as any[]).slice(0, 3).map(s => s._id).join(', ')}`);
	}

	console.log('\n=== Origin of CartridgeRecord._id across the flow ===');
	console.log('  WI-01 call site: src/routes/manufacturing/wi-01/+page.server.ts:310 → const cid = generateId() // nanoid');
	console.log('  Wax loadDeck call site: src/routes/manufacturing/wax-filling/+page.server.ts:527 → cid = JSON.parse(cartridgeScansRaw).map(item.cartridgeId) // scanned barcode');

	await mongoose.disconnect();
}
main().catch(e => { console.error(e); process.exit(1); });
