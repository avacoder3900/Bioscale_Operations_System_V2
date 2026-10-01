/**
 * POST /api/cv/capture
 *
 * Single-call cartridge-first capture endpoint. Replaces the presign+record
 * two-step for the new /capture page and inline manufacturing buttons.
 *
 * Request (multipart/form-data):
 *   file:           image blob
 *   cartridgeId:    required — must match an existing CartridgeRecord
 *   phase:          required — manufacturing phase or 'post_run' for R&D
 *   cameraIndex:    optional
 *   processingMode: optional 'full' | 'raw'
 *   verdict:        optional 'approved' | 'rejected' — capture-time QC label
 *                   (PRD CV-PIPELINE-V2 Stage 2 entry point A); any other
 *                   value is a 400
 *   view:           optional 'top' | 'bottom' — camera view the photo was shot
 *                   from (top/bottom cartridge photos look completely different,
 *                   so a model trains on / grades one view). Any other non-empty
 *                   value is a 400. Routed into inference so view-scoped models
 *                   only grade their own view. When omitted, the view is
 *                   auto-classified from barcode presence (barcode ⇒ top) —
 *                   see viewSource in the response.
 *   stationId:      optional — capture station the photo came from; used for
 *                   the Stage-1 phase sanity check (warn, never block)
 *
 * Behavior:
 *   1. Auth: cv:write OR manufacturing:write (inline mfg buttons use the latter).
 *   2. Validate cartridge exists; 400 if not (orphan-reject rule).
 *   3. Atomically $inc CartridgeRecord.photoSequence to mint cartridgeImageNumber.
 *   4. Upload file via R2 Worker.
 *   5. Create CvImage doc.
 *   6. Push photo ref to CartridgeRecord.photos[].
 *   7. Return { imageId, cartridgeImageNumber, imageUrl, phase, view, viewSource }
 *      — plus a { warning } string when the posted phase disagrees with the
 *      station's assignedPhase. viewSource is 'manual' (operator toggle),
 *      'barcode-auto' (inferred here), or null (untagged).
 *
 * Future (PRD 3 Phase 4): fire-and-forget phase-X auto-inference here.
 */
import { json, error } from '@sveltejs/kit';
import { connectDB } from '$lib/server/db/connection.js';
import { CvImage } from '$lib/server/db/models/cv-image.js';
import { CartridgeRecord } from '$lib/server/db/models/cartridge-record.js';
import { CaptureStation } from '$lib/server/db/models/capture-station.js';
import { AuditLog } from '$lib/server/db/models/index.js';
import { generateId } from '$lib/server/db/utils.js';
import { uploadViaWorker, getR2Url, buildCvNamedKey } from '$lib/server/services/r2';
import { detectBarcodePresence, BARCODE_VIEW, NO_BARCODE_VIEW } from '$lib/server/services/barcode-detect';
import { embedImage, EMBEDDING_VERSION } from '$lib/server/services/cv-classifier';
import { hasPermission } from '$lib/server/permissions';
import { runPhaseInference } from '$lib/server/cv/run-inference';
import sharp from 'sharp';
import type { RequestHandler } from './$types';

// Photo-list preview: 160 px wide covers a 48 px thumbnail at 3x pixel density.
// (r2.ts's generateThumbnail is a pass-through stub, so it isn't used here.)
const THUMB_WIDTH = 160;

function makeCaptureThumbnail(buffer: Buffer): Promise<Buffer> {
	return sharp(buffer)
		.rotate()
		.resize({ width: THUMB_WIDTH, withoutEnlargement: true })
		.jpeg({ quality: 70 })
		.toBuffer();
}

function pad(n: number): string {
	return String(n).padStart(3, '0');
}

