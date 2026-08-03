/**
 * KB2-06 — Inventory: the Tier 1 management view. Options grouped by project,
 * ordered by rank; processing (KB2-03), rank moves, icebox/decline/thaw, DoR
 * edits. Everything that changes status goes through the kanban services.
 */
import { fail, redirect } from '@sveltejs/kit';
import { connectDB, KanbanTask, KanbanProject, KanbanTemplate, AuditLog, generateId } from '$lib/server/db';
import { requirePermission } from '$lib/server/permissions';
import { createKanbanItem, TransitionError } from '$lib/server/kanban/transition';
import {
	processTask,
	reshapeTask,
	captureFromTemplate,
	iceboxTask,
	declineTask,
	thawTask,
	SIZING_DECISION_TEST
} from '$lib/server/kanban/process';
import { reorder, dorMissingFields, ReplenishError } from '$lib/server/kanban/replenish';
import { getKanbanPolicy } from '$lib/server/kanban/policy';
import {
	SIZE_CLASSES,
	CLASSES_OF_SERVICE,
	type KanbanBoard,
	type KanbanSizeClass,
	type KanbanClassOfService
} from '$lib/shared/kanban-status';
import type { PageServerLoad, Actions } from './$types';

function boardOf(url: URL): KanbanBoard {
	return url.searchParams.get('board') === 'software' ? 'software' : 'ops';
}

export const load: PageServerLoad = async ({ locals, url }) => {
	if (!locals.user) redirect(302, '/login');
	requirePermission(locals.user, 'kanban:read');
	await connectDB();
	const board = boardOf(url);

	const policy = await getKanbanPolicy();
	const tasks = (await KanbanTask.find({
		board,
		status: { $in: ['captured', 'processed', 'icebox', 'declined'] },
		archived: false
	})
		.sort({ rank: 1 })
		.lean()) as any[];

	// KB2-11 — active workflow templates for this board (one-touch capture).
	const templates = (await KanbanTemplate.find({ active: true, board }).sort({ name: 1 }).lean()) as any[];

	return {
		board,
		// KB2-12 — canonical sizing decision test, shown in the process modal.
		sizingDecisionTest: SIZING_DECISION_TEST,
		templates: JSON.parse(
			JSON.stringify(
				templates.map((t) => ({
					id: t._id,
					name: t.name,
					titleTemplate: t.titleTemplate,
					sizeClass: t.sizeClass,
					classOfService: t.classOfService,
					defaultProjectId: t.defaultProjectId ?? null
				}))
			)
		),
		sizeClassDefinitions: {
			short: policy?.sizeClassDefinitions?.short ?? '',
			medium: policy?.sizeClassDefinitions?.medium ?? '',
			long: policy?.sizeClassDefinitions?.long ?? ''
		},
		tasks: JSON.parse(
			JSON.stringify(
				tasks.map((t) => ({
					id: t._id,
					title: t.title,
					description: t.description ?? null,
					status: t.status,
					rank: t.rank ?? 0,
					itemType: t.itemType ?? 'deliverable',
					classOfService: t.classOfService ?? null,
					sizeClass: t.sizeClass ?? null,
					origin: t.origin ?? 'planned',
					projectId: t.project?._id ?? null,
					projectName: t.project?.name ?? null,
					projectColor: t.project?.color ?? null,
					dueDate: t.dueDate ?? null,
					declineReason: t.declineReason ?? null,
					spawnedFrom: t.spawnedFrom ?? null,
					dor: {
						deliverable: t.dor?.deliverable ?? '',
						handoffBrief: t.dor?.handoffBrief ?? ''
					},
					spike: t.spike?.question ? { question: t.spike.question, outcome: t.spike.outcome ?? null } : null,
					dorMissing: dorMissingFields(t)
				}))
			)
		)
	};
};

function serviceFail(e: unknown) {
	if (e instanceof TransitionError) return fail(400, { error: e.message, code: e.code });
	if (e instanceof ReplenishError) {
		return fail(e.code === 'PERMISSION_DENIED' ? 403 : 400, { error: e.message, code: e.code });
	}
	throw e;
}

