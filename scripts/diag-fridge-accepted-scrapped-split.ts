/**
 * Verify the accepted-vs-scrapped split numbers before the UI is deployed.
 */
import mongoose from 'mongoose';
import * as dotenv from 'dotenv';
dotenv.config();

async function main() {
	await mongoose.connect(process.env.MONGODB_URI!);
	const db = mongoose.connection.db!;
	const carts = db.collection('cartridge_records');
	const removals = await db.collection('manual_cartridge_removals').find({}, { projection: { cartridgeIds: 1 } }).toArray() as any[];
	const checkedOut = new Set<string>();
	for (const r of removals) for (const cid of r.cartridgeIds ?? []) checkedOut.add(cid);

	// Accepted: status='wax_stored' AND waxStorage.location set AND not checked out
	const accepted = await carts.aggregate([
		{ $match: { status: 'wax_stored', 'waxStorage.location': { $exists: true, $ne: null }, _id: { $nin: Array.from(checkedOut) } } },
		{ $group: { _id: '$waxStorage.location', n: { $sum: 1 } } },
		{ $sort: { _id: 1 } }
	]).toArray();

	// Scrapped: status='scrapped' AND waxStorage.location set AND not checked out
	const scrapped = await carts.aggregate([
		{ $match: { status: 'scrapped', 'waxStorage.location': { $exists: true, $ne: null }, _id: { $nin: Array.from(checkedOut) } } },
		{ $group: { _id: '$waxStorage.location', n: { $sum: 1 } } },
		{ $sort: { _id: 1 } }
	]).toArray();

	console.log('Per-fridge split (checked-out excluded):');
	const locs = new Set<string>([...accepted.map((a: any) => a._id), ...scrapped.map((a: any) => a._id)]);
	let totalA = 0, totalS = 0;
	for (const loc of locs) {
		const a = (accepted.find((x: any) => x._id === loc) as any)?.n ?? 0;
		const s = (scrapped.find((x: any) => x._id === loc) as any)?.n ?? 0;
		console.log(`  ${loc}: accepted=${a}  scrapped=${s}`);
		totalA += a; totalS += s;
	}
	console.log(`\nTotals: accepted_wax=${totalA}  scrapped_wax=${totalS}`);

	await mongoose.disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
