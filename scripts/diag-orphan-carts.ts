import mongoose from 'mongoose';
import * as dotenv from 'dotenv';
dotenv.config();
(async () => {
	await mongoose.connect(process.env.MONGODB_URI!);
	const db = mongoose.connection.db!;
	const blIds = (await db.collection('backing_lots').find({}).project({ _id: 1 }).toArray()).map((b: any) => b._id);
	const lrIds = (await db.collection('lot_records').find({}).project({ _id: 1 }).toArray()).map((l: any) => l._id);
	const knownBucket = new Set(blIds);
	const knownLotRec = new Set(lrIds);

	const carts = await db.collection('cartridge_records').find({
		'backing.lotId': { $exists: true, $ne: null },
		status: { $nin: ['voided', 'completed', 'shipped', 'scrapped', 'cancelled'] }
	}).project({ _id: 1, 'backing.lotId': 1, status: 1, createdAt: 1 }).toArray();

	const orphans = (carts as any[]).filter(c => !knownBucket.has(c.backing.lotId) && !knownLotRec.has(c.backing.lotId));
	console.log(`Orphan active carts: ${orphans.length}\n`);

	const byLotId = new Map<string, number>();
	const byStatus = new Map<string, number>();
	const byIdShape = { uuid: 0, cartPrefix: 0, other: 0 };
	for (const o of orphans as any[]) {
		byLotId.set(o.backing.lotId, (byLotId.get(o.backing.lotId) ?? 0) + 1);
		byStatus.set(o.status, (byStatus.get(o.status) ?? 0) + 1);
		if (/^CART-/.test(o._id)) byIdShape.cartPrefix++;
		else if (/^[0-9a-f-]{36}$/i.test(o._id)) byIdShape.uuid++;
		else byIdShape.other++;
	}
	console.log('By backing.lotId (unresolvable):');
	for (const [k, n] of byLotId) console.log(`  ${k}: ${n}`);
	console.log('By status:');
	for (const [k, n] of byStatus) console.log(`  ${k}: ${n}`);
	console.log('By _id shape:');
	console.log(`  CART-* seed: ${byIdShape.cartPrefix}`);
	console.log(`  UUID: ${byIdShape.uuid}`);
	console.log(`  other: ${byIdShape.other}`);

	console.log('\nSample 10 orphans:');
	for (const o of (orphans as any[]).slice(0, 10)) {
		console.log(`  ${o._id}  status=${o.status}  lotId=${o.backing.lotId}  createdAt=${o.createdAt?.toISOString?.()}`);
	}
	await mongoose.disconnect();
})();
