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
		const row = await db.collection('audit_log').findOne({ recordId: cid, action: 'UPDATE' }) as any;
		console.log(`\n=== ${cid} — first UPDATE newData full dump ===`);
		console.log(JSON.stringify(row?.newData, null, 2));
		console.log(`oldData: ${JSON.stringify(row?.oldData)?.slice(0, 600)}`);
		console.log(`changedBy=${row?.changedBy}  changedAt=${row?.changedAt}`);
	}

	// Look for ANY audit row anywhere mentioning these cart ids (recordId OR newData)
	console.log('\n\n=== Any audit_log mentioning these carts (full scan) ===');
	for (const cid of STUCK) {
		const all = await db.collection('audit_log').find({
			$or: [
				{ recordId: cid },
				{ 'newData.cartridgeId': cid },
				{ 'newData.cartridgeIds': cid },
				{ 'newData._id': cid }
			]
		}).sort({ changedAt: 1 }).project({ changedAt: 1, action: 1, changedBy: 1, tableName: 1, recordId: 1 }).toArray() as any[];
		console.log(`\n${cid}:  ${all.length} row(s)`);
		for (const r of all) {
			console.log(`  [${(r.changedAt as Date).toISOString()}] tbl=${r.tableName} act=${r.action} by=${r.changedBy} recId=${r.recordId}`);
		}
	}

	// Also dump the wax run audit history
	console.log('\n=== Wax run vXSQEUeN-UVYsKv8Vw6vX audit log ===');
	const runRows = await db.collection('audit_log').find({ recordId: 'vXSQEUeN-UVYsKv8Vw6vX' })
		.sort({ changedAt: 1 }).toArray() as any[];
	for (const r of runRows) {
		console.log(`  [${(r.changedAt as Date).toISOString()}] act=${r.action} by=${r.changedBy}`);
		if (r.newData) console.log(`     newData: ${JSON.stringify(r.newData).slice(0, 280)}`);
		if (r.oldData) console.log(`     oldData: ${JSON.stringify(r.oldData).slice(0, 280)}`);
	}

	await mongoose.disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
