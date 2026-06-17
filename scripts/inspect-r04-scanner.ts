import mongoose from 'mongoose';
import * as dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
dotenv.config({ path: resolve(__dirname, '..', '.env') });

const MONGODB_URI = process.env.MONGODB_URI;
if (!MONGODB_URI) {
	console.error('MONGODB_URI not found');
	process.exit(1);
}

await mongoose.connect(MONGODB_URI);
const events = await mongoose.connection
	.collection('scanner_events')
	.find({ deviceId: 'ot2-r04-scanner' })
	.sort({ receivedAt: -1 })
	.limit(8)
	.toArray();

console.log(`Found ${events.length} events for ot2-r04-scanner:`);
for (const e of events) {
	console.log(`  ${e.receivedAt.toISOString()}  ${String(e.eventType).padEnd(12)} ${e.barcode ?? ''}`);
}
process.exit(0);
