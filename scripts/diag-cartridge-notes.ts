/**
 * Verify the reagent batch notes flow end-to-end. Shows every cartridge that
 * has at least one note entry, grouped by run (via reagentFilling.runId or
 * waxFilling.runId). Run after saving a note from the UI to confirm the
 * write hit mongo.
 */
import mongoose from 'mongoose';
import * as dotenv from 'dotenv';
dotenv.config();
const URI = process.env.MONGODB_URI!;

async function main() {
	await mongoose.connect(URI);
	const db = mongoose.connection.db!;

	const cartsWithNotes = await db.collection('cartridge_records').find(
		{ 'notes.0': { $exists: true } },
		{ projection: { _id: 1, status: 1, 'reagentFilling.runId': 1, 'waxFilling.runId': 1, notes: 1 } }
	).toArray();

	console.log(`\nCartridges with at least one note: ${cartsWithNotes.length}\n`);

	if (cartsWithNotes.length === 0) {
		await mongoose.disconnect();
		return;
	}

	for (const c of cartsWithNotes as any[]) {
		const runId = c.reagentFilling?.runId ?? c.waxFilling?.runId ?? '(no run)';
		console.log(`cart ${String(c._id).slice(0, 8)}  status=${c.status}  reagentRun=${runId}`);
		for (const n of c.notes ?? []) {
			const ts = n.createdAt ? new Date(n.createdAt).toISOString() : '—';
			console.log(`    [${n.phase}] by ${n.author?.username ?? '?'} @ ${ts}  id=${String(n._id).slice(0, 6)}`);
			console.log(`        ${(n.body ?? '').split('\n').join('\n        ')}`);
		}
	}

	await mongoose.disconnect();
}
main().catch(e => { console.error(e); process.exit(1); });
