/**
 * One-time telemetry purge (Jacob approved permanent deletion, 2026-07-31).
 * TTL indexes handle the future; this clears the existing backlog:
 *   - scanner_events: ALL heartbeats (now upserted as one doc/device by the
 *     ingest endpoint), and scans/errors older than 30 days
 *   - ot2_bridge_commands: everything created more than 14 days ago
 * Traceability records (audit_log, cartridge_records, inventory_transactions)
 * are NOT touched — this is queue/telemetry data only.
 * Dry-run by default; APPLY=1 to delete.
 */
import mongoose from 'mongoose';
import * as dotenv from 'dotenv';
dotenv.config();

const APPLY = process.env.APPLY === '1';
const DAY = 86400000;

async function main() {
	await mongoose.connect(process.env.MONGODB_URI!);
	const db = mongoose.connection.db!;
	const events = db.collection('scanner_events');
	const commands = db.collection('ot2_bridge_commands');

	const heartbeats = { eventType: 'heartbeat', _id: { $not: { $regex: '^hb:' } } };
	const oldScans = { eventType: { $ne: 'heartbeat' }, receivedAt: { $lt: new Date(Date.now() - 30 * DAY) } };
	const oldCommands = { createdAt: { $lt: new Date(Date.now() - 14 * DAY) } };

	console.log('scanner_events total:', await events.estimatedDocumentCount());
	console.log('  heartbeat rows to delete:', await events.countDocuments(heartbeats));
	console.log('  non-heartbeat rows older than 30d:', await events.countDocuments(oldScans));
	console.log('ot2_bridge_commands total:', await commands.estimatedDocumentCount());
	console.log('  commands older than 14d:', await commands.countDocuments(oldCommands));

	if (APPLY) {
		console.log('\nDeleting…');
		const r1 = await events.deleteMany(heartbeats);
		console.log('  heartbeats deleted:', r1.deletedCount);
		const r2 = await events.deleteMany(oldScans);
		console.log('  old scan/error events deleted:', r2.deletedCount);
		const r3 = await commands.deleteMany(oldCommands);
		console.log('  old commands deleted:', r3.deletedCount);
		console.log('\nRemaining scanner_events:', await events.estimatedDocumentCount());
		console.log('Remaining ot2_bridge_commands:', await commands.estimatedDocumentCount());

		// Sync TTL indexes to match the models (collMod for the changed window;
		// createIndex is a no-op when an identical index already exists).
		console.log('\nSyncing TTL indexes…');
		await db.command({
			collMod: 'ot2_bridge_commands',
			index: { keyPattern: { completedAt: 1 }, expireAfterSeconds: 3 * 24 * 3600 }
		});
		console.log('  ot2 completedAt TTL → 3d');
		await commands.createIndex({ createdAt: 1 }, { expireAfterSeconds: 7 * 24 * 3600 });
		console.log('  ot2 createdAt TTL 7d created');
		await events.createIndex({ receivedAt: 1 }, { expireAfterSeconds: 30 * 24 * 3600 });
		console.log('  scanner_events receivedAt TTL 30d created');
	} else {
		console.log('\nDRY RUN — set APPLY=1 to delete');
	}
	await mongoose.disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
