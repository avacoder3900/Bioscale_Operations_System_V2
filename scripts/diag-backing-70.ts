import mongoose from 'mongoose';
import * as dotenv from 'dotenv';
dotenv.config();
(async () => {
	await mongoose.connect(process.env.MONGODB_URI!);
	const db = mongoose.connection.db!;
	const allBacking = await db.collection('cartridge_records').find({ status: 'backing' }).project({ _id: 1, 'backing.lotId': 1, createdAt: 1 }).toArray();
	console.log(`Total status='backing': ${allBacking.length}`);
	const byLot = new Map<string, number>();
	for (const c of allBacking as any[]) byLot.set(c.backing?.lotId ?? 'null', (byLot.get(c.backing?.lotId ?? 'null') ?? 0) + 1);
	for (const [k, n] of byLot) console.log(`  lotId=${k}: ${n}`);
	console.log('\nSamples:');
	for (const c of (allBacking as any[]).slice(0, 5)) console.log(`  _id=${c._id}  createdAt=${c.createdAt?.toISOString?.()}`);
	// Check BackingLot for 5522a72c
	const bl = await db.collection('backing_lots').findOne({ _id: '5522a72c-732c-4880-be50-360ca78a771d' });
	console.log('\nBackingLot 5522a72c:', bl ? `status=${(bl as any).status}, cc=${(bl as any).cartridgeCount}` : 'NOT FOUND');
	await mongoose.disconnect();
})();
