import { json } from '@sveltejs/kit';
import { requireAgentApiKey } from '$lib/server/api-auth';
import { connectDB, KanbanPolicy, User, AuditLog, generateId } from '$lib/server/db';
import { getKanbanPolicy } from '$lib/server/kanban/policy';
import { hasPermission, isAdmin } from '$lib/server/permissions';
import type { RequestHandler } from './$types';

/** KB2-04: read the policy (every tunable of the two-tier system). */
export const GET: RequestHandler = async ({ request }) => {
	requireAgentApiKey(request);
	const policy = await getKanbanPolicy();
	return json({ success: true, data: JSON.parse(JSON.stringify(policy)) });
};

/**
 * KB2-04: tune the policy at runtime — no deploy. Actor must hold
 * kanban:admin (or admin:full). Every edit audited.
 */
const EDITABLE_PATHS = new Set([
	'boards.ops.readyCap', 'boards.ops.minOrderPoint',
	'boards.software.readyCap', 'boards.software.minOrderPoint',
	'wipPerPerson', 'wipChoreMax', 'pullWindow',
	'expedite.systemMax', 'expedite.alertPctRolling30d',
	'allocation.standard', 'allocation.fixed_date', 'allocation.chore',
	'sizeClassDefinitions.short', 'sizeClassDefinitions.medium', 'sizeClassDefinitions.long',
	'sle.percentile', 'sle.perSizeClassDays.short', 'sle.perSizeClassDays.medium', 'sle.perSizeClassDays.long',
	'recalibrateAfter'
]);

export const PATCH: RequestHandler = async ({ request }) => {
	requireAgentApiKey(request);
	await connectDB();
	const body = await request.json();
	const { actor, updates } = body; // updates: { "<dot.path>": value }

	if (!actor?.trim()) return json({ success: false, error: 'actor (username) is required' }, { status: 400 });
	const user: any = await User.findOne({ username: actor.trim().toLowerCase() }).select('username isActive roles').lean();
	if (!user || user.isActive === false) {
		return json({ success: false, error: `Actor '${actor}' is not an active BIMS user.` }, { status: 401 });
	}
	if (!hasPermission(user, 'kanban:admin') && !isAdmin(user)) {
		return json({ success: false, error: `${user.username} does not hold kanban:admin.` }, { status: 403 });
	}
	if (!updates || typeof updates !== 'object' || Array.isArray(updates)) {
		return json({ success: false, error: 'updates must be an object of {path: value}' }, { status: 400 });
	}

	const $set: Record<string, unknown> = {};
	const invalid: string[] = [];
	for (const [path, value] of Object.entries(updates)) {
		if (!EDITABLE_PATHS.has(path)) { invalid.push(path); continue; }
		$set[path] = path === 'recalibrateAfter' ? new Date(value as string) : value;
	}
	if (invalid.length) {
		return json({ success: false, error: `Unknown policy paths: ${invalid.join(', ')}` }, { status: 400 });
	}
	if (!Object.keys($set).length) {
		return json({ success: false, error: 'No valid updates provided' }, { status: 400 });
	}

	await getKanbanPolicy(); // ensure the singleton exists
	$set.updatedBy = user.username;
	$set.updatedAt = new Date();
	await KanbanPolicy.updateOne({ _id: 'default' }, { $set });

	await AuditLog.create({
		_id: generateId(),
		tableName: 'kanban_policy',
		recordId: 'default',
		action: 'UPDATE',
		newData: { updates: $set, via: 'mcp' },
		changedBy: user.username,
		changedAt: new Date()
	});

	const policy = await getKanbanPolicy();
	return json({ success: true, data: JSON.parse(JSON.stringify(policy)) });
};
