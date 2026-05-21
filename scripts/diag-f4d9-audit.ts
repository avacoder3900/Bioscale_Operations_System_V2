import mongoose from 'mongoose';
import * as dotenv from 'dotenv';
dotenv.config();

const STUCK = [
	'60ae9d3c-4404-4dc6-bc95-eebc6745f4d9',
	'81a981e1-e24a-4b2f-8f13-8e990f36f9d8',
	'9af7e0f7-e1af-43aa-9f8a-970e3dacccfd',
	'c360ecd3-ef49-43e0-a796-6c2957bf938f'
];

async function main() {
	await mongoose.connect(process.env.MONGODB_URI!);
	const db = mongoose.connection.db!;

	for (const cid of STUCK) {
		console.log(`\n========== CART ${cid} ==========`);
		const logs = await db.collection('audit_log').find({ recordId: cid })
			.sort({ changedAt: 1 })
			.toArray() as any[];
		console.log(`  ${logs.length} audit_log row(s) found`);
		for (const l of logs) {
			const when = l.changedAt instanceof Date ? l.changedAt.toISOString() : String(l.changedAt);
			console.log(`  [${when}] action=${l.action}  by=${l.changedBy}`);
			if (l.reason) console.log(`     reason: ${String(l.reason).slice(0, 200)}`);
			if (l.newData) {
				const d = JSON.stringify(l.newData).slice(0, 240);
				console.log(`     newData: ${d}`);
			}
		}

		// Also pull the cartridge.notes[] in case protectLockedCarts has been firing repeatedly
		const cart = await db.collection('cartridge_records').findOne({ _id: cid } as any) as any;
		const notes = cart?.notes ?? [];
		console.log(`  cart.notes[]  (${notes.length} entries)`);
		for (const n of notes) {
			const when = n.createdAt instanceof Date ? n.createdAt.toISOString() : String(n.createdAt);
			console.log(`     [${when}] ${n.phase}: ${String(n.body).slice(0, 180)}`);
		}
		console.log(`  createdAt: ${cart?.createdAt}`);
		console.log(`  manufacturingStep: ${cart?.manufacturingStep}  manufacturingStage: ${cart?.manufacturingStage}`);
	}

	await mongoose.disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
