/**
 * POST /api/cv/images/[id]/highlight
 *
 * Burn user-drawn yellow highlight boxes into a capture, IN PLACE.
 *
 * Body (application/json):
 *   boxes: Array<{ x, y, w, h }>   normalized [0..1] coords, top-left origin.
 *
 * Behavior:
 *   1. Auth: cv:write OR manufacturing:write (same as capture).
 *   2. Find the photo entry on the cartridge record; fetch bytes from R2.
 *   3. sharp-composite an SVG of yellow stroked rects scaled to real pixels.
 *   4. Upload the boxed image under a new R2 key.
 *   5. Repoint photos[].r2Key/r2Url and append photos[].annotations (the
 *      region truth); refresh the CvImage technical row and invalidate its
 *      embedding cache (the pixels changed).
 *   6. Delete the original object (overwrite-in-place semantics) and audit-log.
 *   7. Return { imageUrl } — the new URL for the caller to display.
 *
 * Overwrite is intentional (operator choice): the un-annotated original is
 * discarded. The drawn boxes live on photos[].annotations so the annotation
 * is auditable even though the pixels are replaced.
 */
import { json, error } from '@sveltejs/kit';
import sharp from 'sharp';
import { connectDB } from '$lib/server/db/connection.js';
import { CvImage } from '$lib/server/db/models/cv-image.js';
import { AuditLog } from '$lib/server/db/models/index.js';
import { generateId } from '$lib/server/db/utils.js';
import { getPhotoByImageId, updatePhotoTruth } from '$lib/server/cv/photo-truth.js';
import {
	uploadViaWorker,
	downloadViaWorker,
	deleteViaWorker,
	buildCvNamedKey
} from '$lib/server/services/r2';
import { hasPermission } from '$lib/server/permissions';
import type { RequestHandler } from './$types';

const BOX_COLOR = '#facc15'; // matches the on-screen tron-yellow overlay

interface Box {
	x: number;
	y: number;
	w: number;
	h: number;
}

function sanitizeBoxes(raw: unknown): Box[] {
	if (!Array.isArray(raw)) return [];
	const clamp = (n: unknown) => Math.min(1, Math.max(0, Number(n)));
	const out: Box[] = [];
	for (const b of raw) {
		if (!b || typeof b !== 'object') continue;
		const x = clamp((b as any).x);
		const y = clamp((b as any).y);
		const w = clamp((b as any).w);
		const h = clamp((b as any).h);
		if (![x, y, w, h].every(Number.isFinite)) continue;
		// Drop degenerate boxes and clip size so x+w / y+h never exceed the frame.
		if (w <= 0 || h <= 0) continue;
		out.push({ x, y, w: Math.min(w, 1 - x), h: Math.min(h, 1 - y) });
	}
	return out;
}

export const POST: RequestHandler = async ({ params, request, locals }) => {
	if (!locals.user) throw error(401, 'Unauthorized');
	if (!hasPermission(locals.user, 'cv:write') && !hasPermission(locals.user, 'manufacturing:write')) {
		throw error(403, 'Forbidden');
	}

	const id = params.id;
	if (!id) return json({ error: 'image id is required' }, { status: 400 });

	let body: any;
	try {
		body = await request.json();
	} catch {
		return json({ error: 'invalid JSON body' }, { status: 400 });
	}

	const boxes = sanitizeBoxes(body?.boxes);
	if (boxes.length === 0) {
		return json({ error: 'at least one highlight box is required' }, { status: 400 });
	}

	await connectDB();

	try {
		const found = await getPhotoByImageId(id);
		if (!found) return json({ error: `photo ${id} not found` }, { status: 404 });
		const { cartridgeRecordId, photo } = found;

		const sourceKey = photo.r2Key;
		if (!sourceKey) return json({ error: 'photo has no stored file to annotate' }, { status: 400 });

		// 1. Pull the current bytes through the Worker (native R2 binding).
		const original = await downloadViaWorker(sourceKey);

		// 2. Composite the boxes at true pixel scale. Bake EXIF orientation first
		//    and read the *post-rotation* dimensions from the flattened buffer —
		//    metadata() would report pre-rotation width/height and misplace boxes.
		const { data: upright, info } = await sharp(original, { failOn: 'none' })
			.rotate()
			.toBuffer({ resolveWithObject: true });
		const W = info.width ?? 0;
		const H = info.height ?? 0;
		if (!W || !H) return json({ error: 'could not read image dimensions' }, { status: 422 });

		// Stroke scales with the image so it reads like the on-screen 2px border.
		const stroke = Math.max(3, Math.round(Math.min(W, H) * 0.005));
		const rects = boxes
			.map((b) => {
				const x = Math.round(b.x * W);
				const y = Math.round(b.y * H);
				const w = Math.round(b.w * W);
				const h = Math.round(b.h * H);
				return `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="none" stroke="${BOX_COLOR}" stroke-width="${stroke}" />`;
			})
			.join('');
		const svg = `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">${rects}</svg>`;

		const boxed = await sharp(upright)
			.composite([{ input: Buffer.from(svg), top: 0, left: 0 }])
			.jpeg({ quality: 92 })
			.toBuffer();

		// 3. Upload under a fresh key.
		const cin = photo.cartridgeImageNumber || id;
		const newKey = buildCvNamedKey('captures', generateId(), `${cin}-highlighted.jpg`);
		const newUrl = await uploadViaWorker(boxed, newKey, 'image/jpeg');

		// 4. Photo truth: repoint the pointer + append the region annotations.
		const savedAt = new Date();
		const operator = { _id: locals.user._id, username: locals.user.username };
		const priorAnnotations = Array.isArray(photo.annotations) ? photo.annotations : [];
		await updatePhotoTruth(id, {
			r2Key: newKey,
			r2Url: newUrl,
			annotations: [
				...priorAnnotations,
				...boxes.map((b) => ({ ...b, color: BOX_COLOR, savedBy: operator, savedAt }))
			]
		});

		// Technical row: new dimensions/size, provenance, and a stale-embedding
		// invalidation — the pixels changed, so any cached feature vector is wrong.
		await CvImage.updateOne(
			{ _id: id },
			{
				$set: {
					width: W,
					height: H,
					fileSizeBytes: boxed.length,
					'metadata.replacedKey': sourceKey
				},
				$unset: { embedding: 1, embeddingVersion: 1, embeddedAt: 1 }
			},
			{ upsert: true }
		);

		// 5. Drop the original bytes (overwrite-in-place). Best-effort: a failed
		//    delete only orphans the old object, it must not fail the request.
		try {
			if (newKey !== sourceKey) await deleteViaWorker(sourceKey);
		} catch (e) {
			console.warn('[highlight] original delete skipped:', e);
		}

		await AuditLog.create({
			_id: generateId(),
			tableName: 'cartridge_records',
			recordId: cartridgeRecordId,
			action: 'photo_highlight_burn_in',
			newData: {
				imageId: id,
				boxes: boxes.length,
				newKey,
				replacedKey: sourceKey
			},
			changedAt: savedAt,
			changedBy: locals.user.username
		});

		return json({ imageId: id, imageUrl: newUrl, boxes: boxes.length });
	} catch (e: any) {
		console.error('[api/cv/images/:id/highlight] failed:', e);
		return json({ error: e?.message ?? 'Highlight save failed' }, { status: 500 });
	}
};
