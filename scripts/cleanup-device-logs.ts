import mongoose from 'mongoose';
import * as dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Load .env from project root
dotenv.config({ path: resolve(__dirname, '..', '.env') });

const MONGODB_URI = process.env.MONGODB_URI;
if (!MONGODB_URI) {
	console.error('MONGODB_URI not found in .env');
	process.exit(1);
}

const DEVICE_ID = '0a10aced202194944a0713b4';

const COLLECTIONS = [
	'device_logs',
	'device_crashes',
	'webhook_logs',
	'device_events',
] as const;

async function cleanup() {
	console.log('Connecting to MongoDB...');
	await mongoose.connect(MONGODB_URI!);
	console.log('Connected!');

	const db = mongoose.connection.db!;

	for (const collectionName of COLLECTIONS) {
		const collection = db.collection(collectionName);
		const result = await collection.deleteMany({ deviceId: DEVICE_ID });
		console.log(`${collectionName}: deleted ${result.deletedCount} documents`);
	}

	console.log('\nCleanup complete!');
	await mongoose.disconnect();
}

cleanup().catch((err) => {
	console.error('Cleanup failed:', err);
	process.exit(1);
});
