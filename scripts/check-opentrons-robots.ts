import * as dotenv from 'dotenv';
import mongoose from 'mongoose';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '..', '.env') });

async function main() {
	if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI missing');
	await mongoose.connect(process.env.MONGODB_URI);

	const colls = await mongoose.connection.db!.listCollections().toArray();
	console.log('Collections:', colls.map((c) => c.name).filter((n) => n.includes('robot')));
	const coll = mongoose.connection.db!.collection('opentrons_robots');
	const robots = await coll.find({}).toArray();
	console.log(`\nFound ${robots.length} OpentronsRobot doc(s):\n`);
	for (const r of robots) {
		console.log(JSON.stringify(r, null, 2));
		console.log('---');
	}
	await mongoose.disconnect();
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
