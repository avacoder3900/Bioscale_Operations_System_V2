/**
 * Dump recent ScannerEvent rows for a given deviceId. Defaults to
 * ot2-b07-scanner; pass any deviceId on the command line to inspect a
 * different scanner.
 *
 *   npx tsx scripts/inspect-scanner-events.ts                       # b07
 *   npx tsx scripts/inspect-scanner-events.ts ot2-r04-scanner       # r04
 *   npx tsx scripts/inspect-scanner-events.ts ot2-b14-scanner 20    # b14, 20 rows
 */

import mongoose from 'mongoose';
import * as dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
dotenv.config({ path: resolve(__dirname, '..', '.env') });

const deviceId = process.argv[2] ?? 'ot2-b07-scanner';
const limit = Number(process.argv[3]) || 8;

const MONGODB_URI = process.env.MONGODB_URI;
if (!MONGODB_URI) {
	console.error('MONGODB_URI not found');
	process.exit(1);
}

await mongoose.connect(MONGODB_URI);
const events = await mongoose.connection
	.collection('scanner_events')
	.find({ deviceId })
	.sort({ receivedAt: -1 })
	.limit(limit)
	.toArray();

console.log(`Found ${events.length} events for ${deviceId}:`);
for (const e of events) {
	console.log(`  ${e.receivedAt.toISOString()}  ${String(e.eventType).padEnd(12)} ${e.barcode ?? ''}`);
}
process.exit(0);
