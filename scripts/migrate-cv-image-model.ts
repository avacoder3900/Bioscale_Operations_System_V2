/**
 * Migration: align existing cv_images + cartridge_records with the new
 * cartridge-first schema (PRD 1).
 *
 * What it does:
 *  1. $unset projectId on every cv_image (already null after the wipe, but defensive)
 *  2. $unset sampleId on every cv_image (unused field)
 *  3. $rename `label` -> `qcLabel` on every cv_image
 *  4. Backfill `cartridgeImageNumber` for cv_images that have cartridgeTag.cartridgeRecordId
 *     - For each (cartridge, phase) group, sort by capturedAt asc, assign _001, _002, ...
 *     - Atomically bump CartridgeRecord.photoSequence to the max assigned.
 *  5. Initialize `photoSequence: 0` on cartridges that don't have it yet (additive).
 *
 * Idempotent: rerunning is safe. Logs counts at every step.
 * Read-only by default until --apply is passed.
 *
 * Run dry: npx tsx scripts/migrate-cv-image-model.ts
 * Run for real: npx tsx scripts/migrate-cv-image-model.ts --apply
 */
import mongoose from 'mongoose';
import * as dotenv from 'dotenv';

dotenv.config();

const MONGODB_URI = process.env.MONGODB_URI;
if (!MONGODB_URI) {
	console.error('MONGODB_URI env var not set');
	process.exit(1);
}

const APPLY = process.argv.includes('--apply');

function pad(n: number): string {
	return String(n).padStart(3, '0');
}

