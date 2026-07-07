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
	// arm/experiment are cartridge-level fields (matched pre-unwind); tag and
	// notesSearch are photo-level (photos.labels / photos.notes, post-unwind).
	const arm = url.searchParams.get('arm') || '';
	const experiment = url.searchParams.get('experiment') || '';
	const tag = url.searchParams.get('tag') || '';
	const notesSearch = url.searchParams.get('notes') || '';
	// Photo-type filter (microscope-sequence support): '' (any) | 'inspection' |
	// 'microscope'. Legacy/missing photoType counts as inspection.
	const typeParam = url.searchParams.get('type') || '';
	const photoType = ['inspection', 'microscope'].includes(typeParam) ? typeParam : '';
	// Grid-slot filters — only meaningful for microscope photos but applied
	// independently so a row/col can be searched across everything.
	const row = url.searchParams.get('row')?.trim() || '';
	const col = url.searchParams.get('col')?.trim() || '';
	const page = Math.max(1, parseInt(url.searchParams.get('page') || '1', 10));

	// Photos are now sourced directly from cartridge_records.photos[] (the record
	// of truth), not cv_images. Filters split into cartridge-level (pre-unwind)
	// and photo-level (post-unwind) matches.
	const cartMatch: Record<string, any> = {};
	if (cartridgeId) cartMatch._id = { $regex: cartridgeId, $options: 'i' };
	if (arm) cartMatch.arm = arm;
	if (experiment) cartMatch.experiment = experiment;

	// Base photo-level filter — everything except the review/verdict state. Used
	// both for the active query and for the per-tab counts so badges stay in sync.
	const basePhotoMatch: Record<string, any> = {};
	if (phase) basePhotoMatch['photos.phase'] = phase;
	if (photoType === 'microscope') basePhotoMatch['photos.photoType'] = 'microscope';
	else if (photoType === 'inspection') basePhotoMatch['photos.photoType'] = { $ne: 'microscope' };
	if (row) basePhotoMatch['photos.location.row'] = row;
	if (col) {
		const colNum = parseInt(col, 10);
		if (!Number.isNaN(colNum)) basePhotoMatch['photos.location.col'] = colNum;
	}
	if (tag) basePhotoMatch['photos.labels'] = tag;
	if (notesSearch) {
		basePhotoMatch['photos.notes'] = { $regex: escapeRegExp(notesSearch), $options: 'i' };
	}
	if (fromDate || toDate) {
		basePhotoMatch['photos.capturedAt'] = {};
		if (fromDate) basePhotoMatch['photos.capturedAt'].$gte = new Date(fromDate);
		if (toDate) {
			// Make `to` inclusive by setting it to end-of-day.
			const end = new Date(toDate);
			end.setHours(23, 59, 59, 999);
			basePhotoMatch['photos.capturedAt'].$lte = end;
		}
	}
	// A photo is "highlighted" once region boxes have been drawn (annotations non-empty).
	if (highlighted === 'yes') basePhotoMatch['photos.annotations.0'] = { $exists: true };
	else if (highlighted === 'no') basePhotoMatch['photos.annotations.0'] = { $exists: false };

	// Assemble the unwound pipeline for a given extra photo-match (review clause
	// or a tab-count clause). cartMatch runs before unwind to prune whole carts.
	const buildPipeline = (extra: Record<string, any>) => {
		const stages: any[] = [];
		if (Object.keys(cartMatch).length) stages.push({ $match: cartMatch });
		stages.push({ $unwind: '$photos' });
		const pm = { ...basePhotoMatch, ...extra };
		if (Object.keys(pm).length) stages.push({ $match: pm });
		return stages;
	};

	// Review-tab + verdict clause layered on top of the base photo match.
	const reviewClause: Record<string, any> = {};
	if (review === 'unreviewed') {
		reviewClause['photos.qcLabel'] = null;
	} else if (review === 'reviewed') {
		reviewClause['photos.qcLabel'] =
			verdict === 'approved' || verdict === 'rejected' ? verdict : { $ne: null };
	}

	const [imagesRaw, totalAgg, distinctPhases, unreviewedAgg, reviewedAgg, armOptionsRaw, experimentOptionsRaw, failureLabelsRaw] = await Promise.all([
		CartridgeRecord.aggregate([
			...buildPipeline(reviewClause),
			{ $sort: { 'photos.capturedAt': -1 } },
			{ $skip: (page - 1) * PAGE_SIZE },
			{ $limit: PAGE_SIZE },
			{
				$project: {
					_id: 0,
					imageId: '$photos.imageId',
					cartridgeImageNumber: '$photos.cartridgeImageNumber',
					cartridgeRecordId: '$_id',
					phase: '$photos.phase',
					labels: '$photos.labels',
					notes: '$photos.notes',
					qcLabel: '$photos.qcLabel',
					r2Url: '$photos.r2Url',
					r2Key: '$photos.r2Key',
					capturedAt: '$photos.capturedAt',
					capturedByUsername: '$photos.capturedBy.username',
					photoType: '$photos.photoType',
					sequenceId: '$photos.sequenceId',
					sequenceIndex: '$photos.sequenceIndex',
					locationRow: '$photos.location.row',
					locationCol: '$photos.location.col',
					annotationCount: { $size: { $ifNull: ['$photos.annotations', []] } }
				}
			}
		]),
		CartridgeRecord.aggregate([...buildPipeline(reviewClause), { $count: 'n' }]),
		// Phases available in the data — drives the filter dropdown
		CartridgeRecord.distinct('photos.phase'),
		// Tab badges — respect the active base filters but not the review tab itself.
		CartridgeRecord.aggregate([...buildPipeline({ 'photos.qcLabel': null }), { $count: 'n' }]),
		CartridgeRecord.aggregate([...buildPipeline({ 'photos.qcLabel': { $ne: null } }), { $count: 'n' }]),
		CartridgeRecord.distinct('arm', { arm: { $nin: [null, ''] } }),
		CartridgeRecord.distinct('experiment', { experiment: { $nin: [null, ''] } }),
		// The premade failure-label pick-list (Label Creation / Manage tab + tag
		// pickers) — also the source for the Tag filter dropdown.
		FailureLabel.find().sort({ text: 1 }).lean()
	]);

	const total = (totalAgg as any[])[0]?.n ?? 0;
	const unreviewedCount = (unreviewedAgg as any[])[0]?.n ?? 0;
	const reviewedCount = (reviewedAgg as any[])[0]?.n ?? 0;
	const armOptions = (armOptionsRaw as string[]).sort((a, b) => a.localeCompare(b));
	const experimentOptions = (experimentOptionsRaw as string[]).sort((a, b) => a.localeCompare(b));
	const failureLabels = (failureLabelsRaw as any[]).map(l => ({ id: l._id, text: l.text }));

	const images = (imagesRaw as any[]).map(p => {
		const url = p.r2Url || (p.r2Key ? getR2Url(p.r2Key) : null);
		return {
			id: p.imageId,
			cartridgeImageNumber: p.cartridgeImageNumber ?? null,
			cartridgeRecordId: p.cartridgeRecordId ?? null,
			phase: p.phase ?? null,
			labels: p.labels ?? [],
			notes: p.notes ?? '',
			qcLabel: p.qcLabel ?? null,
			url,
			thumbnailUrl: url,
			capturedAt: p.capturedAt ?? null,
			capturedByUsername: p.capturedByUsername ?? null,
			fileSizeBytes: null,
			highlighted: (p.annotationCount ?? 0) > 0,
			// Microscope-sequence descriptors. photoType defaults to 'inspection'
			// for legacy/missing values; location is null unless both parts exist.
			photoType: p.photoType ?? 'inspection',
			sequenceId: p.sequenceId ?? null,
			sequenceIndex: p.sequenceIndex ?? null,
			location: (p.locationRow != null || p.locationCol != null)
				? { row: p.locationRow ?? null, col: p.locationCol ?? null }
				: null
		};
	});

	const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

	return {
		images,
		total,
		page,
		totalPages,
		pageSize: PAGE_SIZE,
		review,
		counts: { unreviewed: unreviewedCount, reviewed: reviewedCount },
		filters: { phase, cartridgeId, verdict, fromDate, toDate, highlighted, arm, experiment, tag, notesSearch, type: photoType, row, col },
		availablePhases: (distinctPhases as string[]).filter(Boolean).sort(),
		armOptions,
		experimentOptions,
		failureLabels
	};
};

export const config = { maxDuration: 60 };
