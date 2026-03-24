import { redirect, fail } from '@sveltejs/kit';
import { requirePermission } from '$lib/server/permissions';
import {
	connectDB, CartridgeRecord, AssayDefinition, ShippingLot, ReagentBatchRecord, generateId, AuditLog
} from '$lib/server/db';
import type { PageServerLoad, Actions } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	if (!locals.user) redirect(302, '/login');
	requirePermission(locals.user, 'cartridge:read');
	await connectDB();

	const [assayTypes, lots, runs] = await Promise.all([
		AssayDefinition.find({ isActive: true }, { _id: 1, name: 1 }).lean(),
		ShippingLot.find({ status: { $in: ['open', 'released'] } }).sort({ createdAt: -1 }).lean(),
		ReagentBatchRecord.find(
			{ status: 'completed', 'qcRelease.testResult': { $ne: 'pass' }, finalizedAt: { $exists: false } },
			{ _id: 1, runNumber: 1, 'assayType._id': 1, 'assayType.name': 1, cartridgeCount: 1 }
		).sort({ createdAt: -1 }).lean()
	]);

	// Build releases list from shipping lots' qaqcReleases
	const releases = (lots as any[]).flatMap((lot: any) =>
		(lot.qaqcReleases ?? []).map((rel: any) => ({
			id: rel._id,
			lotId: lot._id,
			reagentRunId: rel.reagentRunId ?? null,
			qaqcCartridgeIds: rel.qaqcCartridgeIds ?? [],
			testResult: rel.testResult ?? 'pending',
			testedBy: rel.testedBy?.username ?? null,
			testedAt: rel.testedAt ?? null,
			notes: rel.notes ?? null
		}))
	);

	return {
		assayTypes: (assayTypes as any[]).map((a: any) => ({ id: a._id, name: a.name })),
		lots: (lots as any[]).map((l: any) => ({
			id: l._id,
			assayTypeId: l.assayType?._id ?? null,
			customerId: l.customer?._id ?? null,
			status: l.status ?? 'open',
			cartridgeCount: l.cartridgeCount ?? 0,
			releasedAt: l.releasedAt ?? null,
			createdAt: l.createdAt
		})),
		releasableRuns: (runs as any[]).map((r: any) => ({
			runId: r._id,
			runNumber: r.runNumber ?? '',
			assayTypeId: r.assayType?._id ?? null,
			assayTypeName: r.assayType?.name ?? null,
			cartridgeCount: r.cartridgeCount ?? 0
		})),
		releases,
		lotId: null,
		action: null
	};
};

export const actions: Actions = {
	createLot: async ({ request, locals }) => {
		requirePermission(locals.user, 'cartridge:write');
		await connectDB();
		const form = await request.formData();
		const assayTypeId = form.get('assayTypeId')?.toString();

		let assayRef = null;
		if (assayTypeId) {
			const assay = await AssayDefinition.findById(assayTypeId).lean() as any;
			if (assay) assayRef = { _id: assay._id, name: assay.name };
		}

		const lot = await ShippingLot.create({
			_id: generateId(),
			assayType: assayRef,
			status: 'open',
			cartridgeCount: 0
		});
		await AuditLog.create({
			_id: generateId(),
			tableName: 'shipping_lots',
			recordId: lot._id,
			action: 'INSERT',
			changedBy: locals.user?.username ?? locals.user?._id,
			changedAt: new Date()
		});
		return { success: true, action: 'createLot', lotId: lot._id };
	},

	createRelease: async ({ request, locals }) => {
		requirePermission(locals.user, 'cartridge:write');
		await connectDB();
		const form = await request.formData();
		const lotId = form.get('lotId')?.toString();
		const reagentRunId = form.get('reagentRunId')?.toString();
		if (!lotId) return fail(400, { error: 'Lot ID required' });

		const newRelease = {
			_id: generateId(),
			reagentRunId: reagentRunId ?? null,
			qaqcCartridgeIds: [],
			testResult: 'pending',
			createdAt: new Date()
		};

		await ShippingLot.updateOne({ _id: lotId }, { $push: { qaqcReleases: newRelease } });
		await AuditLog.create({
			_id: generateId(),
			tableName: 'shipping_lots',
			recordId: lotId,
			action: 'UPDATE',
			changedBy: locals.user?.username ?? locals.user?._id,
			changedAt: new Date()
		});
		return { success: true, action: 'createRelease', message: 'QAQC release created' };
	},

	recordTestResult: async ({ request, locals }) => {
		requirePermission(locals.user, 'cartridge:write');
		await connectDB();
		const form = await request.formData();
		const lotId = form.get('lotId')?.toString();
		const releaseId = form.get('releaseId')?.toString();
		const testResult = form.get('testResult')?.toString();
		const notes = form.get('notes')?.toString() ?? '';

		if (!lotId || !releaseId || !testResult) return fail(400, { error: 'Missing required fields' });

		await ShippingLot.updateOne(
			{ _id: lotId, 'qaqcReleases._id': releaseId },
			{
				$set: {
					'qaqcReleases.$.testResult': testResult,
					'qaqcReleases.$.testedBy': { _id: locals.user!._id, username: locals.user!.username },
					'qaqcReleases.$.testedAt': new Date(),
					'qaqcReleases.$.notes': notes
				}
			}
		);
		await AuditLog.create({
			_id: generateId(),
			tableName: 'shipping_lots',
			recordId: lotId,
			action: 'UPDATE',
			changedBy: locals.user?.username ?? locals.user?._id,
			changedAt: new Date()
		});
		return { success: true, message: 'Test result recorded' };
	}
};

export const config = { maxDuration: 60 };
