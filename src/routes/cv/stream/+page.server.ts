/**
 * /cv/stream — chronological feed of every image captured, regardless of
 * project or source. The "look at what's coming in" view.
 *
 * Filters: phase, cartridgeId (partial match), date range, qcLabel state.
 * Paginated 48 per page, sorted by capturedAt desc.
 */
import { redirect } from '@sveltejs/kit';
import { connectDB } from '$lib/server/db/connection.js';
import { CvImage } from '$lib/server/db/models/cv-image.js';
import { getR2Url } from '$lib/server/services/r2';
import type { PageServerLoad } from './$types';

const PAGE_SIZE = 48;

export const load: PageServerLoad = async ({ url, locals }) => {
	if (!locals.user) redirect(302, '/login');
	await connectDB();

	const phase = url.searchParams.get('phase') || '';
	const cartridgeId = url.searchParams.get('cartridge')?.trim() || '';
	const labelFilter = url.searchParams.get('label') || ''; // approved | rejected | unlabeled
	const fromDate = url.searchParams.get('from') || '';
	const toDate = url.searchParams.get('to') || '';
	const page = Math.max(1, parseInt(url.searchParams.get('page') || '1', 10));

	const filter: Record<string, any> = {};
	if (phase) filter['cartridgeTag.phase'] = phase;
	if (cartridgeId) {
		filter['cartridgeTag.cartridgeRecordId'] = { $regex: cartridgeId, $options: 'i' };
	}
	if (labelFilter === 'unlabeled') filter.qcLabel = null;
	else if (labelFilter === 'approved' || labelFilter === 'rejected') filter.qcLabel = labelFilter;

	if (fromDate || toDate) {
		filter.capturedAt = {};
		if (fromDate) filter.capturedAt.$gte = new Date(fromDate);
		if (toDate) {
			// Make `to` inclusive by setting it to end-of-day.
			const end = new Date(toDate);
			end.setHours(23, 59, 59, 999);
			filter.capturedAt.$lte = end;
		}
	}

	const [imagesRaw, total, distinctPhases] = await Promise.all([
		CvImage.find(filter)
			.sort({ capturedAt: -1 })
			.skip((page - 1) * PAGE_SIZE)
			.limit(PAGE_SIZE)
			.select('_id cartridgeImageNumber cartridgeTag filePath imageUrl thumbnailPath qcLabel capturedAt capturedBy fileSizeBytes')
			.lean(),
		CvImage.countDocuments(filter),
		// Phases available in the data — drives the filter dropdown
		CvImage.distinct('cartridgeTag.phase')
	]);

	const images = (imagesRaw as any[]).map(img => ({
		id: img._id,
		cartridgeImageNumber: img.cartridgeImageNumber ?? null,
		cartridgeRecordId: img.cartridgeTag?.cartridgeRecordId ?? null,
		phase: img.cartridgeTag?.phase ?? null,
		qcLabel: img.qcLabel ?? null,
		url: img.imageUrl || (img.filePath ? getR2Url(img.filePath) : null),
		thumbnailUrl: img.thumbnailPath ? getR2Url(img.thumbnailPath) : (img.imageUrl || (img.filePath ? getR2Url(img.filePath) : null)),
		capturedAt: img.capturedAt ?? null,
		capturedByUsername: img.capturedBy?.username ?? null,
		fileSizeBytes: img.fileSizeBytes ?? null
	}));

	const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

	return {
		images,
		total,
		page,
		totalPages,
		pageSize: PAGE_SIZE,
		filters: { phase, cartridgeId, labelFilter, fromDate, toDate },
		availablePhases: (distinctPhases as string[]).filter(Boolean).sort()
	};
};

export const config = { maxDuration: 60 };
