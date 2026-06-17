/**
 * One-shot cleanup: after the refactor that stops WI-01 from creating
 * per-cartridge CartridgeRecord stubs, delete any existing nanoid stubs
 * that are still hanging around in status='backing'. They represent
 * cartridges that haven't been individuated yet — their real record will
 * be created when their UUID is scanned at wax deck loading.
 *
 * Safe because: the parent BackingLot.cartridgeCount is now the source of
 * truth for in-oven counts; these stub CartridgeRecords have no UUID, no
 * downstream lineage, and nothing references them besides aggregate counts
 * that have already been moved to BackingLot.
 */
import mongoose from 'mongoose';
import * as dotenv from 'dotenv';
dotenv.config();

const NANOID_RE = /^[A-Za-z0-9_-]{15,25}$/;

(async () => {
	const dry = process.argv.includes('--dry');
	await mongoose.connect(process.env.MONGODB_URI!);
	const db = mongoose.connection.db!;

	const stubs = await db.collection('cartridge_records').find({
		status: 'backing'
	}).project({ _id: 1, 'backing.lotId': 1 }).toArray();

	const toDelete: string[] = [];
	const keep: string[] = [];
	for (const s of stubs as any[]) {
		if (NANOID_RE.test(String(s._id))) toDelete.push(String(s._id));
		else keep.push(String(s._id));
	}

	console.log(`Found ${stubs.length} status='backing' CartridgeRecords`);
	console.log(`  nanoid stubs to delete: ${toDelete.length}`);
	console.log(`  non-nanoid (UUID?) kept: ${keep.length}`);
	if (keep.length > 0) console.log('  kept IDs:', keep.slice(0, 10));

	if (dry) {
		console.log('(dry run — no writes)');
		await mongoose.disconnect();
		return;
	}

	if (toDelete.length > 0) {
		const res = await db.collection('cartridge_records').deleteMany({
			_id: { $in: toDelete }
		});
		console.log(`Deleted: ${res.deletedCount}`);
	}
	await mongoose.disconnect();
})();
