/**
 * KB2-04 — policy tuning page. Every knob of the two-tier system, editable at
 * runtime by kanban:admin (or admins), audited. Mirrors the shape of the
 * agent policy endpoint (src/routes/api/agent/operations/kanban/policy) but
 * session-authenticated. Also hosts StandingTarget CRUD (KB2-10).
 */
import { fail, redirect, error } from '@sveltejs/kit';
import { connectDB, KanbanPolicy, StandingTarget, KanbanTemplate, AuditLog, generateId } from '$lib/server/db';
import { requirePermission, hasPermission, isAdmin } from '$lib/server/permissions';
import { getKanbanPolicy } from '$lib/server/kanban/policy';
import { SIZE_CLASSES, CLASSES_OF_SERVICE } from '$lib/shared/kanban-status';
import type { PageServerLoad, Actions } from './$types';

function requirePolicyAdmin(user: App.Locals['user']): asserts user {
	if (!user) redirect(302, '/login');
	if (!hasPermission(user, 'kanban:admin') && !isAdmin(user)) {
		error(403, 'Permission denied: requires kanban:admin');
	}
}

export const load: PageServerLoad = async ({ locals }) => {
	if (!locals.user) redirect(302, '/login');
	requirePermission(locals.user, 'kanban:read');
	await connectDB();

	const policy = await getKanbanPolicy();
	const targets = (await StandingTarget.find({}).sort({ active: -1, name: 1 }).lean()) as any[];
	const templates = (await KanbanTemplate.find({}).sort({ active: -1, name: 1 }).lean()) as any[];

	return {
		canAdmin: hasPermission(locals.user, 'kanban:admin') || isAdmin(locals.user),
		policy: JSON.parse(JSON.stringify(policy)),
		targets: JSON.parse(
			JSON.stringify(
				targets.map((t) => ({
					id: t._id,
					name: t.name,
					board: t.board ?? 'ops',
					metricKind: t.metric?.kind ?? 'manual',
					metricParams: JSON.stringify(t.metric?.params ?? {}, null, 0),
					target: t.target,
					reorderPoint: t.reorderPoint,
					batchSize: t.batchSize,
					spawnItemType: t.spawnItemType ?? 'deliverable',
					spawnSizeClass: t.spawnSizeClass ?? 'short',
					autoCommit: t.autoCommit !== false,
					templateId: t.templateId ?? '',
					active: t.active !== false,
					notes: t.notes ?? ''
				}))
			)
		),
		templates: JSON.parse(
			JSON.stringify(
				templates.map((t) => ({
					id: t._id,
					name: t.name,
					board: t.board ?? 'ops',
					itemType: t.itemType ?? 'deliverable',
					sizeClass: t.sizeClass,
					classOfService: t.classOfService ?? 'standard',
					titleTemplate: t.titleTemplate,
					dorDeliverable: t.dor?.deliverable ?? '',
					dorHandoffBrief: t.dor?.handoffBrief ?? '',
					tags: (t.tags ?? []).join(', '),
					defaultProjectId: t.defaultProjectId ?? '',
					notes: t.notes ?? '',
					active: t.active !== false
				}))
			)
		)
	};
};

// Form field name → policy dot-path (same editable set as the agent endpoint).
const NUMBER_FIELDS: [string, string][] = [
	['ops_readyCap', 'boards.ops.readyCap'],
	['ops_minOrderPoint', 'boards.ops.minOrderPoint'],
	['software_readyCap', 'boards.software.readyCap'],
	['software_minOrderPoint', 'boards.software.minOrderPoint'],
	['wipPerPerson', 'wipPerPerson'],
	['wipChoreMax', 'wipChoreMax'],
	['pullWindow', 'pullWindow'],
	['expedite_systemMax', 'expedite.systemMax'],
	['expedite_alertPct', 'expedite.alertPctRolling30d'],
	['allocation_standard', 'allocation.standard'],
	['allocation_fixed_date', 'allocation.fixed_date'],
	['allocation_chore', 'allocation.chore'],
	['sle_percentile', 'sle.percentile']
];
// Nullable numbers: empty string clears the seed.
const NULLABLE_NUMBER_FIELDS: [string, string][] = [
	['sle_short', 'sle.perSizeClassDays.short'],
	['sle_medium', 'sle.perSizeClassDays.medium'],
	['sle_long', 'sle.perSizeClassDays.long']
];
const STRING_FIELDS: [string, string][] = [
	['sizeClass_short', 'sizeClassDefinitions.short'],
	['sizeClass_medium', 'sizeClassDefinitions.medium'],
	['sizeClass_long', 'sizeClassDefinitions.long']
];

