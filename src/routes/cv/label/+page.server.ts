/**
 * /cv/label — search-driven labeling.
 *
 * Operator builds a cartridge query (assay, run, operator, status, date, etc.),
 * we resolve the matching CartridgeRecords, then surface their photos[] entries
 * for bulk approve/reject. Human QC truth lives on cartridge_records.photos[];
 * this page reads and writes it directly (never via cv_images).
 *
 * Filters compile in one aggregation pipeline:
 *  Stage 1 ($match): cartridge-level query → the carts that match
 *  Stage 2 ($unwind + $match): their photos[], narrowed by phase/label filters
 */
import { fail, redirect } from '@sveltejs/kit';
import { connectDB } from '$lib/server/db/connection.js';
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

	// ===== Stage 1: cartridge-level match =====
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

	// ===== Stage 2: photo-level match =====
	const photoMatch: Record<string, any> = {};
	if (phase) photoMatch['photos.phase'] = phase;
	if (labelFilter === 'unlabeled') photoMatch['photos.qcLabel'] = null;
	else if (labelFilter === 'approved' || labelFilter === 'rejected') photoMatch['photos.qcLabel'] = labelFilter;

	const pipelineBase: any[] = [];
	if (cartFilterApplied) pipelineBase.push({ $match: cartFilter });
	pipelineBase.push({ $unwind: '$photos' });
	if (Object.keys(photoMatch).length) pipelineBase.push({ $match: photoMatch });

	const [imagesRaw, totalAgg, matchingCartridges, assays, operators, waxRuns, reagentRuns, distinctStatuses, distinctPhases] = await Promise.all([
		CartridgeRecord.aggregate([
			...pipelineBase,
			{ $sort: { 'photos.capturedAt': -1 } },
			{ $skip: (pageNum - 1) * PAGE_SIZE },
			{ $limit: PAGE_SIZE },
			{
				$project: {
					_id: 0,
					imageId: '$photos.imageId',
					cartridgeImageNumber: '$photos.cartridgeImageNumber',
					cartridgeRecordId: '$_id',
					phase: '$photos.phase',
					qcLabel: '$photos.qcLabel',
					r2Url: '$photos.r2Url',
					r2Key: '$photos.r2Key',
					capturedAt: '$photos.capturedAt',
					qcLabeledByUsername: '$photos.qcLabeledBy.username',
					qcLabeledAt: '$photos.qcLabeledAt'
				}
			}
		]),
		CartridgeRecord.aggregate([...pipelineBase, { $count: 'n' }]),
		cartFilterApplied ? CartridgeRecord.countDocuments(cartFilter) : 0,
		AssayDefinition.find({ isActive: true, hidden: { $ne: true } }, { _id: 1, name: 1, skuCode: 1 }).sort({ name: 1 }).lean(),
		User.find({ isActive: true }, { _id: 1, username: 1 }).sort({ username: 1 }).lean(),
		WaxFillingRun.find().sort({ createdAt: -1 }).limit(50).select('_id runStartTime operator robot').lean(),
		ReagentBatchRecord.find().sort({ createdAt: -1 }).limit(50).select('_id runStartTime operator assayType').lean(),
		CartridgeRecord.distinct('status'),
		CartridgeRecord.distinct('photos.phase')
	]);

	const total = (totalAgg as any[])[0]?.n ?? 0;

	const images = (imagesRaw as any[]).map(p => {
		const url = p.r2Url || (p.r2Key ? getR2Url(p.r2Key) : null);
		return {
			id: p.imageId,
			cartridgeImageNumber: p.cartridgeImageNumber ?? null,
			cartridgeRecordId: p.cartridgeRecordId ?? null,
			phase: p.phase ?? null,
			qcLabel: p.qcLabel ?? null,
			url,
			thumbnailUrl: url,
			capturedAt: p.capturedAt ?? null,
			qcLabeledByUsername: p.qcLabeledByUsername ?? null,
			qcLabeledAt: p.qcLabeledAt ?? null
		};
	});

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
		phases: (distinctPhases as string[]).filter(Boolean).sort()
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
		const labeledBy = newLabel ? { _id: locals.user._id, username: locals.user.username } : null;
		const labeledAt = newLabel ? new Date() : null;

		// One targeted write across every matching photos[] entry on every cartridge.
		await CartridgeRecord.updateMany(
			{ 'photos.imageId': { $in: imageIds } },
			{
				$set: {
					'photos.$[p].qcLabel': newLabel,
					'photos.$[p].qcLabeledBy': labeledBy,
					'photos.$[p].qcLabeledAt': labeledAt
				}
			},
			{ arrayFilters: [{ 'p.imageId': { $in: imageIds } }] }
		);

		// One audit-log row per batch, not per image, to keep volume sane.
		await AuditLog.create({
			_id: generateId(),
			tableName: 'cartridge_records',
			recordId: imageIds[0],
			action: 'UPDATE',
			newData: { qcLabel: newLabel, count: imageIds.length },
			changedAt: new Date(),
			changedBy: locals.user.username ?? locals.user._id,
			reason: `bulkLabel(${rawLabel}) ${imageIds.length} photos`
		});

		return { success: true, updated: imageIds.length, label: newLabel };
	}
};

export const config = { maxDuration: 60 };