async function main() {
	console.log(APPLY ? '🔧 APPLY MODE — writing changes.' : '🧪 DRY RUN — no writes.');
	console.log();

	await mongoose.connect(MONGODB_URI as string);
	const db = mongoose.connection.db!;
	const cvImg = db.collection('cv_images');
	const rec = db.collection('cartridge_records');

	// ===== Step 1: Drop projectId =====
	const stillHaveProjectId = await cvImg.countDocuments({ projectId: { $exists: true, $ne: null } });
	console.log(`Images still carrying non-null projectId: ${stillHaveProjectId}`);
	if (APPLY) {
		const r = await cvImg.updateMany({}, { $unset: { projectId: 1 } });
		console.log(`  → $unset projectId on all ${r.matchedCount} images.`);
	}
	console.log();

	// ===== Step 2: Drop sampleId =====
	const haveSampleId = await cvImg.countDocuments({ sampleId: { $exists: true } });
	console.log(`Images with sampleId set: ${haveSampleId}`);
	if (APPLY) {
		const r = await cvImg.updateMany({ sampleId: { $exists: true } }, { $unset: { sampleId: 1 } });
		console.log(`  → $unset sampleId on ${r.matchedCount} images.`);
	}
	console.log();

	// ===== Step 3: Rename label -> qcLabel =====
	const haveLabel = await cvImg.countDocuments({ label: { $exists: true } });
	const haveQcLabel = await cvImg.countDocuments({ qcLabel: { $exists: true } });
	console.log(`Images with old 'label' field: ${haveLabel}`);
	console.log(`Images with new 'qcLabel' field: ${haveQcLabel}`);
	if (APPLY && haveLabel > 0) {
		const r = await cvImg.updateMany({ label: { $exists: true } }, { $rename: { label: 'qcLabel' } });
		console.log(`  → $rename label -> qcLabel on ${r.matchedCount} images.`);
	}
	console.log();

	// ===== Step 4: Backfill cartridgeImageNumber =====
	const tagged = await cvImg.find({
		'cartridgeTag.cartridgeRecordId': { $exists: true, $ne: null }
	}, {
		projection: { _id: 1, 'cartridgeTag.cartridgeRecordId': 1, 'cartridgeTag.phase': 1, capturedAt: 1, createdAt: 1, cartridgeImageNumber: 1 }
	}).toArray();
	console.log(`Images with cartridgeTag.cartridgeRecordId: ${tagged.length}`);

	const alreadyNumbered = tagged.filter(t => t.cartridgeImageNumber).length;
	const needsNumber = tagged.length - alreadyNumbered;
	console.log(`  Already have cartridgeImageNumber: ${alreadyNumbered}`);
	console.log(`  Need cartridgeImageNumber:         ${needsNumber}`);

	if (needsNumber > 0) {
		// Group by cartridgeId, sort by capturedAt (fallback createdAt) ascending.
		const byCartridge = new Map<string, any[]>();
		for (const img of tagged) {
			if (img.cartridgeImageNumber) continue; // already done, skip
			const cartId = img.cartridgeTag?.cartridgeRecordId;
			if (!cartId) continue;
			const bucket = byCartridge.get(cartId) ?? [];
			bucket.push(img);
			byCartridge.set(cartId, bucket);
		}

		let totalToAssign = 0;
		for (const [cartId, imgs] of byCartridge) {
			imgs.sort((a, b) => {
				const aT = a.capturedAt ? new Date(a.capturedAt).getTime() : (a.createdAt ? new Date(a.createdAt).getTime() : 0);
				const bT = b.capturedAt ? new Date(b.capturedAt).getTime() : (b.createdAt ? new Date(b.createdAt).getTime() : 0);
				return aT - bT;
			});

			// Look up current photoSequence on the cartridge (if cartridge exists at all).
			const cartDoc = await rec.findOne({ _id: cartId }, { projection: { photoSequence: 1 } });
			let nextSeq = (cartDoc?.photoSequence ?? 0) + 1;
			const newMaxSeq = nextSeq + imgs.length - 1;

			for (const img of imgs) {
				const cartridgeImageNumber = `${cartId}_${pad(nextSeq)}`;
				totalToAssign++;
				if (APPLY) {
					await cvImg.updateOne({ _id: img._id }, { $set: { cartridgeImageNumber } });
				}
				nextSeq++;
			}

			if (APPLY && cartDoc) {
				// Bump the cartridge's counter to the max we just assigned.
				await rec.updateOne({ _id: cartId }, { $set: { photoSequence: newMaxSeq } });
			}
		}

		console.log(`  → ${APPLY ? 'Assigned' : 'Would assign'} ${totalToAssign} cartridgeImageNumber values across ${byCartridge.size} cartridges.`);
	}
	console.log();

	// ===== Step 5: Initialize photoSequence on cartridges missing it =====
	const missingSeq = await rec.countDocuments({ photoSequence: { $exists: false } });
	console.log(`Cartridges without photoSequence field: ${missingSeq}`);
	if (APPLY && missingSeq > 0) {
		const r = await rec.updateMany({ photoSequence: { $exists: false } }, { $set: { photoSequence: 0 } });
		console.log(`  → $set photoSequence:0 on ${r.matchedCount} cartridges.`);
	}
	console.log();

	// ===== Post-state =====
	if (APPLY) {
		const [stillProj, stillSample, stillLabel, missingNumber] = await Promise.all([
			cvImg.countDocuments({ projectId: { $exists: true } }),
			cvImg.countDocuments({ sampleId: { $exists: true } }),
			cvImg.countDocuments({ label: { $exists: true } }),
			cvImg.countDocuments({
				'cartridgeTag.cartridgeRecordId': { $exists: true, $ne: null },
				cartridgeImageNumber: { $exists: false }
			})
		]);
		console.log('=== POST-APPLY STATE ===');
		console.log(`Images still with projectId field:                     ${stillProj} (should be 0)`);
		console.log(`Images still with sampleId field:                      ${stillSample} (should be 0)`);
		console.log(`Images still with label field (not qcLabel):           ${stillLabel} (should be 0)`);
		console.log(`Tagged images still missing cartridgeImageNumber:      ${missingNumber} (should be 0)`);
	}

	await mongoose.disconnect();
}

main().catch(err => {
	console.error(err);
	process.exit(1);
});
