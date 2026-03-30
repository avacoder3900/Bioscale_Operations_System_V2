/**
 * One-time migration: Backfill bomType='spu' on BomItem records that have no bomType set.
 *
 * Cartridge items are always explicitly tagged bomType='cartridge' by the SKU sync,
 * so any untagged item is an SPU part. This script sets bomType='spu' on those records
 * so the BOM page filter works without the $exists fallback.
 *
 * Usage: npx tsx scripts/migrate-bomtype-backfill.ts
 */
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

async function migrate() {
	console.log('═══════════════════════════════════════════════════');
	console.log('  BomItem bomType Backfill Migration');
	console.log('═══════════════════════════════════════════════════\n');

	console.log('Connecting to MongoDB...');
	await mongoose.connect(MONGODB_URI!);
	console.log('Connected!\n');
	const db = mongoose.connection.db!;
	const col = db.collection('bom_items');

	// Count current state
	const total = await col.countDocuments({});
	const withSpu = await col.countDocuments({ bomType: 'spu' });
	const withCartridge = await col.countDocuments({ bomType: 'cartridge' });
	const withoutBomType = await col.countDocuments({
		$or: [{ bomType: { $exists: false } }, { bomType: null }]
	});

	console.log('Before migration:');
	console.log(`  Total BomItems: ${total}`);
	console.log(`  bomType='spu': ${withSpu}`);
	console.log(`  bomType='cartridge': ${withCartridge}`);
	console.log(`  bomType missing/null: ${withoutBomType}\n`);

	if (withoutBomType === 0) {
		console.log('Nothing to do — all BomItems already have bomType set.');
		await mongoose.disconnect();
		return;
	}

	// Backfill bomType='spu' on untagged items
	const result = await col.updateMany(
		{ $or: [{ bomType: { $exists: false } }, { bomType: null }] },
		{ $set: { bomType: 'spu' } }
	);

	console.log(`Updated ${result.modifiedCount} BomItem(s) with bomType='spu'.\n`);

	// Verify
	const afterSpu = await col.countDocuments({ bomType: 'spu' });
	const afterCartridge = await col.countDocuments({ bomType: 'cartridge' });
	const afterMissing = await col.countDocuments({
		$or: [{ bomType: { $exists: false } }, { bomType: null }]
	});

	console.log('After migration:');
	console.log(`  bomType='spu': ${afterSpu}`);
	console.log(`  bomType='cartridge': ${afterCartridge}`);
	console.log(`  bomType missing/null: ${afterMissing}`);

	console.log('\n═══════════════════════════════════════════════════');
	console.log('  Migration Complete');
	console.log('═══════════════════════════════════════════════════\n');

	await mongoose.disconnect();
	console.log('Disconnected from MongoDB.');
}

migrate().catch((err) => {
	console.error('Migration failed:', err);
	process.exit(1);
});
