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
import { redirect, fail } from '@sveltejs/kit';
import { connectDB } from '$lib/server/db/connection.js';
import { CvImage } from '$lib/server/db/models/cv-image.js';
import { CartridgeRecord } from '$lib/server/db/models/cartridge-record.js';
import { ManufacturingSettings } from '$lib/server/db/models/manufacturing-settings.js';
import { generateId } from '$lib/server/db/utils.js';
import { requirePermission } from '$lib/server/permissions';
import { getR2Url } from '$lib/server/services/r2';
import type { PageServerLoad, Actions } from './$types';

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
	const review = ['unreviewed', 'reviewed', 'all'].includes(reviewParam) ? reviewParam : 'unreviewed';
	// Verdict sub-filter, only meaningful within Reviewed / All.
	const verdict = url.searchParams.get('verdict') || ''; // approved | rejected
	const fromDate = url.searchParams.get('from') || '';
	const toDate = url.searchParams.get('to') || '';
	// arm/experiment/failureCode live on CartridgeRecord, not CvImage — resolved
	// to a cartridge-id allowlist below. tag and notesSearch are direct CvImage
	// fields (cartridgeTag.labels / cartridgeTag.notes).
	const arm = url.searchParams.get('arm') || '';
	const experiment = url.searchParams.get('experiment') || '';
	const tag = url.searchParams.get('tag') || '';
	const failureCode = url.searchParams.get('failureCode') || '';
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

	// arm/experiment/failureCode resolve via CartridgeRecord to a cartridge-id
	// allowlist; cartridgeId (partial-match search) narrows the same field with
	// a regex, so both are combined into one $and clause rather than letting
	// one overwrite the other.
	const cartridgeIdClauses: any[] = [];
	if (cartridgeId) {
		cartridgeIdClauses.push({ 'cartridgeTag.cartridgeRecordId': { $regex: cartridgeId, $options: 'i' } });
	}
	if (arm || experiment || failureCode) {
		const cartQuery: Record<string, any> = {};
		if (arm) cartQuery.arm = arm;
		if (experiment) cartQuery.experiment = experiment;
		if (failureCode) {
			cartQuery.$or = [
				{ 'waxQc.rejectionReason': failureCode },
				{ 'reagentInspection.reason': failureCode }
			];
		}
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
	} else if (verdict === 'approved' || verdict === 'rejected') {
		// "All" tab with an explicit verdict picked.
		filter.qcLabel = verdict;
	}

	const [imagesRaw, total, distinctPhases, unreviewedCount, reviewedCount, armOptionsRaw, experimentOptionsRaw, tagOptionsRaw, settingsDoc] = await Promise.all([
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
		CvImage.countDocuments({ ...baseFilter, qcLabel: { $ne: null } }),
		CartridgeRecord.distinct('arm', { arm: { $nin: [null, ''] } }),
		CartridgeRecord.distinct('experiment', { experiment: { $nin: [null, ''] } }),
		CvImage.distinct('cartridgeTag.labels', { 'cartridgeTag.labels': { $exists: true, $ne: [] } }),
		ManufacturingSettings.findById('default').select('rejectionReasonCodes').lean()
	]);

	const armOptions = (armOptionsRaw as string[]).sort((a, b) => a.localeCompare(b));
	const experimentOptions = (experimentOptionsRaw as string[]).sort((a, b) => a.localeCompare(b));
	const tagOptions = (tagOptionsRaw as string[]).sort((a, b) => a.localeCompare(b));
	const failureCodeOptions = (((settingsDoc as any)?.rejectionReasonCodes ?? []) as any[])
		.slice()
		.sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0))
		.map(rc => ({ id: String(rc._id), code: rc.code, label: rc.label, processType: rc.processType, sortOrder: rc.sortOrder ?? 0 }));

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
		filters: { phase, cartridgeId, verdict, fromDate, toDate, arm, experiment, tag, failureCode, notesSearch },
		availablePhases: (distinctPhases as string[]).filter(Boolean).sort(),
		armOptions,
		experimentOptions,
		tagOptions,
		failureCodeOptions
	};
};

export const actions: Actions = {
	/** Create a common-failure reason (wax or reagent, picked in the form). */
	createFailureReason: async ({ request, locals }) => {
		if (!locals.user) redirect(302, '/login');
		requirePermission(locals.user, 'manufacturing:admin');
		await connectDB();

		const data = await request.formData();
		const code = (data.get('code') as string)?.trim();
		const label = (data.get('label') as string)?.trim();
		const processType = (data.get('processType') as string) === 'wax' ? 'wax' : 'reagent';
		const sortOrder = Number(data.get('sortOrder') ?? 0);

		if (!code || !label) return fail(400, { error: 'Code and label are required' });

		await ManufacturingSettings.findByIdAndUpdate(
			'default',
			{ $push: { rejectionReasonCodes: { _id: generateId(), code, label, processType, sortOrder } } },
			{ upsert: true }
		);
		return { success: true };
	},

	/** Update a common-failure reason's label/sort order. */
	updateFailureReason: async ({ request, locals }) => {
		if (!locals.user) redirect(302, '/login');
		requirePermission(locals.user, 'manufacturing:admin');
		await connectDB();

		const data = await request.formData();
		const codeId = data.get('codeId') as string;
		const label = (data.get('label') as string)?.trim();
		const sortOrder = Number(data.get('sortOrder') ?? 0);

		if (!codeId || !label) return fail(400, { error: 'Code ID and label are required' });

		await ManufacturingSettings.findOneAndUpdate(
			{ 'rejectionReasonCodes._id': codeId },
			{ $set: { 'rejectionReasonCodes.$.label': label, 'rejectionReasonCodes.$.sortOrder': sortOrder } }
		);
		return { success: true };
	},

	/** Delete a common-failure reason. */
	deleteFailureReason: async ({ request, locals }) => {
		if (!locals.user) redirect(302, '/login');
		requirePermission(locals.user, 'manufacturing:admin');
		await connectDB();

		const data = await request.formData();
		const codeId = data.get('codeId') as string;

		if (!codeId) return fail(400, { error: 'Code ID required' });

		await ManufacturingSettings.findByIdAndUpdate(
			'default',
			{ $pull: { rejectionReasonCodes: { _id: codeId } } }
		);
		return { success: true };
	}
};

export const config = { maxDuration: 60 };
