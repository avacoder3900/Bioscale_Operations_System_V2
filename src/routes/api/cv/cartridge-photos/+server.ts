/**
 * GET /api/cv/cartridge-photos?id=CART-000123&projectId=proj_abc
 *
 * Lists all photos for a cartridge directly from R2, organized by phase.
 * QR code scan → cartridge ID → R2 folder listing → grouped by phase.
 *
 * Optional: &phase=wax_filled to filter to a single phase folder.
 */
import { json } from '@sveltejs/kit';
import { connectDB } from '$lib/server/db/connection.js';
import { CvImage } from '$lib/server/db/models/cv-image.js';
import { listFolder, getSignedDownloadUrl } from '$lib/server/r2.js';
import { buildDhrPrefix } from '$lib/server/r2.js';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ url, locals }) => {
	if (!locals.user) return json({ error: 'Unauthorized' }, { status: 401 });

	const id = url.searchParams.get('id')?.trim();
	const projectId = url.searchParams.get('projectId')?.trim();
	const phase = url.searchParams.get('phase')?.trim() || undefined;

	if (!id) return json({ error: 'id parameter is required' }, { status: 400 });
	if (!projectId) return json({ error: 'projectId parameter is required' }, { status: 400 });

	await connectDB();

	// Strategy 1: List R2 objects directly by prefix (works even without MongoDB)
	const prefix = buildDhrPrefix(projectId, id, phase);
	let r2Files: { key: string; size: number; lastModified: Date | null }[] = [];
	try {
		r2Files = await listFolder(prefix);
	} catch {
		// R2 may not be configured in dev — fall back to MongoDB only
	}

	// Strategy 2: Also query MongoDB for all CvImage docs linked to this cartridge
	const query: Record<string, any> = { 'cartridgeTag.cartridgeRecordId': id };
	if (phase) query['cartridgeTag.phase'] = phase;

	const dbImages = await CvImage.find(query)
		.select('_id filePath thumbnailPath cartridgeTag.phase capturedAt imageUrl label')
		.sort({ capturedAt: 1 })
		.lean() as any[];

	// Merge: build a unified list, grouping by phase
	const phaseMap: Record<string, {
		phase: string;
		photos: {
			imageId: string | null;
			r2Key: string;
			url: string | null;
			thumbnailUrl: string | null;
			label: string | null;
			capturedAt: string | null;
		}[];
	}> = {};

	// Add DB images (authoritative — have metadata)
	for (const img of dbImages) {
		const p = img.cartridgeTag?.phase || 'untagged';
		if (!phaseMap[p]) phaseMap[p] = { phase: p, photos: [] };

		let signedUrl: string | null = null;
		let thumbUrl: string | null = null;
		if (img.filePath) {
			try { signedUrl = await getSignedDownloadUrl(img.filePath); } catch { /* no-op */ }
		}
		if (img.thumbnailPath) {
			try { thumbUrl = await getSignedDownloadUrl(img.thumbnailPath); } catch { /* no-op */ }
		}
		if (!signedUrl && img.imageUrl) signedUrl = img.imageUrl;

		phaseMap[p].photos.push({
			imageId: img._id,
			r2Key: img.filePath || '',
			url: signedUrl,
			thumbnailUrl: thumbUrl,
			label: img.label || null,
			capturedAt: img.capturedAt?.toISOString?.() ?? null
		});
	}

	// Add any R2 files not already covered by DB (orphaned uploads)
	const dbKeys = new Set(dbImages.map(i => i.filePath).filter(Boolean));
	for (const file of r2Files) {
		if (dbKeys.has(file.key)) continue;
		if (file.key.includes('/thumbs/')) continue; // skip thumbnails

		// Extract phase from key: cv/{proj}/dhr/{cart}/{phase}/{file}
		const parts = file.key.split('/');
		const phaseIdx = parts.indexOf('dhr') + 2; // dhr/{cart}/{phase}
		const p = parts[phaseIdx] || 'untagged';

		if (!phaseMap[p]) phaseMap[p] = { phase: p, photos: [] };

		let signedUrl: string | null = null;
		try { signedUrl = await getSignedDownloadUrl(file.key); } catch { /* no-op */ }

		phaseMap[p].photos.push({
			imageId: null,
			r2Key: file.key,
			url: signedUrl,
			thumbnailUrl: null,
			label: null,
			capturedAt: file.lastModified?.toISOString() ?? null
		});
	}

	// Sort phases by pipeline order
	const PHASE_ORDER = [
		'backing', 'wax_filling', 'wax_filled', 'wax_qc', 'wax_storage',
		'reagent_filled', 'reagent_inspection', 'inspected',
		'top_seal', 'sealed', 'oven_cure', 'cured',
		'storage', 'qa_qc', 'released', 'shipping', 'untagged'
	];

	const phases = Object.values(phaseMap).sort((a, b) => {
		const ai = PHASE_ORDER.indexOf(a.phase);
		const bi = PHASE_ORDER.indexOf(b.phase);
		return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi);
	});

	return json({
		cartridgeId: id,
		projectId,
		totalPhotos: phases.reduce((sum, p) => sum + p.photos.length, 0),
		phases
	});
};
