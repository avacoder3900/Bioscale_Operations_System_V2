/**
 * /cv/label — search-driven labeling.
 *
 * Operator builds a cartridge query (assay, run, operator, status, date, etc.),
 * we resolve the matching CartridgeRecords, then surface their photos for
 * bulk approve/reject.
 *
 * Filters compile in two stages so we don't pull every image and JS-filter:
 *  Stage 1: CartridgeRecord query → list of cartridge IDs that match
 *  Stage 2: CvImage query restricted to those cartridge IDs + image-level filters
 */
import { fail, redirect } from '@sveltejs/kit';
import { connectDB } from '$lib/server/db/connection.js';
import { CvImage } from '$lib/server/db/models/cv-image.js';
import { CvProject } from '$lib/server/db/models/cv-project.js';
import { CartridgeRecord } from '$lib/server/db/models/cartridge-record.js';
import { AssayDefinition } from '$lib/server/db/models/assay-definition.js';
import { User } from '$lib/server/db/models/user.js';
import { WaxFillingRun } from '$lib/server/db/models/wax-filling-run.js';
import { ReagentBatchRecord } from '$lib/server/db/models/reagent-batch-record.js';
import { AuditLog } from '$lib/server/db/models/audit-log.js';
import { generateId } from '$lib/server/db/utils.js';
import { getR2Url } from '$lib/server/services/r2';
import type { PageServerLoad, Actions } from './$types';

const PAGE_SIZE = 60;

