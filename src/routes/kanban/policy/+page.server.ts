/**
 * KB2-04 — policy tuning page. Every knob of the two-tier system, editable at
 * runtime by kanban:admin (or admins), audited. Mirrors the shape of the
 * agent policy endpoint (src/routes/api/agent/operations/kanban/policy) but
 * session-authenticated. Also hosts StandingTarget CRUD (KB2-10).
 */
import { fail, redirect, error } from '@sveltejs/kit';
import { connectDB, KanbanPolicy, StandingTarget, AuditLog, generateId } from '$lib/server/db';
import { requirePermission, hasPermission, isAdmin } from '$lib/server/permissions';
import { getKanbanPolicy } from '$lib/server/kanban/policy';
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
					active: t.active !== false,
					notes: t.notes ?? ''
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
	if (!kind || !['cartridge_phase_count', 'part_stock', 'manual'].includes(kind)) {
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
	return {
		doc: {
			name,
			board,
			metric: { kind, params },
			target,
			reorderPoint,
			batchSize,
			spawnItemType,
			notes: fd.get('notes')?.toString() || undefined
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
	}
};

export const config = { maxDuration: 60 };