export const actions: Actions = {
	// Capture box: one line → 'captured'.
	capture: async ({ request, locals, url }) => {
		if (!locals.user) redirect(302, '/login');
		requirePermission(locals.user, 'kanban:write');
		await connectDB();
		const fd = await request.formData();
		const title = fd.get('title')?.toString();
		if (!title?.trim()) return fail(400, { error: 'Title is required' });

		const projectId = fd.get('projectId')?.toString();
		let project = null;
		if (projectId) {
			const p = (await KanbanProject.findById(projectId).lean()) as any;
			if (p) project = { _id: p._id, name: p.name, color: p.color };
		}

		try {
			await createKanbanItem({
				title,
				project,
				board: boardOf(url),
				actor: { username: locals.user.username, via: 'ui' }
			});
		} catch (e) {
			return serviceFail(e);
		}
		return { success: true };
	},

	// KB2-03 processing: size class + class of service set by the person processing.
	process: async ({ request, locals }) => {
		if (!locals.user) redirect(302, '/login');
		requirePermission(locals.user, 'kanban:write');
		await connectDB();
		const fd = await request.formData();
		const taskId = fd.get('taskId')?.toString();
		const sizeClass = fd.get('sizeClass')?.toString();
		const classOfService = fd.get('classOfService')?.toString();
		if (!taskId) return fail(400, { error: 'Missing taskId' });
		if (!sizeClass || !(SIZE_CLASSES as readonly string[]).includes(sizeClass)) {
			return fail(400, { error: 'A valid size class is required' });
		}
		if (!classOfService || !(CLASSES_OF_SERVICE as readonly string[]).includes(classOfService)) {
			return fail(400, { error: 'A valid class of service is required' });
		}
		const dueDateRaw = fd.get('dueDate')?.toString();

		try {
			await processTask({
				taskId,
				actorUsername: locals.user.username,
				via: 'ui',
				sizeClass: sizeClass as KanbanSizeClass,
				classOfService: classOfService as KanbanClassOfService,
				dueDate: dueDateRaw ? new Date(dueDateRaw) : undefined,
				dor: {
					deliverable: fd.get('deliverable')?.toString() || undefined,
					handoffBrief: fd.get('handoffBrief')?.toString() || undefined
				}
			});
		} catch (e) {
			return serviceFail(e);
		}
		return { success: true };
	},

	// KB2-12 — reshape an already-processed item from the same unified modal:
	// edit size/class/DoR in place, audited, no status change.
	reshape: async ({ request, locals }) => {
		if (!locals.user) redirect(302, '/login');
		requirePermission(locals.user, 'kanban:write');
		await connectDB();
		const fd = await request.formData();
		const taskId = fd.get('taskId')?.toString();
		const sizeClass = fd.get('sizeClass')?.toString();
		const classOfService = fd.get('classOfService')?.toString();
		if (!taskId) return fail(400, { error: 'Missing taskId' });
		if (sizeClass && !(SIZE_CLASSES as readonly string[]).includes(sizeClass)) {
			return fail(400, { error: 'A valid size class is required' });
		}
		if (classOfService && !(CLASSES_OF_SERVICE as readonly string[]).includes(classOfService)) {
			return fail(400, { error: 'A valid class of service is required' });
		}
		const dueDateRaw = fd.get('dueDate')?.toString();

		try {
			await reshapeTask({
				taskId,
				actorUsername: locals.user.username,
				via: 'ui',
				sizeClass: sizeClass ? (sizeClass as KanbanSizeClass) : undefined,
				classOfService: classOfService ? (classOfService as KanbanClassOfService) : undefined,
				dueDate: dueDateRaw ? new Date(dueDateRaw) : undefined,
				dor: {
					deliverable: fd.get('deliverable')?.toString(),
					handoffBrief: fd.get('handoffBrief')?.toString()
				}
			});
		} catch (e) {
			return serviceFail(e);
		}
		return { success: true };
	},

	// KB2-11 — capture from a workflow template: created AND processed in one
	// motion, landing DoR-complete and immediately replenishable.
	captureFromTemplate: async ({ request, locals }) => {
		if (!locals.user) redirect(302, '/login');
		requirePermission(locals.user, 'kanban:write');
		await connectDB();
		const fd = await request.formData();
		const templateId = fd.get('templateId')?.toString();
		if (!templateId) return fail(400, { error: 'Pick a template first' });

		const projectId = fd.get('projectId')?.toString();
		let project = null;
		if (projectId) {
			const p = (await KanbanProject.findById(projectId).lean()) as any;
			if (p) project = { _id: p._id, name: p.name, color: p.color };
		}
		const dueDateRaw = fd.get('dueDate')?.toString();

		try {
			const result = await captureFromTemplate({
				templateId,
				actorUsername: locals.user.username,
				via: 'ui',
				title: fd.get('title')?.toString() || undefined,
				project,
				dueDate: dueDateRaw ? new Date(dueDateRaw) : undefined
			});
			return { success: true, capturedFromTemplate: result.title };
		} catch (e) {
			return serviceFail(e);
		}
	},

	// Rank ▲▼ — one position within the (board, project) Tier 1 scope, via reorder().
	rankMove: async ({ request, locals }) => {
		if (!locals.user) redirect(302, '/login');
		requirePermission(locals.user, 'kanban:write');
		await connectDB();
		const fd = await request.formData();
		const taskId = fd.get('taskId')?.toString();
		const direction = fd.get('direction')?.toString();
		if (!taskId || (direction !== 'up' && direction !== 'down')) {
			return fail(400, { error: 'Missing taskId or direction' });
		}

		const task = (await KanbanTask.findById(taskId).select('board project status').lean()) as any;
		if (!task) return fail(404, { error: 'Task not found' });
		const projectId = task.project?._id;
		if (!projectId) {
			return fail(400, { error: 'Rank moves need a project scope — assign this option to a project first.' });
		}

		const scope = (await KanbanTask.find({
			board: task.board ?? 'ops',
			'project._id': projectId,
			status: { $in: ['captured', 'processed'] },
			archived: false
		})
			.sort({ rank: 1 })
			.select('_id')
			.lean()) as any[];
		const ids = scope.map((t) => String(t._id));
		const i = ids.indexOf(taskId);
		if (i === -1) return fail(400, { error: 'Only captured/processed options can be ranked.' });
		const j = direction === 'up' ? i - 1 : i + 1;
		if (j < 0 || j >= ids.length) return { success: true }; // already at the edge
		[ids[i], ids[j]] = [ids[j], ids[i]];

		try {
			await reorder({
				board: (task.board ?? 'ops') as KanbanBoard,
				scope: { projectId },
				orderedTaskIds: ids,
				actorUsername: locals.user.username,
				via: 'ui'
			});
		} catch (e) {
			return serviceFail(e);
		}
		return { success: true };
	},

	icebox: async ({ request, locals }) => {
		if (!locals.user) redirect(302, '/login');
		requirePermission(locals.user, 'kanban:write');
		await connectDB();
		const fd = await request.formData();
		const taskId = fd.get('taskId')?.toString();
		if (!taskId) return fail(400, { error: 'Missing taskId' });
		try {
			await iceboxTask({ taskId, actorUsername: locals.user.username, via: 'ui', reason: fd.get('reason')?.toString() });
		} catch (e) {
			return serviceFail(e);
		}
		return { success: true };
	},

	decline: async ({ request, locals }) => {
		if (!locals.user) redirect(302, '/login');
		requirePermission(locals.user, 'kanban:write');
		await connectDB();
		const fd = await request.formData();
		const taskId = fd.get('taskId')?.toString();
		const reason = fd.get('reason')?.toString();
		if (!taskId) return fail(400, { error: 'Missing taskId' });
		try {
			await declineTask({ taskId, actorUsername: locals.user.username, via: 'ui', reason: reason ?? '' });
		} catch (e) {
			return serviceFail(e);
		}
		return { success: true };
	},

	thaw: async ({ request, locals }) => {
		if (!locals.user) redirect(302, '/login');
		requirePermission(locals.user, 'kanban:write');
		await connectDB();
		const fd = await request.formData();
		const taskId = fd.get('taskId')?.toString();
		if (!taskId) return fail(400, { error: 'Missing taskId' });
		try {
			await thawTask({ taskId, actorUsername: locals.user.username, via: 'ui' });
		} catch (e) {
			return serviceFail(e);
		}
		return { success: true };
	},

	// Plain DoR field update — no status change, but still audited.
	updateDor: async ({ request, locals }) => {
		if (!locals.user) redirect(302, '/login');
		requirePermission(locals.user, 'kanban:write');
		await connectDB();
		const fd = await request.formData();
		const taskId = fd.get('taskId')?.toString();
		if (!taskId) return fail(400, { error: 'Missing taskId' });
		const task = (await KanbanTask.findById(taskId).select('_id').lean()) as any;
		if (!task) return fail(404, { error: 'Task not found' });

		const dor = {
			deliverable: fd.get('deliverable')?.toString() ?? '',
			handoffBrief: fd.get('handoffBrief')?.toString() ?? ''
		};
		const now = new Date();
		await KanbanTask.updateOne(
			{ _id: taskId },
			{
				$set: { 'dor.deliverable': dor.deliverable, 'dor.handoffBrief': dor.handoffBrief },
				$push: {
					activityLog: {
						_id: generateId(),
						action: 'dor_updated',
						details: { via: 'ui' },
						createdAt: now,
						createdBy: locals.user.username
					}
				}
			}
		);
		await AuditLog.create({
			_id: generateId(),
			tableName: 'kanban_tasks',
			recordId: taskId,
			action: 'UPDATE',
			newData: { dor, via: 'ui' },
			changedBy: locals.user.username,
			changedAt: now
		});
		return { success: true };
	}
};

export const config = { maxDuration: 60 };
