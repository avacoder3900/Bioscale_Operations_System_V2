import { fail } from '@sveltejs/kit';
import { requirePermission } from '$lib/server/permissions';
import { connectDB, Spu, CartridgeRecord, CartridgeGroup, Integration, AuditLog, generateId } from '$lib/server/db';
import { createAssayRunGroup, evaluateAssayRunGroup, loadAssayRunCriteria } from '$lib/server/assay-run/groups';
import { DEFAULT_ASSAY_RUN_CRITERIA } from '$lib/server/assay-run/evaluate';
import { isGroupColorKey } from '$lib/server/optical-constants';
import type { Actions, PageServerLoad } from './$types';

/**
 * Assay run — validation test #4 (plan §3.3). A GROUP of real cartridges run
 * together on one unit, linked as a CartridgeGroup (purpose 'assay_run') and
 * evaluated as a group: bead index per lane mean/CV, result CV, every run's
 * stage check, lane-C validity, N complete. The group writes the unit's
 * validation.assay_run rollup. Replaces the optical confirmation gate.
 */
const RECENT_LIMIT = 150;

export const load: PageServerLoad = async ({ locals, url }) => {
	requirePermission(locals.user, 'spu:read');
	await connectDB();
	const udi = url.searchParams.get('udi')?.trim() || null;

	const [spus, criteria, groupDocs] = await Promise.all([
		Spu.find({ status: { $ne: 'retired' } }).select('_id udi status validation.assay_run validationResetAt').sort({ udi: 1 }).lean() as Promise<any[]>,
		loadAssayRunCriteria(),
		CartridgeGroup.find({ purpose: 'assay_run', archivedAt: null, ...(udi ? { spuUdi: udi } : {}) })
			.select('_id name color spuId spuUdi cartridgeIds assayId lot intendedConcentration intendedConcentrationUnit evaluation evaluatedAt override createdAt createdBy')
			.sort({ createdAt: -1 })
			.limit(100)
			.lean() as Promise<any[]>
	]);

	// Recent cartridge runs on BT- units: the picker for "which cartridges ran on this unit".
	const recent = (await CartridgeRecord.find({ 'device.name': udi ?? { $regex: /^BT-/ }, 'rawData.readings.0': { $exists: true } })
		.select('_id assayId assayName device checkpoints createdAt status')
		.sort({ createdAt: -1 })
		.limit(RECENT_LIMIT)
		.lean()) as any[];
	const inGroups = new Set(groupDocs.flatMap((g) => g.cartridgeIds ?? []));

	return {
		filterUdi: udi,
		spus: spus.map((s) => ({ id: s._id, udi: s.udi, status: s.status, assayRun: s.validation?.assay_run?.status ?? 'pending' })),
		criteria,
		defaults: DEFAULT_ASSAY_RUN_CRITERIA,
		groups: JSON.parse(
			JSON.stringify(
				groupDocs.map((g) => ({
					id: g._id,
					name: g.name ?? '(unnamed)',
					color: isGroupColorKey(g.color) ? g.color : 'cyan',
					spuId: g.spuId ?? null,
					spuUdi: g.spuUdi ?? null,
					cartridgeIds: g.cartridgeIds ?? [],
					assayId: g.assayId ?? null,
					lot: g.lot ?? null,
					intendedConcentration: g.intendedConcentration ?? null,
					intendedConcentrationUnit: g.intendedConcentrationUnit ?? null,
					evaluation: g.evaluation ?? null,
					evaluatedAt: g.evaluatedAt ?? null,
					override: g.override ?? null,
					createdAt: g.createdAt ?? null,
					createdBy: g.createdBy ?? null
				}))
			)
		),
		recent: recent.map((c) => ({
			id: c._id as string,
			assayId: (c.assayId ?? null) as string | null,
			assayName: (c.assayName ?? null) as string | null,
			spuUdi: (c.device?.name ?? null) as string | null,
			status: (c.status ?? null) as string | null,
			runAt: c.checkpoints?.completed?.when ?? c.checkpoints?.underway?.when ?? c.createdAt ?? null,
			inGroup: inGroups.has(c._id)
		}))
	};
};