export const POST: RequestHandler = async ({ request, locals }) => {
	if (!locals.user) throw error(401, 'Unauthorized');

	if (!hasPermission(locals.user, 'cv:write') && !hasPermission(locals.user, 'manufacturing:write')) {
		throw error(403, 'Forbidden');
	}

	// Per-step timings, returned as `timingsMs` so capture pages can show where
	// a slow capture spends its time. Measurement only — no behaviour change.
	const t0 = performance.now();
	let tLap = t0;
	const timingsMs: Record<string, number> = {};
	const lap = (step: string) => {
		const now = performance.now();
		timingsMs[step] = (timingsMs[step] ?? 0) + Math.round(now - tLap);
		tLap = now;
	};

	await connectDB();
	lap('connect');

	try {
		const formData = await request.formData();
		lap('parse');
		const file = formData.get('file') as File | null;
		const cartridgeId = formData.get('cartridgeId')?.toString().trim();
		const phase = formData.get('phase')?.toString().trim();
		const cameraIndexRaw = formData.get('cameraIndex')?.toString();
		const processingMode = formData.get('processingMode')?.toString() as 'full' | 'raw' | undefined;

		// Optional R&D forensic notes — only set when /cv/forensic-capture sends one.
		const forensicNotes = formData.get('forensicNotes')?.toString().trim() || undefined;
		const forensic = forensicNotes ? { notes: forensicNotes } : undefined;

		// Optional common-failure tagging at capture time (select-only labels from
		// FailureLabel, plus a free-text note) — both land on cartridgeTag, distinct
		// from the forensic notes above.
		const labelsRaw = formData.get('labels')?.toString();
		let labels: string[] = [];
		if (labelsRaw) {
			try {
				const parsed = JSON.parse(labelsRaw);
				if (Array.isArray(parsed)) labels = parsed.filter((l): l is string => typeof l === 'string');
			} catch { /* ignore malformed labels payload */ }
		}
		const cartridgeTagNotes = formData.get('notes')?.toString().trim() || undefined;

		// Optional capture-time QC verdict (CV-PIPELINE-V2 Stage 2 entry point A) —
		// writes the same qcLabel the labeling UIs use, attributed to the operator.
		// Empty string (an unset form control) is treated as "no verdict".
		const verdictRaw = formData.get('verdict')?.toString().trim() || undefined;
		if (verdictRaw !== undefined && verdictRaw !== 'approved' && verdictRaw !== 'rejected') {
			return json({ error: `verdict must be 'approved' or 'rejected'` }, { status: 400 });
		}
		const verdict = verdictRaw as 'approved' | 'rejected' | undefined;

		// Optional camera view (CV-PIPELINE-V2 top/bottom split) — top and bottom
		// cartridge photos look completely different, so a model grades one view.
		// Empty string (an unset toggle) is treated as "no view".
		const viewRaw = formData.get('view')?.toString().trim() || undefined;
		if (viewRaw !== undefined && viewRaw !== 'top' && viewRaw !== 'bottom') {
			return json({ error: `view must be 'top' or 'bottom'` }, { status: 400 });
		}
		const view = viewRaw as 'top' | 'bottom' | undefined;

		// Optional station identity — drives the Stage-1 phase sanity check below.
		const stationId = formData.get('stationId')?.toString().trim() || undefined;

		if (!file) return json({ error: 'file is required' }, { status: 400 });
		if (!cartridgeId) return json({ error: 'cartridgeId is required' }, { status: 400 });
		if (!phase) return json({ error: 'phase is required' }, { status: 400 });

		// Station sanity check (CV-PIPELINE-V2 Stage 1): a capture posted from a
		// station assigned to a different phase is almost always "wrong station
		// selected in the dropdown". Warn in the success response — never block.
		let warning: string | undefined;
		if (stationId) {
			const station = await CaptureStation.findById(stationId)
				.select('name assignedPhase')
				.lean() as any;
			if (station?.assignedPhase && station.assignedPhase !== phase) {
				warning = `station ${station.name} is assigned to ${station.assignedPhase} but this capture was tagged ${phase}`;
			}
		}

		// Atomic $inc serves double duty: validates cartridge exists AND mints a
		// race-free sequence number. null updated = cartridge doesn't exist.
		const updated = await CartridgeRecord.findOneAndUpdate(
			{ _id: cartridgeId },
			{ $inc: { photoSequence: 1 } },
			{ new: true, projection: { photoSequence: 1, status: 1 } }
		).lean() as any;

		if (!updated) {
			return json({ error: `Cartridge ${cartridgeId} not found in BIMS` }, { status: 400 });
		}

		const seq = updated.photoSequence;
		const cartridgeImageNumber = `${cartridgeId}_${pad(seq)}`;
		lap('db');

		const buffer = Buffer.from(await file.arrayBuffer());
		lap('parse');

		const imageId = generateId();
		const filenameFromClient = file.name || `${cartridgeImageNumber}.jpg`;
		const key = buildCvNamedKey('captures', imageId, `${cartridgeImageNumber}-${filenameFromClient}`);
		const thumbKey = buildCvNamedKey('captures', imageId, `${cartridgeImageNumber}-thumb.jpg`);
		const contentType = file.type || 'image/jpeg';

		// The four pixel-level steps don't depend on each other, so they run
		// concurrently — the wait is the slowest one instead of the sum. Each is
		// still timed on its own; `parallel` is the wall time of the block.
		//   - barcode: resolve the camera view (CV-PIPELINE-V2 top/bottom split).
		//     The manual toggle always wins; when unset, auto-classify from barcode
		//     presence (the cartridge barcode shows only in top photos). Never
		//     throws — a null result leaves the view untagged.
		//   - embed: pre-warm the training-embedding cache while the pixels are in
		//     memory (cold-cache embedding is what 504'd training). Best-effort.
		//   - storage: the original upload. A failure here fails the capture, as
		//     before (rejects Promise.all → caught below → 500).
		//   - thumb: small preview for photo lists. Best-effort — lists fall back
		//     to the full image when thumbnailPath is unset.
		const timed = async <T>(step: string, p: Promise<T>): Promise<T> => {
			const start = performance.now();
			try {
				return await p;
			} finally {
				timingsMs[step] = Math.round(performance.now() - start);
			}
		};
		const parallelStart = performance.now();
		const [hasBarcode, embedding, , thumbnailPath] = await Promise.all([
			timed('barcode', view ? Promise.resolve(null) : detectBarcodePresence(buffer)),
			timed(
				'embed',
				embedImage(buffer).catch((e): undefined => {
					console.error('[capture] embed cache-warm failed:', e instanceof Error ? e.message : e);
					return undefined;
				})
			),
			timed('storage', uploadViaWorker(buffer, key, contentType)),
			timed(
				'thumb',
				makeCaptureThumbnail(buffer)
					.then((thumb) => uploadViaWorker(thumb, thumbKey, 'image/jpeg'))
					.then((): string => thumbKey)
					.catch((e): undefined => {
						console.error('[capture] thumbnail failed:', e instanceof Error ? e.message : e);
						return undefined;
					})
			)
		]);
		timingsMs.parallel = Math.round(performance.now() - parallelStart);
		tLap = performance.now();

		let effectiveView: 'top' | 'bottom' | undefined = view;
		let viewSource: 'manual' | 'barcode-auto' | undefined = view ? 'manual' : undefined;
		if (!view && hasBarcode !== null) {
			effectiveView = hasBarcode ? BARCODE_VIEW : NO_BARCODE_VIEW;
			viewSource = 'barcode-auto';
		}
		const publicUrl = getR2Url(key);

		const capturedAt = new Date();
		await CvImage.create({
			_id: imageId,
			filename: filenameFromClient,
			filePath: key,
			...(thumbnailPath ? { thumbnailPath } : {}),
			fileSizeBytes: buffer.length,
			cameraIndex: cameraIndexRaw ? Number.parseInt(cameraIndexRaw, 10) : undefined,
			capturedAt,
			capturedBy: { _id: locals.user._id, username: locals.user.username },
			imageUrl: publicUrl,
			processingMode: processingMode === 'raw' || processingMode === 'full' ? processingMode : undefined,
			cartridgeTag: {
				cartridgeRecordId: cartridgeId,
				phase,
				...(labels.length > 0 ? { labels } : {}),
				...(cartridgeTagNotes ? { notes: cartridgeTagNotes } : {})
			},
			cartridgeImageNumber,
			...(embedding ? { embedding, embeddingVersion: EMBEDDING_VERSION } : {}),
			...(effectiveView ? { view: effectiveView } : {}),
			...(viewSource ? { viewSource } : {}),
			...(verdict
				? {
					qcLabel: verdict,
					qcLabeledBy: { _id: locals.user._id, username: locals.user.username },
					qcLabeledAt: capturedAt
				}
				: {}),
			...(forensic ? { metadata: { forensic } } : {})
		});

		// Capture-time verdict is a QC decision — audit it like the other
		// cartridge-status writes below.
		if (verdict) {
			await AuditLog.create({
				_id: generateId(),
				tableName: 'cv_images',
				recordId: imageId,
				action: 'capture_verdict',
				newData: { qcLabel: verdict, cartridgeId, phase },
				changedAt: capturedAt,
				changedBy: locals.user.username
			});
		}

		// A batch of legacy cartridges have a malformed (non-array) `photos`
		// field, so a plain $push throws "must be an array but is of type …".
		// Use a pipeline update to coerce photos to [] when it isn't an array,
		// then append — atomic, self-healing, and a no-op shape change for the
		// well-formed majority. $literal keeps the entry stored verbatim (so a
		// '$' or '.' in any value isn't parsed as an aggregation expression).
		const photoEntry = { imageId, phase, capturedAt, r2Key: key, r2Url: publicUrl, cartridgeImageNumber };
		await CartridgeRecord.updateOne(
			{ _id: cartridgeId },
			[
				{
					$set: {
						photos: {
							$concatArrays: [
								{ $cond: [{ $isArray: '$photos' }, '$photos', []] },
								{ $literal: [photoEntry] }
							]
						}
					}
				}
			],
			// Mongoose 9 requires opting in to array (aggregation-pipeline) updates.
			{ updatePipeline: true }
		);

		// WAX-SIMPLIFY-2: photographing a wax-stage cart no longer changes its status
		// (the old wax_stored → wax_qc auto-advance is gone). Wax rejects are an
		// explicit POST /api/cv/wax-verdict from the Wax Reject page.

		// Reagent inspection (REAGENT-TOPSEAL-IMPLICIT, supersedes
		// REAGENT-INSPECT-AFTER-TOPSEAL): photographing a `reagent_filled` cart
		// advances it to reagent_qc ("photographed, awaiting verdict"). Top sealing
		// is implicit between reagent fill and this photo — there is no longer a
		// `sealed` hop. Legacy `sealed` carts (pre-migration) are accepted too so
		// nothing strands. The scan-gated verdict then moves it to
		// reagent_ready / reagent_rejected.
		if (updated.status === 'reagent_filled' || updated.status === 'sealed') {
			const from = updated.status;
			await CartridgeRecord.updateOne(
				{ _id: cartridgeId, status: from },
				{ $set: { status: 'reagent_qc' } }
			);
			await AuditLog.create({
				_id: generateId(),
				tableName: 'cartridge_records',
				recordId: cartridgeId,
				action: 'reagent_inspection_photo',
				newData: { status: 'reagent_qc', from, imageId, phase },
				changedAt: capturedAt,
				changedBy: locals.user.username
			});
		}

		lap('db');
		timingsMs.total = Math.round(performance.now() - t0);

		// Fire-and-forget: any project deploying at this phase runs inference.
		// Errors are swallowed inside runPhaseInference — capture response always
		// succeeds regardless of inference state.
		runPhaseInference({
			imageId,
			imageUrl: publicUrl,
			cartridgeRecordId: cartridgeId,
			phase,
			view: effectiveView ?? null,
			triggeredBy: 'auto-on-capture'
		}).catch(err => console.error('[capture] phase-inference failed:', err));

		return json({
			imageId,
			cartridgeImageNumber,
			cartridgeRecordId: cartridgeId,
			phase,
			imageUrl: publicUrl,
			thumbnailUrl: thumbnailPath ? getR2Url(thumbnailPath) : null,
			filePath: key,
			view: effectiveView ?? null,
			viewSource: viewSource ?? null,
			timingsMs,
			...(warning ? { warning } : {})
		}, { status: 201 });
	} catch (e: any) {
		// Surface the underlying error to the operator UI instead of a bare 500.
		// Typical culprits: R2_WORKER_URL missing, R2_UPLOAD_SECRET wrong, R2 worker
		// returning non-2xx. Server log keeps the full stack for ops triage.
		console.error('[api/cv/capture] failed:', e);
		return json({ error: e?.message ?? 'Capture failed' }, { status: 500 });
	}
};
