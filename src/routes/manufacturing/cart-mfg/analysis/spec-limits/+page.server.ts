import { redirect, fail } from '@sveltejs/kit';
import { connectDB, SpecLimit, AuditLog, generateId } from '$lib/server/db';
import { requirePermission } from '$lib/server/permissions';
import { PROCESS_TYPES, PROCESS_LABELS } from '$lib/server/analytics/types.js';
import type { PageServerLoad, Actions } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	if (!locals.user) redirect(302, '/login');
	requirePermission(locals.user, 'manufacturing:read');
	await connectDB();
	const all = await SpecLimit.find({}).sort({ processType: 1, metric: 1 }).lean();
	return {
		specLimits: (all as any[]).map(s => ({
			id: String(s._id),
			processType: s.processType,
			processLabel: PROCESS_LABELS[s.processType as keyof typeof PROCESS_LABELS] ?? s.processType,
			metric: s.metric,
			metricLabel: s.metricLabel ?? s.metric,
			unit: s.unit ?? '',
			LSL: s.LSL ?? null,
			USL: s.USL ?? null,
			target: s.target ?? null,
			cpkMin: s.cpkMin ?? 1.33,
			rationale: s.rationale ?? '',
			approvedBy: s.approvedBy?.username ?? null,
			effectiveFrom: s.effectiveFrom?.toISOString?.() ?? null,
			active: s.active
		})),
		processes: PROCESS_TYPES.map(p => ({ id: p, label: PROCESS_LABELS[p] }))
	};
};

export const actions: Actions = {
	save: async ({ request, locals }) => {
		if (!locals.user) return fail(401);
		requirePermission(locals.user, 'manufacturing:admin');
		await connectDB();
		const f = await request.formData();
		const id = f.get('id')?.toString() || generateId();
		const rationale = f.get('rationale')?.toString() ?? '';
		const metric = f.get('metric')?.toString() ?? '';
		if (!metric) return fail(400, { error: 'Metric is required' });
		if (!rationale) return fail(400, { error: 'Rationale is required for regulatory traceability' });
		const doc: any = {
			_id: id,
			processType: f.get('processType')?.toString() ?? 'general',
			metric,
			metricLabel: f.get('metricLabel')?.toString() || metric,
			unit: f.get('unit')?.toString() || '',
			LSL: f.get('LSL') ? Number(f.get('LSL')) : null,
			USL: f.get('USL') ? Number(f.get('USL')) : null,
			target: f.get('target') ? Number(f.get('target')) : null,
			cpkMin: f.get('cpkMin') ? Number(f.get('cpkMin')) : 1.33,
			rationale,
			approvedBy: { _id: locals.user._id, username: locals.user.username },
			approvedAt: new Date(),
			active: true
		};
		await SpecLimit.findByIdAndUpdate(id, doc, { upsert: true, new: true });
		await AuditLog.create({
			_id: generateId(),
			tableName: 'spec_limits',
			recordId: id,
			action: 'UPSERT',
			changedBy: locals.user.username,
			changedAt: new Date(),
			newData: doc,
			reason: rationale
		}).catch(() => {});
		return { success: true };
	},

	retire: async ({ request, locals }) => {
		if (!locals.user) return fail(401);
		requirePermission(locals.user, 'manufacturing:admin');
		await connectDB();
		const f = await request.formData();
		const id = f.get('id')?.toString();
		if (!id) return fail(400);
		await SpecLimit.findByIdAndUpdate(id, { active: false });
		await AuditLog.create({
			_id: generateId(),
			tableName: 'spec_limits',
			recordId: id,
			action: 'RETIRE',
			changedBy: locals.user.username,
			changedAt: new Date()
		}).catch(() => {});
		return { success: true };
	}
};
