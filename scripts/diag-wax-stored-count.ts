import mongoose from 'mongoose';
import * as dotenv from 'dotenv';
dotenv.config();

async function main() {
	await mongoose.connect(process.env.MONGODB_URI!);
	const db = mongoose.connection.db!;
	const n = await db.collection('cartridge_records').countDocuments({ status: 'wax_stored' });
	console.log(`wax_stored cartridges: ${n}`);
	if (n > 0) {
		const sample = await db.collection('cartridge_records').find({ status: 'wax_stored' }).limit(3).project({ _id: 1, 'waxStorage.location': 1 }).toArray();
		console.log('sample:');
		for (const s of sample as any[]) console.log(`  ${s._id}  loc=${s.waxStorage?.location}`);
	}
	await mongoose.disconnect();
}
main().catch(e => { console.error(e); process.exit(1); });
