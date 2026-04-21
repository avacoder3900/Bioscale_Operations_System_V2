import * as dotenv from 'dotenv';
import mongoose from 'mongoose';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '..', '.env') });

const RENAMES: Record<string, string> = {
	'Robot 1': 'Robot 1 B14',
	'Robot 2': 'Robot 2 R04',
	'Robot 3': 'Robot 3 B07'
};

async function main() {
	if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI missing');
	await mongoose.connect(process.env.MONGODB_URI);
	const coll = mongoose.connection.db!.collection('opentrons_robots');

	for (const [oldName, newName] of Object.entries(RENAMES)) {
		const res = await coll.updateOne(
			{ name: oldName },
			{ $set: { name: newName, updatedAt: new Date() } }
		);
		console.log(`${oldName} → ${newName}: matched=${res.matchedCount} modified=${res.modifiedCount}`);
	}

	console.log('\nFinal:');
	for (const doc of await coll.find({}).sort({ name: 1 }).toArray()) {
		console.log(`  ${doc.name}  →  ${doc.ip}`);
	}
	await mongoose.disconnect();
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
