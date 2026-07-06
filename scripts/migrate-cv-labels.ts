/**
 * One-time backfill: move photo QC truth from legacy cv_images fields onto
 * cartridge_records.photos[] (the new single source of truth).
 *
 *   npx tsx scripts/migrate-cv-labels.ts            # dry run (default)
 *   npx tsx scripts/migrate-cv-labels.ts --apply    # write changes
 *
 * What it copies, per cv_image with a matching photos[] entry (by imageId):
 *   - qcLabel / qcLabeledBy / qcLabeledAt          → photos[].qcLabel*        (if photo has none)
 *   - cartridgeTag.labels                          → photos[].labels          (if photo has none)
 *   - cartridgeTag.notes                           → photos[].notes           (if photo has none)
 *   - capturedBy                                   → photos[].capturedBy      (if photo has none)
 *   - metadata.highlight.{boxes,color,savedBy,savedAt} → photos[].annotations (if photo has none)
 *   - cartridgeTag.{cartridgeRecordId,phase}       → cv_images top-level cartridgeRecordId/phase
 * Fallback where a photo still has no qcLabel:
 *   - cv_inspections.humanLabel ('pass'→approved, 'fail'→rejected) + reviewedBy/At
 *
 * Idempotent: only fills gaps, never overwrites an existing value on the
 * photo entry. Never creates photos[] entries — orphan cv_images (no photo
 * entry anywhere) are counted and listed, not migrated.
 *
 * Raw-driver on purpose: legacy fields are no longer in the Mongoose schemas.
 */
import mongoose from 'mongoose';
import * as dotenv from 'dotenv';

dotenv.config();
dotenv.config({ path: '.env.local', override: false });

const URI = process.env.MONGODB_URI;
if (!URI) throw new Error('MONGODB_URI not set');

const APPLY = process.argv.includes('--apply');

