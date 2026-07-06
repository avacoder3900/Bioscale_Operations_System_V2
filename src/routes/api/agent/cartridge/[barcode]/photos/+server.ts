import { json } from '@sveltejs/kit';
import { requireAgentApiKey } from '$lib/server/api-auth';
import { connectDB, CartridgeRecord } from '$lib/server/db';
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
 * Photos come straight from the embedded CartridgeRecord.photos[] — the single
 * record of truth for every photo (R2 pointer, phase, capture metadata, qcLabel,
 * labels, notes). cv_images is no longer consulted here: it holds only derived
 * technical data (embeddings/dimensions), none of which this endpoint emits.
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

	const cartridge = await CartridgeRecord.findById(barcode).select('photos notes').lean() as any;

	if (!cartridge) {
		return json({ barcode, found: false, photosByState: {}, tags: [], notes: [] });
	}

	const photos: OutPhoto[] = [];

	// Every photo entry is now complete truth — no cv_images merge needed.
	for (const p of cartridge.photos ?? []) {
		const r2Url = toUrl(p.r2Url) ?? toUrl(p.r2Key) ?? null;
		photos.push({
			imageId: String(p.imageId ?? p.cartridgeImageNumber ?? p.r2Key),
			phase: p.phase || 'unknown',
			capturedAt: p.capturedAt ? new Date(p.capturedAt).toISOString() : null,
			r2Url,
			// Thumbnails no longer exist (cv_images dropped thumbnailPath); fall back
			// to the full-resolution r2Url so the key stays populated for consumers.
			thumbnailUrl: r2Url ?? undefined,
			cartridgeImageNumber: p.cartridgeImageNumber ?? undefined,
			qcLabel: p.qcLabel ?? null,
			labels: p.labels ?? [],
			note: p.notes || undefined
		});
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
