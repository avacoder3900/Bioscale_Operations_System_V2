import mongoose from 'mongoose';
import * as dotenv from 'dotenv';
dotenv.config();
(async () => {
	await mongoose.connect(process.env.MONGODB_URI!);
	const db = mongoose.connection.db!;

	const nanoid = await db.collection('cartridge_records').find({
		_id: { $not: /^[0-9a-f-]{36}$/i }
	}).project({ _id: 1, status: 1, 'backing.lotId': 1, createdAt: 1 }).toArray();

	const byStatus = new Map<string, number>();
	const linked: any[] = [];
	for (const c of nanoid as any[]) {
		byStatus.set(c.status, (byStatus.get(c.status) ?? 0) + 1);
		if (c.status === 'linked') linked.push(c);
	}
	console.log(`Total non-UUID _id carts: ${nanoid.length}`);
	console.log('By status:');
	for (const [k, n] of byStatus) console.log(`  ${k}: ${n}`);
	console.log('\nActive `linked` nanoid carts:');
	for (const l of linked) {
		console.log(`  _id=${l._id}  lotId=${l.backing?.lotId ?? 'none'}  createdAt=${l.createdAt?.toISOString?.() ?? 'n/a'}`);
	}
	// The literal _id='c' and _id='5' are suspicious
	const literals = await db.collection('cartridge_records').find({
		_id: { $in: ['c', '5'] }
	}).toArray();
	console.log('\nLiteral _id="c" / "5":');
	for (const l of literals as any[]) console.log(`  _id=${l._id}  status=${l.status}  createdAt=${l.createdAt?.toISOString?.()}`);

	await mongoose.disconnect();
})();