async function main() {
	await mongoose.connect(URI as string);
	const db = mongoose.connection.db!;
	const cvImages = db.collection('cv_images');
	const carts = db.collection('cartridge_records');
	const inspections = db.collection('cv_inspections');

	console.log(`\n=== migrate-cv-labels ${APPLY ? '(APPLY)' : '(dry run — pass --apply to write)'} ===\n`);

	const counters = {
		scanned: 0, matched: 0, orphans: 0,
		qcLabel: 0, labels: 0, notes: 0, capturedBy: 0, annotations: 0,
		cacheBackfill: 0, humanLabelFallback: 0, skippedNoTruth: 0
	};
	const orphanIds: string[] = [];

	// Pass 1 — legacy cv_images truth → photos[]
	const cursor = cvImages.find({}, {
		projection: {
			qcLabel: 1, qcLabeledBy: 1, qcLabeledAt: 1,
			cartridgeTag: 1, cartridgeRecordId: 1, phase: 1,
			capturedBy: 1, 'metadata.highlight': 1
		}
	});

	for await (const img of cursor) {
		counters.scanned++;
		const imageId = img._id as unknown as string;
		const cartId = img.cartridgeTag?.cartridgeRecordId ?? img.cartridgeRecordId;

		const cart = await carts.findOne(
			{ 'photos.imageId': imageId },
			{ projection: { _id: 1, photos: { $elemMatch: { imageId } } } }
		);
		const photo = cart?.photos?.[0];
		if (!cart || !photo) {
			counters.orphans++;
			if (orphanIds.length < 20) orphanIds.push(imageId);
			continue;
		}
		counters.matched++;

		const set: Record<string, unknown> = {};
		if (img.qcLabel && !photo.qcLabel) {
			set['photos.$[p].qcLabel'] = img.qcLabel;
			if (img.qcLabeledBy) set['photos.$[p].qcLabeledBy'] = img.qcLabeledBy;
			if (img.qcLabeledAt) set['photos.$[p].qcLabeledAt'] = img.qcLabeledAt;
			counters.qcLabel++;
		}
		if (Array.isArray(img.cartridgeTag?.labels) && img.cartridgeTag.labels.length &&
			!(Array.isArray(photo.labels) && photo.labels.length)) {
			set['photos.$[p].labels'] = img.cartridgeTag.labels;
			counters.labels++;
		}
		if (img.cartridgeTag?.notes && !photo.notes) {
			set['photos.$[p].notes'] = img.cartridgeTag.notes;
			counters.notes++;
		}
		if (img.capturedBy && !photo.capturedBy) {
			set['photos.$[p].capturedBy'] = img.capturedBy;
			counters.capturedBy++;
		}
		const hl = img.metadata?.highlight;
		if (Array.isArray(hl?.boxes) && hl.boxes.length &&
			!(Array.isArray(photo.annotations) && photo.annotations.length)) {
			set['photos.$[p].annotations'] = hl.boxes.map((b: any) => ({
				x: b.x, y: b.y, w: b.w, h: b.h,
				...(hl.color ? { color: hl.color } : {}),
				...(hl.savedBy ? { savedBy: hl.savedBy } : {}),
				...(hl.savedAt ? { savedAt: hl.savedAt } : {})
			}));
			counters.annotations++;
		}

		if (Object.keys(set).length === 0) {
			counters.skippedNoTruth++;
		} else if (APPLY) {
			await carts.updateOne(
				{ _id: cart._id },
				{ $set: set },
				{ arrayFilters: [{ 'p.imageId': imageId }] }
			);
		}

		// Keep the technical cache's reverse lookup after cartridgeTag is stripped.
		if (cartId && (!img.cartridgeRecordId || !img.phase)) {
			counters.cacheBackfill++;
			if (APPLY) {
				await cvImages.updateOne(
					{ _id: img._id },
					{ $set: { cartridgeRecordId: cartId, ...(img.cartridgeTag?.phase ? { phase: img.cartridgeTag.phase } : {}) } }
				);
			}
		}
	}

	// Pass 2 — cv_inspections.humanLabel fallback for photos still unlabeled
	const reviewed = inspections.find(
		{ humanLabel: { $in: ['pass', 'fail'] }, imageId: { $type: 'string' } },
		{ projection: { imageId: 1, humanLabel: 1, reviewedBy: 1, reviewedAt: 1 } }
	);
	for await (const insp of reviewed) {
		const qcLabel = insp.humanLabel === 'pass' ? 'approved' : 'rejected';
		const cart = await carts.findOne(
			{ 'photos.imageId': insp.imageId },
			{ projection: { _id: 1, photos: { $elemMatch: { imageId: insp.imageId } } } }
		);
		const photo = cart?.photos?.[0];
		if (!cart || !photo || photo.qcLabel) continue;

		counters.humanLabelFallback++;
		if (APPLY) {
			await carts.updateOne(
				{ _id: cart._id },
				{ $set: {
					'photos.$[p].qcLabel': qcLabel,
					...(insp.reviewedBy ? { 'photos.$[p].qcLabeledBy': insp.reviewedBy } : {}),
					...(insp.reviewedAt ? { 'photos.$[p].qcLabeledAt': insp.reviewedAt } : {})
				}},
				{ arrayFilters: [{ 'p.imageId': insp.imageId }] }
			);
		}
	}

	console.log('cv_images scanned:              ', counters.scanned);
	console.log('  matched a photos[] entry:     ', counters.matched);
	console.log('  orphans (no photos[] entry):  ', counters.orphans, orphanIds.length ? `e.g. ${orphanIds.slice(0, 5).join(', ')}` : '');
	console.log('  nothing to migrate:           ', counters.skippedNoTruth);
	console.log('photos[] gap-fills:');
	console.log('  qcLabel:                      ', counters.qcLabel);
	console.log('  labels:                       ', counters.labels);
	console.log('  notes:                        ', counters.notes);
	console.log('  capturedBy:                   ', counters.capturedBy);
	console.log('  annotations (from highlight): ', counters.annotations);
	console.log('  qcLabel via humanLabel:       ', counters.humanLabelFallback);
	console.log('cv_images cache backfills:      ', counters.cacheBackfill);
	console.log(APPLY ? '\nDone (applied).' : '\nDry run only — nothing written.');

	await mongoose.disconnect();
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