export const actions: Actions = {
	create: async ({ request, locals }) => {
		requirePermission(locals.user, 'spu:write');
		await connectDB();
		const form = await request.formData();
		const spuId = form.get('spuId')?.toString() ?? '';
		const name = form.get('name')?.toString().trim() ?? '';
		const ids = (form.get('cartridgeIds')?.toString() ?? '')
			.split(/[\s,;]+/)
			.map((s) => s.trim())
			.filter(Boolean);
		const picked = form.getAll('pick').map((v) => v.toString());
		const all = [...new Set([...ids, ...picked])];
		const conc = form.get('intendedConcentration')?.toString();
		if (!spuId) return fail(400, { error: 'Pick a unit' });
		if (!name) return fail(400, { error: 'Name the group' });
		if (!all.length) return fail(400, { error: 'Scan or pick at least one cartridge' });
		const who = { _id: locals.user!._id, username: locals.user!.username };
		const r = await createAssayRunGroup(
			{
				spuId,
				name,
				cartridgeIds: all,
				assayId: form.get('assayId')?.toString() || null,
				lot: form.get('lot')?.toString() || null,
				intendedConcentration: conc ? Number(conc) : null,
				intendedConcentrationUnit: form.get('intendedConcentrationUnit')?.toString() || null,
				description: form.get('description')?.toString() || null
			},
			who
		);
		if ('error' in r) return fail(400, { error: r.error });
		return { created: r.groupId, name, count: all.length };
	},

	/** Re-derive from the records (new runs that landed since). */
	refresh: async ({ request, locals }) => {
		requirePermission(locals.user, 'spu:write');
		await connectDB();
		const groupId = (await request.formData()).get('groupId')?.toString() ?? '';
		if (!groupId) return fail(400, { error: 'Missing group' });
		const ev = await evaluateAssayRunGroup(groupId, { _id: locals.user!._id, username: locals.user!.username });
		if (!ev) return fail(404, { error: 'Group not found' });
		return { refreshed: groupId, passed: ev.passed };
	},

	addCartridges: async ({ request, locals }) => {
		requirePermission(locals.user, 'spu:write');
		await connectDB();
		const form = await request.formData();
		const groupId = form.get('groupId')?.toString() ?? '';
		const ids = (form.get('cartridgeIds')?.toString() ?? '').split(/[\s,;]+/).map((s) => s.trim()).filter(Boolean);
		if (!groupId || !ids.length) return fail(400, { error: 'Group and at least one barcode are needed' });
		await CartridgeGroup.updateOne({ _id: groupId, purpose: 'assay_run' }, { $addToSet: { cartridgeIds: { $each: ids } } });
		await AuditLog.create({ _id: generateId(), tableName: 'cartridge_groups', recordId: groupId, action: 'UPDATE', newData: { addCartridges: ids }, changedBy: locals.user!.username, changedAt: new Date() });
		await evaluateAssayRunGroup(groupId, { _id: locals.user!._id, username: locals.user!.username });
		return { added: ids.length };
	},

	removeCartridge: async ({ request, locals }) => {
		requirePermission(locals.user, 'spu:write');
		await connectDB();
		const form = await request.formData();
		const groupId = form.get('groupId')?.toString() ?? '';
		const id = form.get('cartridgeId')?.toString() ?? '';
		if (!groupId || !id) return fail(400, { error: 'Missing group or cartridge' });
		await CartridgeGroup.updateOne({ _id: groupId, purpose: 'assay_run' }, { $pull: { cartridgeIds: id } });
		await AuditLog.create({ _id: generateId(), tableName: 'cartridge_groups', recordId: groupId, action: 'UPDATE', newData: { removeCartridge: id }, changedBy: locals.user!.username, changedAt: new Date() });
		await evaluateAssayRunGroup(groupId, { _id: locals.user!._id, username: locals.user!.username });
		return { removed: id };
	},

	/** Human override of the group verdict (recorded, never silent). */
	override: async ({ request, locals }) => {
		requirePermission(locals.user, 'spu:write');
		await connectDB();
		const form = await request.formData();
		const groupId = form.get('groupId')?.toString() ?? '';
		const status = form.get('status')?.toString() ?? '';
		const reason = form.get('reason')?.toString().trim() ?? '';
		if (!groupId || !['overridden', 'failed', ''].includes(status)) return fail(400, { error: 'Bad override' });
		if (status && !reason) return fail(400, { error: 'An override needs a reason' });
		const who = { _id: locals.user!._id, username: locals.user!.username };
		await CartridgeGroup.updateOne({ _id: groupId, purpose: 'assay_run' }, { $set: { override: status ? { by: who, at: new Date(), reason, status } : null } });
		await AuditLog.create({ _id: generateId(), tableName: 'cartridge_groups', recordId: groupId, action: 'override', newData: { status: status || null, reason }, changedBy: who.username, changedAt: new Date() });
		await evaluateAssayRunGroup(groupId, who);
		return { overridden: groupId };
	},

	archive: async ({ request, locals }) => {
		requirePermission(locals.user, 'spu:write');
		await connectDB();
		const groupId = (await request.formData()).get('groupId')?.toString() ?? '';
		if (!groupId) return fail(400, { error: 'Missing group' });
		await CartridgeGroup.updateOne({ _id: groupId, purpose: 'assay_run' }, { $set: { archivedAt: new Date() } });
		await AuditLog.create({ _id: generateId(), tableName: 'cartridge_groups', recordId: groupId, action: 'archive', changedBy: locals.user!.username, changedAt: new Date() });
		return { archived: groupId };
	},

	saveCriteria: async ({ request, locals }) => {
		requirePermission(locals.user, 'spu:write');
		await connectDB();
		const form = await request.formData();
		const keys = ['minRuns', 'beadIndexMin', 'beadIndexMax', 'beadIndexCvMax', 'resultCvMax', 'stageErrorMaxUm', 'stageHitsMax', 'laneCToleranceFrac', 'beadIndexNum', 'beadIndexDen', 'resultExpression', 'sampleLanes'];
		const criteria: Record<string, unknown> = {};
		for (const k of keys) {
			const v = form.get(k)?.toString().trim();
			if (v == null || v === '') continue;
			criteria[k] = k === 'sampleLanes' ? v.split(/[\s,]+/).filter(Boolean) : ['beadIndexNum', 'beadIndexDen', 'resultExpression'].includes(k) ? v : Number(v);
		}
		const prev = (await Integration.findOne({ type: 'assay_run_criteria' }).lean()) as any;
		await Integration.findOneAndUpdate(
			{ type: 'assay_run_criteria' },
			{ $set: { type: 'assay_run_criteria', criteria, updatedBy: locals.user!.username, updatedAt: new Date() }, $setOnInsert: { _id: generateId(), isActive: true } },
			{ upsert: true }
		);
		await AuditLog.create({ _id: generateId(), tableName: 'integrations', recordId: 'assay_run_criteria', action: 'UPDATE', oldData: prev?.criteria ?? null, newData: criteria, changedBy: locals.user!.username, changedAt: new Date() });
		return { criteriaSaved: true };
	}
};

export const config = { maxDuration: 60 };