export const load: PageServerLoad = async ({ url, locals }) => {
	if (!locals.user) redirect(302, '/login');
	await connectDB();

	const cartridgeIdSubstr = url.searchParams.get('cartridge')?.trim() || '';
	const assayId = url.searchParams.get('assay') || '';
	const waxRunId = url.searchParams.get('waxRun') || '';
	const reagentRunId = url.searchParams.get('reagentRun') || '';
	const operatorId = url.searchParams.get('operator') || '';
	const status = url.searchParams.get('status') || '';
	const phase = url.searchParams.get('phase') || '';
	const labelFilter = url.searchParams.get('label') || ''; // approved | rejected | unlabeled
	const fromDate = url.searchParams.get('from') || '';
	const toDate = url.searchParams.get('to') || '';
	const pageNum = Math.max(1, parseInt(url.searchParams.get('page') || '1', 10));

	// ===== Stage 1: CartridgeRecord query =====
	const cartFilter: Record<string, any> = {};
	if (cartridgeIdSubstr) cartFilter._id = { $regex: cartridgeIdSubstr, $options: 'i' };
	if (status) cartFilter.status = status;
	if (assayId) cartFilter['reagentFilling.assayType._id'] = assayId;
	if (waxRunId) cartFilter['waxFilling.runId'] = waxRunId;
	if (reagentRunId) cartFilter['reagentFilling.runId'] = reagentRunId;
	if (operatorId) {
		cartFilter.$or = [
			{ 'waxFilling.operator._id': operatorId },
			{ 'reagentFilling.operator._id': operatorId },
			{ 'backing.operator._id': operatorId },
			{ 'waxQc.operator._id': operatorId }
		];
	}
	if (fromDate || toDate) {
		cartFilter.createdAt = {};
		if (fromDate) cartFilter.createdAt.$gte = new Date(fromDate);
		if (toDate) {
			const end = new Date(toDate);
			end.setHours(23, 59, 59, 999);
			cartFilter.createdAt.$lte = end;
		}
	}

	const cartFilterApplied = Object.keys(cartFilter).length > 0;

	// ===== Stage 2: CvImage query =====
	const imgFilter: Record<string, any> = {};

	if (cartFilterApplied) {
		const matchingCarts = await CartridgeRecord.find(cartFilter).select('_id').limit(5000).lean();
		const cartIds = (matchingCarts as any[]).map(c => c._id);
		if (cartIds.length === 0) {
			// No matching carts → no images. Skip the image query but still load
			// the filter+project dropdown sources so the form stays usable.
			const [assays, operators, waxRuns, reagentRuns, distinctStatuses, distinctPhases, projects] = await Promise.all([
				AssayDefinition.find({ isActive: true, hidden: { $ne: true } }, { _id: 1, name: 1, skuCode: 1 }).sort({ name: 1 }).lean(),
				User.find({ isActive: true }, { _id: 1, username: 1 }).sort({ username: 1 }).lean(),
				WaxFillingRun.find().sort({ createdAt: -1 }).limit(50).select('_id runStartTime operator robot').lean(),
				ReagentBatchRecord.find().sort({ createdAt: -1 }).limit(50).select('_id runStartTime operator assayType').lean(),
				CartridgeRecord.distinct('status'),
				CvImage.distinct('cartridgeTag.phase'),
				CvProject.find().select('_id name members').sort({ name: 1 }).lean()
			]);
			return {
				images: [],
				total: 0,
				page: pageNum,
				totalPages: 1,
				pageSize: PAGE_SIZE,
				matchingCartridges: 0,
				filters: { cartridgeIdSubstr, assayId, waxRunId, reagentRunId, operatorId, status, phase, labelFilter, fromDate, toDate },
				assays: (assays as any[]).map(a => ({ id: a._id, name: a.name, sku: a.skuCode ?? null })),
				operators: (operators as any[]).map(u => ({ id: u._id, username: u.username })),
				waxRuns: (waxRuns as any[]).map(r => ({ id: r._id, label: `${r._id.slice(0, 8)} — ${r.operator?.username ?? '?'}` })),
				reagentRuns: (reagentRuns as any[]).map(r => ({ id: r._id, label: `${r._id.slice(0, 8)} — ${r.assayType?.name ?? '?'}` })),
				statuses: (distinctStatuses as string[]).filter(Boolean).sort(),
				phases: (distinctPhases as string[]).filter(Boolean).sort(),
				projects: (projects as any[]).map(p => ({ id: p._id, name: p.name ?? '', memberCount: (p.members ?? []).length }))
			};
		}
		imgFilter['cartridgeTag.cartridgeRecordId'] = { $in: cartIds };
	}

	if (phase) imgFilter['cartridgeTag.phase'] = phase;
	if (labelFilter === 'unlabeled') imgFilter.qcLabel = null;
	else if (labelFilter === 'approved' || labelFilter === 'rejected') imgFilter.qcLabel = labelFilter;

	const [imagesRaw, total, matchingCartridges] = await Promise.all([
		CvImage.find(imgFilter)
			.sort({ capturedAt: -1 })
			.skip((pageNum - 1) * PAGE_SIZE)
			.limit(PAGE_SIZE)
			.select('_id cartridgeImageNumber cartridgeTag filePath imageUrl thumbnailPath qcLabel capturedAt qcLabeledBy qcLabeledAt')
			.lean(),
		CvImage.countDocuments(imgFilter),
		cartFilterApplied
			? CartridgeRecord.countDocuments(cartFilter)
			: 0
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
		qcLabeledByUsername: img.qcLabeledBy?.username ?? null,
		qcLabeledAt: img.qcLabeledAt ?? null
	}));

	// ===== Filter dropdown sources =====
	const [assays, operators, waxRuns, reagentRuns, distinctStatuses, distinctPhases, projects] = await Promise.all([
		AssayDefinition.find({ isActive: true, hidden: { $ne: true } }, { _id: 1, name: 1, skuCode: 1 }).sort({ name: 1 }).lean(),
		User.find({ isActive: true }, { _id: 1, username: 1 }).sort({ username: 1 }).lean(),
		WaxFillingRun.find().sort({ createdAt: -1 }).limit(50).select('_id runStartTime operator robot').lean(),
		ReagentBatchRecord.find().sort({ createdAt: -1 }).limit(50).select('_id runStartTime operator assayType').lean(),
		CartridgeRecord.distinct('status'),
		CvImage.distinct('cartridgeTag.phase'),
		CvProject.find().select('_id name members').sort({ name: 1 }).lean()
	]);

	const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

	return {
		images,
		total,
		page: pageNum,
		totalPages,
		pageSize: PAGE_SIZE,
		matchingCartridges,
		filters: { cartridgeIdSubstr, assayId, waxRunId, reagentRunId, operatorId, status, phase, labelFilter, fromDate, toDate },
		assays: (assays as any[]).map(a => ({ id: a._id, name: a.name, sku: a.skuCode ?? null })),
		operators: (operators as any[]).map(u => ({ id: u._id, username: u.username })),
		waxRuns: (waxRuns as any[]).map(r => ({
			id: r._id,
			label: `${r._id.slice(0, 8)} — ${r.operator?.username ?? '?'} — ${r.runStartTime ? new Date(r.runStartTime).toLocaleDateString() : '?'}`
		})),
		reagentRuns: (reagentRuns as any[]).map(r => ({
			id: r._id,
			label: `${r._id.slice(0, 8)} — ${r.assayType?.name ?? '?'} — ${r.operator?.username ?? '?'}`
		})),
		statuses: (distinctStatuses as string[]).filter(Boolean).sort(),
		phases: (distinctPhases as string[]).filter(Boolean).sort(),
		projects: (projects as any[]).map(p => ({ id: p._id, name: p.name ?? '', memberCount: (p.members ?? []).length }))
	};
};

