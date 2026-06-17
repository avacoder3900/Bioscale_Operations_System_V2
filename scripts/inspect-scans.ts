import mongoose from 'mongoose';
import * as dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
dotenv.config({ path: resolve(__dirname, '..', '.env') });

const MONGODB_URI = process.env.MONGODB_URI;
if (!MONGODB_URI) {
	console.error('MONGODB_URI not found in .env');
	process.exit(1);
}

await mongoose.connect(MONGODB_URI);
const events = await mongoose.connection
	.collection('scanner_events')
	.find({ deviceId: 'test-scanner-1', eventType: 'scan' })
	.sort({ receivedAt: -1 })
	.limit(5)
	.toArray();

for (const e of events) {
	console.log('---');
	console.log('time   :', e.receivedAt);
	console.log('barcode:', JSON.stringify(e.barcode));
	console.log('rawHex :', e.rawPayload);
	if (e.rawPayload) {
		const bytes = Buffer.from(e.rawPayload, 'hex');
		const ascii = Array.from(bytes)
			.map((b) => (b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : '.'))
			.join('');
		console.log('ascii  :', ascii);
		console.log('len    :', bytes.length);
	}
}
process.exit(0);