function parseTargetForm(fd: FormData) {
	const name = fd.get('name')?.toString()?.trim();
	if (!name) return { error: 'Name is required' };
	const kind = fd.get('metricKind')?.toString();
	if (!kind || !['cartridge_phase_count', 'part_stock', 'reagent_stock', 'manual'].includes(kind)) {
		return { error: 'A valid metric kind is required' };
	}
	let params: unknown = {};
	const paramsRaw = fd.get('metricParams')?.toString()?.trim();
	if (paramsRaw) {
		try {
			params = JSON.parse(paramsRaw);
		} catch {
			return { error: 'Metric params must be valid JSON' };
		}
	}
	const target = Number(fd.get('target'));
	const reorderPoint = Number(fd.get('reorderPoint'));
	const batchSize = Number(fd.get('batchSize'));
	if (!Number.isFinite(target) || !Number.isFinite(reorderPoint) || !Number.isFinite(batchSize)) {
		return { error: 'Target, reorder point, and batch size must be numbers' };
	}
	const spawnItemType = fd.get('spawnItemType')?.toString() === 'chore' ? 'chore' : 'deliverable';
	const board = fd.get('board')?.toString() === 'software' ? 'software' : 'ops';
	const spawnSizeClassRaw = fd.get('spawnSizeClass')?.toString();
	const spawnSizeClass = spawnSizeClassRaw && ['short', 'medium', 'long'].includes(spawnSizeClassRaw) ? spawnSizeClassRaw : 'short';
	return {
		doc: {
			name,
			board,
			metric: { kind, params },
			target,
			reorderPoint,
			batchSize,
			spawnItemType,
			// KB2-13: auto-commit spawned cards straight to ready (checkbox; off = KB2-10 captured option)
			autoCommit: fd.get('autoCommit') === 'on',
			spawnSizeClass,
			templateId: fd.get('templateId')?.toString() || null, // null (not undefined) so an edit can clear the link
			notes: fd.get('notes')?.toString() || undefined
		}
	};
}

// KB2-11 — workflow template form parsing (same shape as parseTargetForm).
// Spikes cannot be templated: itemType is limited to deliverable|chore.
function parseTemplateForm(fd: FormData) {
	const name = fd.get('name')?.toString()?.trim();
	if (!name) return { error: 'Name is required' };
	const titleTemplate = fd.get('titleTemplate')?.toString()?.trim();
	if (!titleTemplate) return { error: 'Title template is required' };
	const sizeClass = fd.get('sizeClass')?.toString();
	if (!sizeClass || !(SIZE_CLASSES as readonly string[]).includes(sizeClass)) {
		return { error: 'A valid size class is required' };
	}
	const classOfService = fd.get('classOfService')?.toString();
	if (!classOfService || !(CLASSES_OF_SERVICE as readonly string[]).includes(classOfService)) {
		return { error: 'A valid class of service is required' };
	}
	const deliverable = fd.get('dorDeliverable')?.toString()?.trim();
	if (!deliverable) {
		return { error: 'DoR deliverable is required — a template captures the SOP shape, DoR-complete' };
	}
	const board = fd.get('board')?.toString() === 'software' ? 'software' : 'ops';
	const tags = (fd.get('tags')?.toString() ?? '')
		.split(',')
		.map((s) => s.trim())
		.filter(Boolean);
	return {
		doc: {
			name,
			board,
			itemType: fd.get('itemType')?.toString() === 'chore' ? 'chore' : 'deliverable',
			sizeClass,
			classOfService,
			titleTemplate,
			dor: {
				deliverable,
				handoffBrief: board === 'software' ? fd.get('dorHandoffBrief')?.toString() || undefined : undefined
			},
			tags,
			defaultProjectId: fd.get('defaultProjectId')?.toString() || undefined,
			notes: fd.get('notes')?.toString() || undefined,
			active: fd.get('active') === 'on'
		}
	};
}

