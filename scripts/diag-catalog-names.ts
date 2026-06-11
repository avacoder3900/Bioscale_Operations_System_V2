import mongoose from 'mongoose';
import * as dotenv from 'dotenv';
dotenv.config();

async function main() {
	await mongoose.connect(process.env.MONGODB_URI!);
	const db = mongoose.connection.db!;

	console.log('=== All catalog names grouped by category ===');
	const all = await db
		.collection('reagent_catalog')
		.find({}, { projection: { _id: 1, name: 1, type: 1, category: 1, subcategory: 1 } })
		.sort({ category: 1, type: 1, name: 1 })
		.toArray();

	let currentBucket = '';
	for (const r of all as any[]) {
		const bucket = `${r.category ?? '<no-category>'} / ${r.type ?? '<no-type>'}`;
		if (bucket !== currentBucket) {
			console.log(`\n[${bucket}]`);
			currentBucket = bucket;
		}
		const sub = r.subcategory ? `  (${r.subcategory})` : '';
		console.log(`  ${r._id}  ${r.name}${sub}`);
	}

	await mongoose.disconnect();
}
main().catch((e) => {
	console.error(e);
	process.exit(1);
});
