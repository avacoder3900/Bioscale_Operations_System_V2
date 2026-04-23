import mongoose from 'mongoose';
import * as dotenv from 'dotenv';
dotenv.config();
const URI = process.env.MONGODB_URI!;

async function main() {
	await mongoose.connect(URI);
	const db = mongoose.connection.db!;

	const now = new Date();
	const since3h = new Date(now.getTime() - 3 * 60 * 60 * 1000);
	const since24h = new Date(now.getTime() - 24 * 60 * 60 * 1000);

	console.log(`Now       : ${now.toISOString()}`);
	console.log(`3h cutoff : ${since3h.toISOString()}`);
	console.log(`24h cutoff: ${since24h.toISOString()}\n`);

	// Most recent BackingLots (any oven)
	console.log('=== 10 most recent BackingLots (any oven) ===');
	const recentBL = await db.collection('backing_lots')
		.find({})
		.sort({ ovenEntryTime: -1 })
		.limit(10)
		.toArray();
	for (const bl of recentBL as any[]) {
		console.log(`  _id=${bl._id}  oven="${bl.ovenLocationName}" (${bl.ovenLocationId})  entered=${bl.ovenEntryTime?.toISOString?.()}  status=${bl.status}  carts=${bl.cartridgeCount ?? '-'}`);
	}

	// Most recent cartridge backing events
	console.log('\n=== 10 most recent CartridgeRecords by backing.ovenEntryTime ===');
	const recentCarts = await db.collection('cartridge_records')
		.find({ 'backing.ovenEntryTime': { $exists: true, $ne: null } })
		.project({ _id: 1, status: 1, 'backing.lotId': 1, 'backing.ovenEntryTime': 1 })
		.sort({ 'backing.ovenEntryTime': -1 })
		.limit(10)
		.toArray();
	for (const c of recentCarts as any[]) {
		console.log(`  _id=${c._id}  status=${c.status}  backing.lotId=${c.backing?.lotId}  entered=${c.backing?.ovenEntryTime?.toISOString?.()}`);
	}

	// Past 24h: any BackingLot entries
	console.log('\n=== BackingLots with ovenEntryTime in last 24h ===');
	const recent24 = await db.collection('backing_lots').find({
		ovenEntryTime: { $gte: since24h }
	}).sort({ ovenEntryTime: -1 }).toArray();
	console.log(`Count: ${recent24.length}`);
	for (const bl of recent24 as any[]) {
		console.log(`  _id=${bl._id}  oven="${bl.ovenLocationName}"  entered=${bl.ovenEntryTime?.toISOString?.()}  status=${bl.status}`);
	}

	// Past 3h: any BackingLot entries (any oven)
	console.log('\n=== BackingLots with ovenEntryTime in last 3h (any oven) ===');
	const recent3 = await db.collection('backing_lots').find({
		ovenEntryTime: { $gte: since3h }
	}).sort({ ovenEntryTime: -1 }).toArray();
	console.log(`Count: ${recent3.length}`);
	for (const bl of recent3 as any[]) {
		console.log(`  _id=${bl._id}  oven="${bl.ovenLocationName}"  entered=${bl.ovenEntryTime?.toISOString?.()}  status=${bl.status}`);
	}

	// Also check cartridges created/updated in last 3h with status=backing
	console.log('\n=== CartridgeRecords with status=backing AND createdAt >= 3h ago ===');
	const createdRecent = await db.collection('cartridge_records')
		.find({ status: 'backing', createdAt: { $gte: since3h } })
		.project({ _id: 1, status: 1, 'backing.lotId': 1, 'backing.ovenEntryTime': 1, createdAt: 1 })
		.sort({ createdAt: -1 })
		.toArray();
	console.log(`Count: ${createdRecent.length}`);
	for (const c of createdRecent.slice(0, 20) as any[]) {
		console.log(`  _id=${c._id}  lot=${c.backing?.lotId}  created=${c.createdAt?.toISOString?.()}  ovenEntry=${c.backing?.ovenEntryTime?.toISOString?.()}`);
	}

	// Also check audit log for backing/oven entries
	console.log('\n=== AuditLog entries (last 3h) with oven/backing in action or details ===');
	const audits = await db.collection('audit_logs').find({
		timestamp: { $gte: since3h },
		$or: [
			{ action: /backing|oven|wi-?01|bucket/i },
			{ resourceType: /backing|oven|wi-?01|bucket/i }
		]
	}).sort({ timestamp: -1 }).limit(20).toArray();
	console.log(`Count: ${audits.length}`);
	for (const a of audits as any[]) {
		console.log(`  ${a.timestamp?.toISOString?.()}  action=${a.action}  resource=${a.resourceType}/${a.resourceId}  user=${a.username}`);
	}

	await mongoose.disconnect();
}
main().catch(e => { console.error(e); process.exit(1); });
