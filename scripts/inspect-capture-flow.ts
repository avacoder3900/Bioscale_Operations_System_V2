/**
 * READ-ONLY inspection of the capture → R2 → Mongo data flow.
 *
 * Proves the pipeline already works end-to-end without writing anything:
 *   1. Lists the most recent CvImage docs that carry a cartridge tag.
 *   2. For the newest one, shows the matching CartridgeRecord.photos[] entry.
 *   3. Issues a HEAD against the stored R2 URL to confirm the bytes are served.
 *
 * No inserts, no updates. Safe against the production DB.
 */
import mongoose from 'mongoose';
import * as dotenv from 'dotenv';

dotenv.config();              // .env  → MONGODB_URI
dotenv.config({ path: '.env.local', override: false }); // R2_* (only for context)

const URI = process.env.MONGODB_URI;
if (!URI) throw new Error('MONGODB_URI not set');

async function main() {
	await mongoose.connect(URI as string);
	const db = mongoose.connection.db!;

	const cvImages = db.collection('cv_images');
	const carts = db.collection('cartridge_records');

	const totalTagged = await cvImages.countDocuments({ 'cartridgeTag.cartridgeRecordId': { $exists: true, $ne: null } });
	console.log(`\n=== cv_images with a cartridge tag: ${totalTagged} total ===`);

	const recent = await cvImages
		.find({ 'cartridgeTag.cartridgeRecordId': { $exists: true, $ne: null } })
		.sort({ capturedAt: -1 })
		.limit(5)
		.toArray();

	if (recent.length === 0) {
		console.log('No tagged captures found yet — nothing has flowed through /api/cv/capture(-ingest).');
		await mongoose.disconnect();
		return;
	}

	for (const img of recent) {
		console.log(
			`\n  • ${img.cartridgeImageNumber ?? '(no number)'}` +
			`\n    imageId:    ${img._id}` +
			`\n    cartridge:  ${img.cartridgeTag?.cartridgeRecordId}  phase=${img.cartridgeTag?.phase}` +
			`\n    capturedAt: ${img.capturedAt?.toISOString?.() ?? img.capturedAt}` +
			`\n    by:         ${img.capturedBy?.username ?? '(agent/script)'}` +
			`\n    filePath:   ${img.filePath}` +
			`\n    imageUrl:   ${img.imageUrl}`
		);
	}

	// Deep-dive the newest one: confirm the back-reference on the cartridge.
	const newest = recent[0];
	const cartId = newest.cartridgeTag?.cartridgeRecordId;
	console.log(`\n=== CartridgeRecord ${cartId} ===`);
	const cart = await carts.findOne(
		{ _id: cartId as any },
		{ projection: { status: 1, photoSequence: 1, photos: 1 } }
	);
	if (!cart) {
		console.log('  Cartridge not found (orphan image?)');
	} else {
		const photosArr = Array.isArray(cart.photos) ? cart.photos : [];
		console.log(`  status=${cart.status}  photoSequence=${cart.photoSequence}  typeof photos=${typeof cart.photos}  isArray=${Array.isArray(cart.photos)}  len=${photosArr.length}`);
		if (cart.photos && !Array.isArray(cart.photos)) console.log('  raw photos value:', JSON.stringify(cart.photos).slice(0, 300));
		const match = photosArr.find((p: any) => p.imageId === newest._id);
		console.log('  back-reference for newest image:', match
			? `FOUND  num=${match.cartridgeImageNumber} r2Key=${match.r2Key}`
			: 'MISSING (image exists but no photos[] entry — mismatch!)');
	}

	// Confirm R2 actually serves the bytes (HEAD, no download) — across all 5.
	console.log(`\n=== R2 fetch check (HEAD on ${recent.length} recent images) ===`);
	for (const img of recent) {
		if (!img.imageUrl) { console.log('  (no imageUrl)'); continue; }
		try {
			const res = await fetch(img.imageUrl, { method: 'HEAD' });
			console.log(`  ${res.status}  ${img.cartridgeImageNumber}  ${res.headers.get('content-length') ?? ''}`);
		} catch (e: any) {
			console.log('  fetch failed:', e?.message);
		}
	}
	// Encoding variant: worker may expect literal slashes, not %2F.
	const workerBase = (process.env.R2_WORKER_URL || '').replace(/\/$/, '');
	if (workerBase && newest.filePath) {
		const altUrl = `${workerBase}/file/${newest.filePath}`; // un-encoded slashes
		try {
			const res = await fetch(altUrl, { method: 'HEAD' });
			console.log(`\n  variant (literal slashes) → ${res.status}  ${altUrl}`);
		} catch (e: any) { console.log('  variant fetch failed:', e?.message); }
	}

	// Does ANY cartridge have a real photos[] array with entries?
	console.log('\n=== photos[] field health across cartridge_records ===');
	const withArray = await carts.countDocuments({ photos: { $type: 'array', $ne: [] } });
	const withNonEmptyArray = await carts.countDocuments({ 'photos.0': { $exists: true } });
	console.log(`  cartridges where photos is an array: ${withArray}`);
	console.log(`  cartridges where photos has ≥1 entry: ${withNonEmptyArray}`);
	const sample = await carts.findOne({ 'photos.0': { $exists: true } }, { projection: { photos: { $slice: 1 }, status: 1 } });
	if (sample) console.log('  sample populated photos[0]:', JSON.stringify(sample.photos?.[0]).slice(0, 300));
	else console.log('  → NO cartridge anywhere has a populated photos[] array.');

	// Is R2 serving ANYTHING today? HEAD the newest image whose cartridge has a
	// real photos[] array (likely an older, known-good upload).
	console.log('\n=== R2 liveness on a known-good (populated photos[]) cartridge ===');
	const goodCart = await carts.findOne({ 'photos.0': { $exists: true } }, { projection: { photos: { $slice: -1 } } });
	const goodPhoto = goodCart?.photos?.[goodCart.photos.length - 1] ?? goodCart?.photos?.[0];
	if (goodPhoto?.r2Url) {
		const res = await fetch(goodPhoto.r2Url, { method: 'HEAD' }).catch((e) => ({ status: 'ERR ' + e?.message } as any));
		console.log(`  ${res.status}  ${goodPhoto.r2Key}`);
	}

	// Is the {} photos field a one-off, or systemic? Count cartridges that have
	// captures in cv_images but a non-array photos field.
	console.log('\n=== systemic check: cv/captures/ images vs broken photos field ===');
	const newCaptureImgs = await cvImages.countDocuments({ filePath: /^cv\/captures\// });
	console.log(`  cv_images under cv/captures/ prefix: ${newCaptureImgs}`);
	const brokenPhotos = await carts.countDocuments({ photos: { $exists: true, $not: { $type: 'array' } } });
	console.log(`  cartridge_records where photos exists but is NOT an array: ${brokenPhotos}`);

	await mongoose.disconnect();
	console.log('\nDone (read-only).');
}

main().catch((e) => { console.error(e); process.exit(1); });
