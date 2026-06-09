import mongoose from 'mongoose';
import * as dotenv from 'dotenv';
dotenv.config();

async function main() {
	await mongoose.connect(process.env.MONGODB_URI!);
	const db = mongoose.connection.db!;

	// Get the checked-out set (same logic as getCheckedOutCartridgeIds)
	const removals = await db.collection('manual_cartridge_removals').find({}, { projection: { cartridgeIds: 1 } }).toArray() as any[];
	const checkedOut = new Set<string>();
	for (const r of removals) for (const cid of r.cartridgeIds ?? []) checkedOut.add(cid);
	console.log(`Checked-out cartridges total (across all manual_cartridge_removals): ${checkedOut.size}`);

	const rawFridge002 = await db.collection('cartridge_records').countDocuments({
		'waxStorage.location': 'FRIDGE-002',
		status: 'wax_stored'
	});
	const filteredFridge002 = await db.collection('cartridge_records').countDocuments({
		'waxStorage.location': 'FRIDGE-002',
		status: 'wax_stored',
		_id: { $nin: Array.from(checkedOut) }
	});
	console.log(`\nFRIDGE-002 active wax_stored:`);
	console.log(`  raw (old dashboard query):                   ${rawFridge002}`);
	console.log(`  with checkout filter (new dashboard query):  ${filteredFridge002}`);
	console.log(`  delta:                                       ${rawFridge002 - filteredFridge002}`);

	// And totals across all wax_stored
	const rawTotal = await db.collection('cartridge_records').countDocuments({ status: 'wax_stored' });
	const filteredTotal = await db.collection('cartridge_records').countDocuments({ status: 'wax_stored', _id: { $nin: Array.from(checkedOut) } });
	console.log(`\nSystem-wide wax_stored:`);
	console.log(`  raw:                                         ${rawTotal}`);
	console.log(`  with checkout filter:                        ${filteredTotal}`);

	await mongoose.disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
