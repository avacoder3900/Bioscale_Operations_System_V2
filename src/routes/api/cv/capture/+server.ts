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
import type { RequestHandler } from './$types';

function pad(n: number): string {
	return String(n).padStart(3, '0');
}

export const POST: RequestHandler = async ({ request, locals }) => {
	if (!locals.user) throw error(401, 'Unauthorized');

	if (!hasPermission(locals.user, 'cv:write') && !hasPermission(locals.user, 'manufacturing:write')) {
		throw error(403, 'Forbidden');
	}

	await connectDB();

	try {
		const formData = await request.formData();
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

		const buffer = Buffer.from(await file.arrayBuffer());

		// Resolve the camera view (CV-PIPELINE-V2 top/bottom split). The manual
		// toggle always wins; when it's unset, auto-classify from barcode presence
		// (the cartridge barcode shows only in top photos). Detection never blocks
		// or fails a capture — a null result leaves the view untagged.
		let effectiveView: 'top' | 'bottom' | undefined = view;
		let viewSource: 'manual' | 'barcode-auto' | undefined = view ? 'manual' : undefined;
		if (!view) {
			const hasBarcode = await detectBarcodePresence(buffer);
			if (hasBarcode !== null) {
				effectiveView = hasBarcode ? BARCODE_VIEW : NO_BARCODE_VIEW;
				viewSource = 'barcode-auto';
			}
		}

		// Pre-warm the training-embedding cache while the pixels are already in
		// memory (~150ms) — so training never has to re-fetch this photo from R2
		// and embed it in-request (cold-cache embedding is what 504'd training).
		// Best-effort: an embed failure never blocks a capture.
		let embedding: number[] | undefined;
		try {
			embedding = await embedImage(buffer);
		} catch (e) {
			console.error('[capture] embed cache-warm failed:', e instanceof Error ? e.message : e);
		}

		const imageId = generateId();
		const filenameFromClient = file.name || `${cartridgeImageNumber}.jpg`;
		const key = buildCvNamedKey('captures', imageId, `${cartridgeImageNumber}-${filenameFromClient}`);
		const contentType = file.type || 'image/jpeg';

		await uploadViaWorker(buffer, key, contentType);
		const publicUrl = getR2Url(key);

		const capturedAt = new Date();
		await CvImage.create({
			_id: imageId,
			filename: filenameFromClient,
			filePath: key,
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

		// Reagent inspection (REAGENT-INSPECT-AFTER-TOPSEAL): photographing a `sealed`
		// cart (post Cut Top Seal) advances it to reagent_qc ("photographed, awaiting
		// verdict"). The scan-gated verdict then moves it to reagent_ready/reagent_rejected.
		if (updated.status === 'sealed') {
			await CartridgeRecord.updateOne(
				{ _id: cartridgeId, status: 'sealed' },
				{ $set: { status: 'reagent_qc' } }
			);
			await AuditLog.create({
				_id: generateId(),
				tableName: 'cartridge_records',
				recordId: cartridgeId,
				action: 'reagent_inspection_photo',
				newData: { status: 'reagent_qc', from: 'sealed', imageId, phase },
				changedAt: capturedAt,
				changedBy: locals.user.username
			});
		}

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
			filePath: key,
			view: effectiveView ?? null,
			viewSource: viewSource ?? null,
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
