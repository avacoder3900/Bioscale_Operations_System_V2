import { fail, redirect } from '@sveltejs/kit';
import { connectDB, AssayDefinition, CartridgeRecord, AuditLog, generateId } from '$lib/server/db';
import { generateLegacyAssayId } from '$lib/server/assay-legacy-shape';
import { hasPermission, requirePermission } from '$lib/server/permissions';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, url }) => {
	if (!locals.user) redirect(302, '/login');
	requirePermission(locals.user, 'manufacturing:read');
	await connectDB();

	// Parse filter params
	const search = url.searchParams.get('search') || null;
	const status = url.searchParams.get('status') || null;

	// Build query
	const query: any = {};
	if (search) {
		query.$or = [
			{ name: { $regex: search, $options: 'i' } },
			{ skuCode: { $regex: search, $options: 'i' } }
		];
	}
	if (status === 'active') query.isActive = true;
	if (status === 'inactive') query.isActive = false;

	const [assays, linkedCounts] = await Promise.all([
		AssayDefinition.find(query).sort({ name: 1 }).lean(),
		CartridgeRecord.aggregate([
			{ $match: { 'reagentFilling.assayType._id': { $exists: true } } },
			{ $group: { _id: '$reagentFilling.assayType._id', count: { $sum: 1 } } }
		])
	]);

	// Build linked cartridge count map
	const linkedMap = new Map(linkedCounts.map((c: any) => [c._id, c.count]));

	// Compute stats from full list (before any future pagination)
	const allAssays = await AssayDefinition.find().lean();
	const totalLinked = linkedCounts.reduce((sum: number, c: any) => sum + c.count, 0);

	return {
		assays: assays.map((a: any) => ({
			assayId: a._id,
			name: a.name,
			duration: a.duration ?? null,
			bcodeLength: a.bcodeLength ?? null,
			version: a.versionHistory?.length ?? 0,
			linkedCartridges: linkedMap.get(a._id) ?? 0,
			isActive: a.isActive ?? true,
			updatedAt: a.updatedAt ?? null
		})),
		stats: {
			total: allAssays.length,
			active: allAssays.filter((a: any) => a.isActive).length,
			inactive: allAssays.filter((a: any) => !a.isActive).length,
			totalLinkedCartridges: totalLinked
		},
		filters: { search: search ?? '', status },
		canWrite: hasPermission(locals.user, 'assay:write'),
		canDelete: hasPermission(locals.user, 'assay:write')
	};
};

export const actions: Actions = {
	duplicate: async ({ request, locals }) => {
		if (!locals.user) redirect(302, '/login');
		requirePermission(locals.user, 'assay:write');
		await connectDB();
		const form = await request.formData();
		const assayId = form.get('assayId')?.toString();
		if (!assayId) return fail(400, { error: 'Assay ID required' });
		const original = await AssayDefinition.findById(assayId).lean() as any;
		if (!original) return fail(404, { error: 'Assay not found' });
		const newId = await generateLegacyAssayId(AssayDefinition as any);
		await AssayDefinition.create({
			_id: newId,
			name: `${original.name} (Copy)`,
			// Legacy shape: skuCode is null unless user explicitly sets it later.
			skuCode: null,
			description: original.description,
			duration: original.duration,
			BCODE: original.BCODE ?? undefined,
			hidden: true,
			protected: true,
			isActive: true,
			reagents: original.reagents ?? [],
			versionHistory: []
		});
		await AuditLog.create({
			_id: generateId(),
			tableName: 'assay_definitions',
			recordId: newId,
			action: 'INSERT',
			changedBy: locals.user?.username,
			changedAt: new Date()
		});
		return { success: true };
	},

	delete: async ({ request, locals }) => {
		if (!locals.user) redirect(302, '/login');
		requirePermission(locals.user, 'assay:write');
		await connectDB();
		const form = await request.formData();
		const assayId = form.get('assayId')?.toString();
		if (!assayId) return fail(400, { error: 'Assay ID required' });
		await AssayDefinition.updateOne({ _id: assayId }, { $set: { isActive: false } });
		await AuditLog.create({
			_id: generateId(),
			tableName: 'assay_definitions',
			recordId: assayId,
			action: 'UPDATE',
			changedBy: locals.user?.username,
			changedAt: new Date()
		});
		return { success: true };
	}
};

export const config = { maxDuration: 60 };
