/**
 * /cv/stream — chronological feed of every image captured, regardless of
 * project or source. The "look at what's coming in" view.
 *
 * Organized into Unreviewed / Reviewed / All tabs so an operator can scroll
 * the queue and label each image pass (approved) / fail (rejected) directly,
 * building the dataset for a future pass/fail CV model.
 *
 * Filters: phase, cartridgeId (partial match), date range, verdict (within
 * the Reviewed/All tabs). Paginated 48 per page, sorted by capturedAt desc.
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
	// Which tab: unreviewed (no label yet) | reviewed (has a label) | all.
	const reviewParam = url.searchParams.get('review') || 'unreviewed';
	const review = ['unreviewed', 'reviewed'].includes(reviewParam) ? reviewParam : 'unreviewed';
	// Verdict sub-filter, only meaningful within Reviewed / All.
	const verdict = url.searchParams.get('verdict') || ''; // approved | rejected
	const fromDate = url.searchParams.get('from') || '';
	const toDate = url.searchParams.get('to') || '';
	const page = Math.max(1, parseInt(url.searchParams.get('page') || '1', 10));

	// Base filter — everything except the review/verdict state. Used both for the
	// active query and for the per-tab counts so the badges stay in sync.
	const baseFilter: Record<string, any> = {};
	if (phase) baseFilter['cartridgeTag.phase'] = phase;
	if (cartridgeId) {
		baseFilter['cartridgeTag.cartridgeRecordId'] = { $regex: cartridgeId, $options: 'i' };
	}
	if (fromDate || toDate) {
		baseFilter.capturedAt = {};
		if (fromDate) baseFilter.capturedAt.$gte = new Date(fromDate);
		if (toDate) {
			// Make `to` inclusive by setting it to end-of-day.
			const end = new Date(toDate);
			end.setHours(23, 59, 59, 999);
			baseFilter.capturedAt.$lte = end;
		}
	}

	// Layer the review-tab + verdict conditions on top of the base filter.
	const filter: Record<string, any> = { ...baseFilter };
	if (review === 'unreviewed') {
		filter.qcLabel = null;
	} else if (review === 'reviewed') {
		filter.qcLabel = verdict === 'approved' || verdict === 'rejected' ? verdict : { $ne: null };
	}

	const [imagesRaw, total, distinctPhases, unreviewedCount, reviewedCount] = await Promise.all([
		CvImage.find(filter)
			.sort({ capturedAt: -1 })
			.skip((page - 1) * PAGE_SIZE)
			.limit(PAGE_SIZE)
			.select('_id cartridgeImageNumber cartridgeTag filePath imageUrl thumbnailPath qcLabel capturedAt capturedBy fileSizeBytes')
			.lean(),
		CvImage.countDocuments(filter),
		// Phases available in the data — drives the filter dropdown
		CvImage.distinct('cartridgeTag.phase'),
		// Tab badges — respect the active base filters but not the review tab itself.
		CvImage.countDocuments({ ...baseFilter, qcLabel: null }),
		CvImage.countDocuments({ ...baseFilter, qcLabel: { $ne: null } })
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
		review,
		counts: { unreviewed: unreviewedCount, reviewed: reviewedCount },
		filters: { phase, cartridgeId, verdict, fromDate, toDate },
		availablePhases: (distinctPhases as string[]).filter(Boolean).sort()
	};
};

export const config = { maxDuration: 60 };
