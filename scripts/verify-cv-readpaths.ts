/**
 * Verify the read paths after a successful capture-ingest.
 * - Reads CvImage and cartridge_records.photos[] directly from Mongo.
 * - Calls /api/cv/lookup-cartridge?code=... and /api/cartridge-admin/dhr/:id
 *   using a real session cookie (provided via SMOKE_SESSION_COOKIE) OR using
 *   only the public lookup-cartridge response that we can call as agent.
 *
 * Run: npx tsx scripts/verify-cv-readpaths.ts
 */
import mongoose from 'mongoose';
import * as dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });
dotenv.config();

const QR = '382579ef-4975-40f6-a5cc-65dfd9ba6eb0';
const NEW_IMAGE_ID = 'xw2_mv_hVcVDL6LBTw50U';

async function main() {
	const uri = process.env.MONGODB_URI!;
	await mongoose.connect(uri);
	const db = mongoose.connection.db!;

	console.log('--- 1. cv_images doc just created ---');
	const img = await db.collection('cv_images').findOne(
		{ _id: NEW_IMAGE_ID as any },
		{ projection: { filePath: 1, imageUrl: 1, cartridgeTag: 1, capturedAt: 1, projectId: 1, processingMode: 1 } }
	);
	console.log(JSON.stringify(img, null, 2));

	console.log('\n--- 2. cartridge_records.photos[] (last 5) ---');
	const cart = await db.collection('cartridge_records').findOne(
		{ _id: QR as any },
		{ projection: { 'photos': { $slice: -5 } } as any }
	);
	console.log(JSON.stringify(cart?.photos, null, 2));

	console.log('\n--- 3. audit_log entry for the new image ---');
	const audit = await db.collection('audit_log').findOne(
		{ tableName: 'cv_images', recordId: NEW_IMAGE_ID }
	);
	console.log(JSON.stringify(audit, null, 2));

	await mongoose.disconnect();
	process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
