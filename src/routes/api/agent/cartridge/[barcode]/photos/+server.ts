import { json } from '@sveltejs/kit';
import { requireAgentApiKey } from '$lib/server/api-auth';
import { connectDB, CartridgeRecord, CvImage } from '$lib/server/db';
import { getR2Url } from '$lib/server/services/r2';
import type { RequestHandler } from './$types';

/**
 * GET /api/agent/cartridge/[barcode]/photos
 *
 * Cross-app read endpoint for the brevitest-research app. Given a cartridge
 * barcode (= CartridgeRecord._id, which is the scanned UUID), returns every
 * captured photo grouped by the manufacturing/QC STATE (phase) it was taken
 * in, plus the cartridge's tags (union of per-image labels) and operator notes.
 *
 * Photo sources are merged: the embedded CartridgeRecord.photos[] (authoritative
 * by barcode, carries the stored public r2Url) and the cv_images collection
 * (richer — carries labels/notes/qcLabel/thumbnail). Both are keyed to the same
 * cartridge; we dedupe by imageId / cartridgeImageNumber.
 *
 * Guarded by AGENT_API_KEY (x-api-key / x-agent-api-key / Bearer). The returned
 * r2Url/thumbnailUrl values are PUBLIC Cloudflare Worker URLs — the caller can
 * <img src> them directly; image bytes never transit this server.
 *
 * Unknown barcode → HTTP 200 with found:false and empty collections, so the
 * research proxy has a single, simple success path.
 */

interface OutPhoto {
	imageId: string;
	phase: string;
	capturedAt: string | null;
	r2Url: string | null;
	thumbnailUrl?: string;
	cartridgeImageNumber?: string;
	qcLabel?: 'approved' | 'rejected' | null;
	labels?: string[];
	note?: string;
}

/** A stored value may already be an absolute URL or an R2 object key. Normalize to a fetchable URL. */
function toUrl(val?: string | null): string | undefined {
	if (!val) return undefined;
	if (/^https?:\/\//i.test(val)) return val;
	return getR2Url(val);
}

export const GET: RequestHandler = async ({ request, params }) => {
	requireAgentApiKey(request);
	await connectDB();

	const barcode = params.barcode;

	const [cartridge, cvImages] = await Promise.all([
		CartridgeRecord.findById(barcode).select('photos notes').lean() as Promise<any>,
		CvImage.find({ 'cartridgeTag.cartridgeRecordId': barcode }).lean() as Promise<any[]>
	]);

	if (!cartridge && (!cvImages || cvImages.length === 0)) {
		return json({ barcode, found: false, photosByState: {}, tags: [], notes: [] });
	}

	// Index cv_images so we can enrich embedded photos and detect cv-only images.
	const cvById = new Map<string, any>();
	const cvByNum = new Map<string, any>();
	for (const cv of cvImages ?? []) {
		if (cv._id) cvById.set(String(cv._id), cv);
		if (cv.cartridgeImageNumber) cvByNum.set(String(cv.cartridgeImageNumber), cv);
	}

	const usedCv = new Set<string>();
	const photos: OutPhoto[] = [];

	const buildFromCv = (cv: any, phaseHint?: string, imageId?: string): OutPhoto => ({
		imageId: imageId ?? String(cv._id),
		phase: phaseHint || cv?.cartridgeTag?.phase || 'unknown',
		capturedAt: cv?.capturedAt ? new Date(cv.capturedAt).toISOString() : null,
		r2Url: toUrl(cv?.imageUrl) ?? toUrl(cv?.processedPath) ?? toUrl(cv?.filePath) ?? null,
		thumbnailUrl: toUrl(cv?.thumbnailPath),
		cartridgeImageNumber: cv?.cartridgeImageNumber ?? undefined,
		qcLabel: cv?.qcLabel ?? null,
		labels: cv?.cartridgeTag?.labels ?? [],
		note: cv?.cartridgeTag?.notes || undefined
	});

	// 1. Embedded photos[] first — they carry the authoritative stored r2Url.
	for (const p of cartridge?.photos ?? []) {
		const cv =
			(p.imageId && cvById.get(String(p.imageId))) ||
			(p.cartridgeImageNumber && cvByNum.get(String(p.cartridgeImageNumber))) ||
			null;
		if (cv?._id) usedCv.add(String(cv._id));

		photos.push({
			imageId: String(p.imageId ?? cv?._id ?? p.cartridgeImageNumber ?? p.r2Key),
			phase: p.phase || cv?.cartridgeTag?.phase || 'unknown',
			capturedAt: p.capturedAt ? new Date(p.capturedAt).toISOString() : (cv?.capturedAt ? new Date(cv.capturedAt).toISOString() : null),
			r2Url: toUrl(p.r2Url) ?? toUrl(p.r2Key) ?? toUrl(cv?.imageUrl) ?? null,
			thumbnailUrl: toUrl(cv?.thumbnailPath),
			cartridgeImageNumber: p.cartridgeImageNumber ?? cv?.cartridgeImageNumber ?? undefined,
			qcLabel: cv?.qcLabel ?? null,
			labels: cv?.cartridgeTag?.labels ?? [],
			note: cv?.cartridgeTag?.notes || undefined
		});
	}

	// 2. cv_images not already represented by an embedded photo.
	for (const cv of cvImages ?? []) {
		if (usedCv.has(String(cv._id))) continue;
		photos.push(buildFromCv(cv));
	}

	// Group by phase; sort each group oldest→newest.
	const photosByState: Record<string, OutPhoto[]> = {};
	for (const ph of photos) {
		(photosByState[ph.phase] ??= []).push(ph);
	}
	for (const phase of Object.keys(photosByState)) {
		photosByState[phase].sort((a, b) => (a.capturedAt ?? '').localeCompare(b.capturedAt ?? ''));
	}

	// Card-level tags = union of every image's labels + any qc verdict.
	const tagSet = new Set<string>();
	for (const ph of photos) {
		for (const l of ph.labels ?? []) if (l) tagSet.add(l);
		if (ph.qcLabel) tagSet.add(ph.qcLabel);
	}

	// Card-level notes = operator notes on the cartridge record.
	const notes = (cartridge?.notes ?? []).map((n: any) => ({
		body: n.body,
		phase: n.phase,
		author: n.author?.username ?? undefined,
		createdAt: n.createdAt ? new Date(n.createdAt).toISOString() : undefined
	}));

	return json({
		barcode,
		found: true,
		photosByState,
		tags: [...tagSet],
		notes
	});
};
