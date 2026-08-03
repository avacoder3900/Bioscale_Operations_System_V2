import { json } from '@sveltejs/kit';
import { requireAgentApiKey } from '$lib/server/api-auth';
import { connectDB, StandingTarget, AuditLog, generateId } from '$lib/server/db';
import { standingStatus } from '$lib/server/kanban/standing';
import type { RequestHandler } from './$types';

/**
 * KB2-10/KB2-13: the supply loops. GET = live target-vs-actual for standing
 * targets + parts at/below their minimum order qty (?spawn=1 also spawns the
 * auto-committed supply cards for anything below its trigger — idempotent;
 * KB2-13: cards land directly in ready unless the target has autoCommit:false).
 * POST = create/update a target.
 */
export const GET: RequestHandler = async ({ request, url }) => {
	requireAgentApiKey(request);
	await connectDB();
	const spawn = url.searchParams.get('spawn') === '1';
	const actor = url.searchParams.get('actor') ?? 'system:supply';
	const { targets, partsReorder } = await standingStatus({ spawn, actorUsername: actor });
	return json({ success: true, data: { targets, partsReorder } });
};

export const POST: RequestHandler = async ({ request }) => {
	requireAgentApiKey(request);
	await connectDB();
	const body = await request.json();
	const { targetId, actor, ...fields } = body;

	if (!actor?.trim()) return json({ success: false, error: 'actor (username) is required' }, { status: 400 });

	if (targetId) {
		const allowed = ['name', 'metric', 'target', 'reorderPoint', 'batchSize', 'spawnItemType', 'active', 'notes', 'board', 'autoCommit', 'spawnSizeClass', 'templateId'];
		const $set: Record<string, unknown> = {};
		for (const k of allowed) if (fields[k] !== undefined) $set[k] = fields[k];
		if (!Object.keys($set).length) return json({ success: false, error: 'No updatable fields provided' }, { status: 400 });
		const updated = await StandingTarget.findByIdAndUpdate(targetId, { $set }, { new: true }).lean();
		if (!updated) return json({ success: false, error: 'Target not found' }, { status: 404 });
		await AuditLog.create({
			_id: generateId(), tableName: 'kanban_standing_targets', recordId: targetId,
			action: 'UPDATE', newData: $set, changedBy: actor.trim(), changedAt: new Date()
		});
		return json({ success: true, data: JSON.parse(JSON.stringify(updated)) });
	}

	const { name, metric, target, reorderPoint, batchSize } = fields;
	if (!name || !metric?.kind || target == null || reorderPoint == null || batchSize == null) {
		return json(
			{ success: false, error: 'name, metric.kind, target, reorderPoint, batchSize are required' },
			{ status: 400 }
		);
	}
	const created: any = await StandingTarget.create({
		_id: generateId(),
		name, metric, target, reorderPoint, batchSize,
		spawnItemType: fields.spawnItemType, board: fields.board, notes: fields.notes,
		autoCommit: fields.autoCommit, spawnSizeClass: fields.spawnSizeClass, templateId: fields.templateId,
		createdBy: actor.trim()
	});
	await AuditLog.create({
		_id: generateId(), tableName: 'kanban_standing_targets', recordId: created._id,
		action: 'INSERT', newData: { name, metric, target, reorderPoint, batchSize },
		changedBy: actor.trim(), changedAt: new Date()
	});
	return json({ success: true, data: JSON.parse(JSON.stringify(created)) }, { status: 201 });
};
