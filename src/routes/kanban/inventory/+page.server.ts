/**
 * KB2-06 — Inventory: the Tier 1 management view. KB2-16: one flat list in
 * global rank order (projects are gone — tags carry the grouping); processing
 * (KB2-03), rank moves, icebox/decline/thaw, DoR edits. Everything that
 * changes status goes through the kanban services.
 *
 * KB2-14 — the commitment ceremony lives here too: staging checkboxes on
 * processed + DoR-complete rows feed a sticky commit bar → replenish().
 * The gate itself (actor permission, DoR, caps, one batch event) is the
 * unchanged KB2-02 service — moving the UI does not weaken it.
 */
import { fail, redirect } from '@sveltejs/kit';
import { connectDB, KanbanTask, KanbanTemplate, AuditLog, generateId } from '$lib/server/db';
import { requirePermission, hasPermission, isAdmin } from '$lib/server/permissions';
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
import { replenish, reorder, dorMissingFields, ReplenishError } from '$lib/server/kanban/replenish';
import { getKanbanPolicy, queuePolicyOf } from '$lib/server/kanban/policy';
import {
	SIZE_CLASSES,
	CLASSES_OF_SERVICE,
	type KanbanSizeClass,
	type KanbanClassOfService
} from '$lib/shared/kanban-status';
import type { PageServerLoad, Actions } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	if (!locals.user) redirect(302, '/login');
	requirePermission(locals.user, 'kanban:read');
	await connectDB();

	const policy = await getKanbanPolicy();
	const tasks = (await KanbanTask.find({
		status: { $in: ['captured', 'processed', 'icebox', 'declined'] },
		archived: false
	})
		.sort({ rank: 1, createdAt: 1 })
		.lean()) as any[];

	// KB2-11 — active workflow templates (one-touch capture).
	const templates = (await KanbanTemplate.find({ active: true }).sort({ name: 1 }).lean()) as any[];

	// KB2-14 — the Ready x/cap chip + commit bar need queue depth here.
	const { readyCap, minOrderPoint } = queuePolicyOf(policy);
	const readyCount = await KanbanTask.countDocuments({ status: 'ready', archived: false });

	// KB2-25 — the whole tag vocabulary, board-wide, so the capture box can
	// complete against tags that live on tasks this page never loads (ready/wip/
	// done/archived). `distinct` already de-dupes; we only sort for stable UI.
	const tagVocabulary = ((await KanbanTask.distinct('tags')) as string[])
		.filter((t) => typeof t === 'string' && t.trim().length > 0)
		.sort((a, b) => a.localeCompare(b));

	return {
		canReplenish: hasPermission(locals.user, 'kanban:replenish') || isAdmin(locals.user),
		ready: {
			count: readyCount,
			cap: readyCap,
			minOrderPoint,
			belowMinOrderPoint: readyCount < minOrderPoint
		},
		// KB2-12 — canonical sizing decision test, shown in the process modal.
		sizingDecisionTest: SIZING_DECISION_TEST,
		// KB2-25 — autocomplete source for the capture box.
		tagVocabulary,
		templates: JSON.parse(
			JSON.stringify(
				templates.map((t) => ({
					id: t._id,
					name: t.name,
					titleTemplate: t.titleTemplate,
					sizeClass: t.sizeClass,
					classOfService: t.classOfService,
					tags: t.tags ?? []
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
					tags: t.tags ?? [],
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
	// KB2-14 — the commitment ceremony: one replenishment event per commit,
	// selected candidates in staged order. The service re-validates everything
	// (actor holds kanban:replenish, DoR, caps) server-side.
	commit: async ({ request, locals }) => {
		if (!locals.user) redirect(302, '/login');
		requirePermission(locals.user, 'kanban:write');
		await connectDB();
		const fd = await request.formData();
		const taskIds = fd.getAll('taskIds').map((v) => v.toString()).filter(Boolean);
		if (!taskIds.length) return fail(400, { error: 'Select at least one candidate to commit.' });
		const note = fd.get('note')?.toString() || undefined;

		try {
			const result = await replenish({
				taskIds,
				actorUsername: locals.user.username,
				via: 'ui',
				note
			});
			return { replenishResult: JSON.parse(JSON.stringify(result)) };
		} catch (e) {
			return serviceFail(e);
		}
	},

	// Capture box: one line → 'captured'. Optional comma-separated tags.
	capture: async ({ request, locals }) => {
		if (!locals.user) redirect(302, '/login');
		requirePermission(locals.user, 'kanban:write');
		await connectDB();
		const fd = await request.formData();
		const title = fd.get('title')?.toString();
		if (!title?.trim()) return fail(400, { error: 'Title is required' });

		// KB2-25 — canonicalise before writing. Client autocomplete is a
		// convenience, not a guarantee: someone can still type "Firmware " when
		// "firmware" exists, or paste the same tag twice. Fold each entry onto an
		// existing tag when it matches case-insensitively so the vocabulary stays
		// closed instead of growing near-duplicates.
		const existingByKey = new Map(
			((await KanbanTask.distinct('tags')) as string[])
				.filter((t) => typeof t === 'string' && t.trim().length > 0)
				.map((t) => [t.trim().toLowerCase(), t.trim()])
		);
		const seen = new Set<string>();
		const tags: string[] = [];
		for (const raw of (fd.get('tags')?.toString() ?? '').split(',')) {
			const trimmed = raw.trim().replace(/\s+/g, ' ');
			if (!trimmed) continue;
			const key = trimmed.toLowerCase();
			if (seen.has(key)) continue;
			seen.add(key);
			tags.push(existingByKey.get(key) ?? trimmed);
		}

		// Optional at capture — whatever is written here pre-fills the Process modal.
		const deliverable = fd.get('deliverable')?.toString().trim() || undefined;

		try {
			await createKanbanItem({
				title,
				tags,
				dor: deliverable ? { deliverable } : undefined,
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

		const dueDateRaw = fd.get('dueDate')?.toString();

		try {
			const result = await captureFromTemplate({
				templateId,
				actorUsername: locals.user.username,
				via: 'ui',
				title: fd.get('title')?.toString() || undefined,
				dueDate: dueDateRaw ? new Date(dueDateRaw) : undefined
			});
			return { success: true, capturedFromTemplate: result.title };
		} catch (e) {
			return serviceFail(e);
		}
	},

	// Rank ▲▼ — one position within the global Tier 1 order (KB2-16), via reorder().
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

		const scope = (await KanbanTask.find({
			status: { $in: ['captured', 'processed'] },
			archived: false
		})
			.sort({ rank: 1, createdAt: 1 })
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
				scope: 'tier1',
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
