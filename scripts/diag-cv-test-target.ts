/**
 * Diagnostic: confirm the test target for the capture-ingest smoke test.
 * Run: npx tsx scripts/diag-cv-test-target.ts
 */
import mongoose from 'mongoose';
import * as dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });
dotenv.config();

const QR_CODE = '382579ef-4975-40f6-a5cc-65dfd9ba6eb0';
const PROJECT_NAME = 'fill 3';

async function main() {
	const uri = process.env.MONGODB_URI;
	if (!uri) throw new Error('MONGODB_URI not set');
	await mongoose.connect(uri);
	const db = mongoose.connection.db!;

	console.log('--- CV Project ---');
	const project = await db.collection('cv_projects').findOne({ name: PROJECT_NAME });
	if (!project) {
		console.log(`  no project named "${PROJECT_NAME}". First 10:`);
		const all = await db.collection('cv_projects').find({}, { projection: { _id: 1, name: 1 } }).limit(10).toArray();
		for (const p of all) console.log(`    ${p._id}  ${p.name}`);
	} else {
		console.log(`  _id:        ${project._id}`);
		console.log(`  name:       ${project.name}`);
		console.log(`  imageCount: ${project.imageCount}`);
	}

	console.log('\n--- Cartridge ---');
	const cart = await db.collection('cartridge_records').findOne(
		{ _id: QR_CODE as any },
		{ projection: { _id: 1, status: 1, photos: 1, createdAt: 1 } }
	);
	if (!cart) {
		console.log(`  no CartridgeRecord with _id "${QR_CODE}"`);
	} else {
		console.log(`  _id:        ${cart._id}`);
		console.log(`  status:     ${cart.status}`);
		console.log(`  photoCount: ${(cart.photos || []).length}`);
		console.log(`  createdAt:  ${cart.createdAt}`);
	}

	console.log('\n--- CvImages already tagged to this cartridge (latest 5) ---');
	const images = await db.collection('cv_images').find(
		{ 'cartridgeTag.cartridgeRecordId': QR_CODE },
		{ projection: { _id: 1, filePath: 1, 'cartridgeTag.phase': 1, capturedAt: 1 } }
	).sort({ capturedAt: -1 }).limit(5).toArray();
	if (!images.length) {
		console.log('  (none)');
	} else {
		for (const img of images) {
			console.log(`  ${img._id}  phase=${img.cartridgeTag?.phase}  filePath=${img.filePath}`);
		}
	}

	await mongoose.disconnect();
	process.exit(0);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
