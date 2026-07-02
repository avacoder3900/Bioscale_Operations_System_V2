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
import { CartridgeRecord } from '$lib/server/db/models/cartridge-record.js';
import { FailureLabel } from '$lib/server/db/models/failure-label.js';
import { getR2Url } from '$lib/server/services/r2';
import type { PageServerLoad } from './$types';

const PAGE_SIZE = 48;

function escapeRegExp(str: string): string {
	return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

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
	// Highlight sub-filter: '' (any) | 'yes' (has burned-in boxes) | 'no'.
	const highlightedParam = url.searchParams.get('highlighted') || '';
	const highlighted = ['yes', 'no'].includes(highlightedParam) ? highlightedParam : '';
	// arm/experiment live on CartridgeRecord, not CvImage — resolved to a
	// cartridge-id allowlist below. tag and notesSearch are direct CvImage
	// fields (cartridgeTag.labels / cartridgeTag.notes).
	const arm = url.searchParams.get('arm') || '';
	const experiment = url.searchParams.get('experiment') || '';
	const tag = url.searchParams.get('tag') || '';
	const notesSearch = url.searchParams.get('notes') || '';
	const page = Math.max(1, parseInt(url.searchParams.get('page') || '1', 10));

	// Base filter — everything except the review/verdict state. Used both for the
	// active query and for the per-tab counts so the badges stay in sync.
	const baseFilter: Record<string, any> = {};
	if (phase) baseFilter['cartridgeTag.phase'] = phase;
	if (tag) baseFilter['cartridgeTag.labels'] = tag;
	if (notesSearch) {
		baseFilter['cartridgeTag.notes'] = { $regex: escapeRegExp(notesSearch), $options: 'i' };
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
	// A photo is "highlighted" once boxes have been burned in (metadata.highlight set).
	if (highlighted === 'yes') baseFilter['metadata.highlight'] = { $exists: true };
	else if (highlighted === 'no') baseFilter['metadata.highlight'] = { $exists: false };

	// arm/experiment resolve via CartridgeRecord to a cartridge-id allowlist;
	// cartridgeId (partial-match search) narrows the same field with a regex, so
	// both are combined into one $and clause rather than letting one overwrite
	// the other.
	const cartridgeIdClauses: any[] = [];
	if (cartridgeId) {
		cartridgeIdClauses.push({ 'cartridgeTag.cartridgeRecordId': { $regex: cartridgeId, $options: 'i' } });
	}
	if (arm || experiment) {
		const cartQuery: Record<string, any> = {};
		if (arm) cartQuery.arm = arm;
		if (experiment) cartQuery.experiment = experiment;
		const matchingCartIds = await CartridgeRecord.distinct('_id', cartQuery);
		cartridgeIdClauses.push({ 'cartridgeTag.cartridgeRecordId': { $in: matchingCartIds } });
	}
	if (cartridgeIdClauses.length === 1) {
		Object.assign(baseFilter, cartridgeIdClauses[0]);
	} else if (cartridgeIdClauses.length > 1) {
		baseFilter.$and = cartridgeIdClauses;
	}

	// Layer the review-tab + verdict conditions on top of the base filter.
	const filter: Record<string, any> = { ...baseFilter };
	if (review === 'unreviewed') {
		filter.qcLabel = null;
	} else if (review === 'reviewed') {
		filter.qcLabel = verdict === 'approved' || verdict === 'rejected' ? verdict : { $ne: null };
	}

	const [imagesRaw, total, distinctPhases, unreviewedCount, reviewedCount, armOptionsRaw, experimentOptionsRaw, failureLabelsRaw] = await Promise.all([
		CvImage.find(filter)
			.sort({ capturedAt: -1 })
			.skip((page - 1) * PAGE_SIZE)
			.limit(PAGE_SIZE)
			.select('_id cartridgeImageNumber cartridgeTag filePath imageUrl thumbnailPath qcLabel capturedAt capturedBy fileSizeBytes metadata.highlight')
			.lean(),
		CvImage.countDocuments(filter),
		// Phases available in the data — drives the filter dropdown
		CvImage.distinct('cartridgeTag.phase'),
		// Tab badges — respect the active base filters but not the review tab itself.
		CvImage.countDocuments({ ...baseFilter, qcLabel: null }),
		CvImage.countDocuments({ ...baseFilter, qcLabel: { $ne: null } }),
		CartridgeRecord.distinct('arm', { arm: { $nin: [null, ''] } }),
		CartridgeRecord.distinct('experiment', { experiment: { $nin: [null, ''] } }),
		// The premade failure-label pick-list (Label Creation / Manage tab + tag
		// pickers) — also the source for the Tag filter dropdown.
		FailureLabel.find().sort({ text: 1 }).lean()
	]);

	const armOptions = (armOptionsRaw as string[]).sort((a, b) => a.localeCompare(b));
	const experimentOptions = (experimentOptionsRaw as string[]).sort((a, b) => a.localeCompare(b));
	const failureLabels = (failureLabelsRaw as any[]).map(l => ({ id: l._id, text: l.text }));

	const images = (imagesRaw as any[]).map(img => ({
		id: img._id,
		cartridgeImageNumber: img.cartridgeImageNumber ?? null,
		cartridgeRecordId: img.cartridgeTag?.cartridgeRecordId ?? null,
		phase: img.cartridgeTag?.phase ?? null,
		labels: img.cartridgeTag?.labels ?? [],
		notes: img.cartridgeTag?.notes ?? '',
		qcLabel: img.qcLabel ?? null,
		url: img.imageUrl || (img.filePath ? getR2Url(img.filePath) : null),
		thumbnailUrl: img.thumbnailPath ? getR2Url(img.thumbnailPath) : (img.imageUrl || (img.filePath ? getR2Url(img.filePath) : null)),
		capturedAt: img.capturedAt ?? null,
		capturedByUsername: img.capturedBy?.username ?? null,
		fileSizeBytes: img.fileSizeBytes ?? null,
		highlighted: Boolean(img.metadata?.highlight)
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
		filters: { phase, cartridgeId, verdict, fromDate, toDate, highlighted, arm, experiment, tag, notesSearch },
		availablePhases: (distinctPhases as string[]).filter(Boolean).sort(),
		armOptions,
		experimentOptions,
		failureLabels
	};
};

export const config = { maxDuration: 60 };