export const actions: Actions = {
	savePolicy: async ({ request, locals }) => {
		requirePolicyAdmin(locals.user);
		await connectDB();
		const fd = await request.formData();

		const $set: Record<string, unknown> = {};
		for (const [field, path] of NUMBER_FIELDS) {
			const raw = fd.get(field)?.toString();
			if (raw === undefined || raw === null || raw === '') continue;
			const n = Number(raw);
			if (!Number.isFinite(n)) return fail(400, { error: `'${field}' must be a number` });
			$set[path] = n;
		}
		for (const [field, path] of NULLABLE_NUMBER_FIELDS) {
			const raw = fd.get(field)?.toString();
			if (raw === undefined || raw === null) continue;
			if (raw === '') {
				$set[path] = null;
				continue;
			}
			const n = Number(raw);
			if (!Number.isFinite(n)) return fail(400, { error: `'${field}' must be a number or empty` });
			$set[path] = n;
		}
		for (const [field, path] of STRING_FIELDS) {
			const raw = fd.get(field)?.toString();
			if (raw !== undefined && raw !== null) $set[path] = raw;
		}
		const recal = fd.get('recalibrateAfter')?.toString();
		if (recal) $set['recalibrateAfter'] = new Date(recal);

		if (!Object.keys($set).length) return fail(400, { error: 'No policy changes provided' });

		await getKanbanPolicy(); // ensure the singleton exists
		const now = new Date();
		$set.updatedBy = locals.user.username;
		$set.updatedAt = now;
		await KanbanPolicy.updateOne({ _id: 'default' }, { $set });

		await AuditLog.create({
			_id: generateId(),
			tableName: 'kanban_policy',
			recordId: 'default',
			action: 'UPDATE',
			newData: { updates: $set, via: 'ui' },
			changedBy: locals.user.username,
			changedAt: now
		});

		return { success: true };
	},

	createTarget: async ({ request, locals }) => {
		requirePolicyAdmin(locals.user);
		await connectDB();
		const fd = await request.formData();
		const parsed = parseTargetForm(fd);
		if ('error' in parsed) return fail(400, { error: parsed.error });

		const now = new Date();
		const target = await StandingTarget.create({
			_id: generateId(),
			...parsed.doc,
			active: true,
			createdBy: locals.user.username
		});
		await AuditLog.create({
			_id: generateId(),
			tableName: 'kanban_standing_targets',
			recordId: target._id,
			action: 'INSERT',
			newData: { ...parsed.doc, via: 'ui' },
			changedBy: locals.user.username,
			changedAt: now
		});
		return { success: true };
	},

	updateTarget: async ({ request, locals }) => {
		requirePolicyAdmin(locals.user);
		await connectDB();
		const fd = await request.formData();
		const targetId = fd.get('targetId')?.toString();
		if (!targetId) return fail(400, { error: 'Missing targetId' });
		const parsed = parseTargetForm(fd);
		if ('error' in parsed) return fail(400, { error: parsed.error });

		const existing = (await StandingTarget.findById(targetId).lean()) as any;
		if (!existing) return fail(404, { error: 'Standing target not found' });

		const now = new Date();
		await StandingTarget.updateOne({ _id: targetId }, { $set: parsed.doc });
		await AuditLog.create({
			_id: generateId(),
			tableName: 'kanban_standing_targets',
			recordId: targetId,
			action: 'UPDATE',
			oldData: { name: existing.name, target: existing.target, reorderPoint: existing.reorderPoint },
			newData: { ...parsed.doc, via: 'ui' },
			changedBy: locals.user.username,
			changedAt: now
		});
		return { success: true };
	},

	toggleTarget: async ({ request, locals }) => {
		requirePolicyAdmin(locals.user);
		await connectDB();
		const fd = await request.formData();
		const targetId = fd.get('targetId')?.toString();
		if (!targetId) return fail(400, { error: 'Missing targetId' });

		const existing = (await StandingTarget.findById(targetId).lean()) as any;
		if (!existing) return fail(404, { error: 'Standing target not found' });

		const active = existing.active === false; // flip
		const now = new Date();
		await StandingTarget.updateOne({ _id: targetId }, { $set: { active } });
		await AuditLog.create({
			_id: generateId(),
			tableName: 'kanban_standing_targets',
			recordId: targetId,
			action: 'UPDATE',
			oldData: { active: existing.active !== false },
			newData: { active, via: 'ui' },
			changedBy: locals.user.username,
			changedAt: now
		});
		return { success: true };
	},

	// KB2-11 — workflow template CRUD (same gating + audit shape as standing targets).
	createTemplate: async ({ request, locals }) => {
		requirePolicyAdmin(locals.user);
		await connectDB();
		const fd = await request.formData();
		const parsed = parseTemplateForm(fd);
		if ('error' in parsed) return fail(400, { error: parsed.error });

		const now = new Date();
		const tpl = await KanbanTemplate.create({
			_id: generateId(),
			...parsed.doc,
			createdBy: locals.user.username
		});
		await AuditLog.create({
			_id: generateId(),
			tableName: 'kanban_templates',
			recordId: tpl._id,
			action: 'INSERT',
			newData: { ...parsed.doc, via: 'ui' },
			changedBy: locals.user.username,
			changedAt: now
		});
		return { success: true };
	},

	updateTemplate: async ({ request, locals }) => {
		requirePolicyAdmin(locals.user);
		await connectDB();
		const fd = await request.formData();
		const templateId = fd.get('templateId')?.toString();
		if (!templateId) return fail(400, { error: 'Missing templateId' });
		const parsed = parseTemplateForm(fd);
		if ('error' in parsed) return fail(400, { error: parsed.error });

		const existing = (await KanbanTemplate.findById(templateId).lean()) as any;
		if (!existing) return fail(404, { error: 'Template not found' });

		const now = new Date();
		await KanbanTemplate.updateOne({ _id: templateId }, { $set: parsed.doc });
		await AuditLog.create({
			_id: generateId(),
			tableName: 'kanban_templates',
			recordId: templateId,
			action: 'UPDATE',
			oldData: { name: existing.name, sizeClass: existing.sizeClass, classOfService: existing.classOfService },
			newData: { ...parsed.doc, via: 'ui' },
			changedBy: locals.user.username,
			changedAt: now
		});
		return { success: true };
	},

	toggleTemplate: async ({ request, locals }) => {
		requirePolicyAdmin(locals.user);
		await connectDB();
		const fd = await request.formData();
		const templateId = fd.get('templateId')?.toString();
		if (!templateId) return fail(400, { error: 'Missing templateId' });

		const existing = (await KanbanTemplate.findById(templateId).lean()) as any;
		if (!existing) return fail(404, { error: 'Template not found' });

		const active = existing.active === false; // flip
		const now = new Date();
		await KanbanTemplate.updateOne({ _id: templateId }, { $set: { active } });
		await AuditLog.create({
			_id: generateId(),
			tableName: 'kanban_templates',
			recordId: templateId,
			action: 'UPDATE',
			oldData: { active: existing.active !== false },
			newData: { active, via: 'ui' },
			changedBy: locals.user.username,
			changedAt: now
		});
		return { success: true };
	}
};

export const config = { maxDuration: 60 };