export const actions: Actions = {
	bulkLabel: async ({ request, locals }) => {
		if (!locals.user) return fail(401, { error: 'Unauthorized' });
		await connectDB();

		const form = await request.formData();
		const rawLabel = form.get('label')?.toString() ?? '';
		const imageIds = form.getAll('imageId').map(v => String(v)).filter(Boolean);

		if (imageIds.length === 0) return fail(400, { error: 'No images selected' });
		if (rawLabel !== 'approved' && rawLabel !== 'rejected' && rawLabel !== 'clear') {
			return fail(400, { error: `Invalid label: ${rawLabel}` });
		}

		const newLabel = rawLabel === 'clear' ? null : rawLabel;

		await CvImage.updateMany(
			{ _id: { $in: imageIds } },
			{ $set: {
				qcLabel: newLabel,
				qcLabeledBy: newLabel ? { _id: locals.user._id, username: locals.user.username } : null,
				qcLabeledAt: newLabel ? new Date() : null
			}}
		);

		// One audit-log row per batch, not per image, to keep volume sane.
		await AuditLog.create({
			_id: generateId(),
			tableName: 'cv_images',
			recordId: imageIds[0],
			action: 'UPDATE',
			newData: { qcLabel: newLabel, count: imageIds.length },
			changedAt: new Date(),
			changedBy: locals.user.username ?? locals.user._id,
			reason: `bulkLabel(${rawLabel}) ${imageIds.length} images`
		});

		return { success: true, updated: imageIds.length, label: newLabel };
	},

	addToProject: async ({ request, locals }) => {
		if (!locals.user) return fail(401, { error: 'Unauthorized' });
		await connectDB();

		const form = await request.formData();
		const projectId = form.get('projectId')?.toString();
		const imageIds = form.getAll('imageId').map(v => String(v)).filter(Boolean);
		if (!projectId) return fail(400, { error: 'projectId required' });
		if (imageIds.length === 0) return fail(400, { error: 'No images selected' });

		const result = await CvProject.updateOne(
			{ _id: projectId },
			{ $addToSet: { members: { $each: imageIds } } }
		);
		if (result.matchedCount === 0) return fail(404, { error: 'Project not found' });

		await AuditLog.create({
			_id: generateId(),
			tableName: 'cv_projects',
			recordId: projectId,
			action: 'UPDATE',
			newData: { membersAdded: imageIds.length },
			changedAt: new Date(),
			changedBy: locals.user.username ?? locals.user._id,
			reason: `addToProject ${imageIds.length} images`
		});

		return { success: true, addedToProject: projectId, count: imageIds.length };
	}
};

export const config = { maxDuration: 60 };
