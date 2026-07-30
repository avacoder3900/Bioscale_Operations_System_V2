import { fail, redirect, error } from '@sveltejs/kit';
import { connectDB, KanbanTask, KanbanProject, AuditLog, User } from '$lib/server/db';
import { generateId } from '$lib/server/db/utils.js';
import { requirePermission } from '$lib/server/permissions';
import { checkWipLimit } from '$lib/server/kanban/wip-limit';
import { transitionTask, createKanbanItem, TransitionError } from '$lib/server/kanban/transition';
import { closeSpike as closeSpikeService } from '$lib/server/kanban/process';
import { isKanbanStatus, SIZE_CLASSES, type KanbanSizeClass } from '$lib/shared/kanban-status';
import type { PageServerLoad, Actions } from './$types';

function mapTag(tag: string) {
	return { id: tag, name: tag, color: '#6b7280' };
}

export const load: PageServerLoad = async ({ locals, params }) => {
	if (!locals.user) redirect(302, '/login');
	requirePermission(locals.user, 'kanban:read');
	await connectDB();

	const task = await KanbanTask.findById(params.taskId).lean() as any;
	if (!task) error(404, 'Task not found');

	const projects = await KanbanProject.find().sort({ sortOrder: 1 }).lean();

	// Collect all unique tags across all tasks for "allTags"
	const allTagsRaw = await KanbanTask.distinct('tags');

	// Build activity log with usernames
	const userIds = [...new Set([
		...(task.comments ?? []).map((c: any) => c.createdBy?._id).filter(Boolean),
		...(task.activityLog ?? []).map((a: any) => a.createdBy).filter(Boolean)
	])];
	const usersMap = new Map<string, string>();
	if (userIds.length) {
		const users = await User.find({ _id: { $in: userIds } }, { _id: 1, username: 1 }).lean();
		for (const u of users as any[]) usersMap.set(u._id, u.username);
	}

	return {
		task: {
			id: task._id,
			title: task.title,
			description: task.description ?? null,
			status: task.status,
			sizeClass: task.sizeClass as KanbanSizeClass | undefined,
			projectId: task.project?._id ?? null,
			assignedTo: task.assignee?._id ?? null,
			dueDate: task.dueDate ?? null,
			waitingReason: task.waitingReason ?? null,
			waitingOn: task.waitingOn ?? null,
			blockedReason: task.blockedReason ?? null,
			createdAt: task.createdAt,
			updatedAt: task.updatedAt ?? null,
			completedDate: task.completedAt ?? (task.status === 'done' ? task.statusChangedAt : null) ?? null,
			statusChangedAt: task.statusChangedAt ?? null,
			source: task.source ?? null,
			assigneeName: task.assignee?.username ?? null,
			projectName: task.project?.name ?? null,
			projectColor: task.project?.color ?? null,
			tags: (task.tags ?? []).map(mapTag),
			// KB2-07: spikes + discovered-work provenance
			itemType: (task.itemType ?? 'deliverable') as string,
			board: (task.board ?? 'ops') as string,
			origin: (task.origin ?? 'planned') as string,
			spawnedFrom: (task.spawnedFrom ?? null) as string | null,
			spike: task.spike?.question
				? {
						question: task.spike.question as string,
						timebox: task.spike.timebox
							? { amount: task.spike.timebox.amount as number, unit: task.spike.timebox.unit as string }
							: null,
						outcome: (task.spike.outcome ?? null) as string | null
					}
				: null
		},
		comments: (task.comments ?? []).map((c: any) => ({
			id: c._id,
			content: c.content,
			createdAt: c.createdAt,
			userId: c.createdBy?._id ?? '',
			username: c.createdBy?.username ?? 'Unknown'
		})),
		projects: projects.map((p: any) => ({
			id: p._id, name: p.name, color: p.color, isActive: p.isActive, sortOrder: p.sortOrder
		})),
		allTags: (allTagsRaw as string[]).map(mapTag),
		taskTags: (task.tags ?? []).map(mapTag),
		activityLog: (task.activityLog ?? []).map((a: any) => ({
			id: a._id,
			action: a.action,
			details: a.details ?? null,
			createdAt: a.createdAt,
			userId: a.createdBy ?? '',
			username: usersMap.get(a.createdBy) ?? a.createdBy ?? 'System'
		}))
	};
};

export const actions: Actions = {
	update: async ({ request, locals, params }) => {
		if (!locals.user) redirect(302, '/login');
		requirePermission(locals.user, 'kanban:write');
		await connectDB();
		const fd = await request.formData();

		const title = fd.get('title') as string;
		if (!title?.trim()) return fail(400, { error: 'Title is required' });

		const projectId = fd.get('projectId') as string | null;
		const assignedTo = fd.get('assignedTo') as string | null;

		let project = null;
		if (projectId) {
			const p = await KanbanProject.findById(projectId).lean() as any;
			if (p) project = { _id: p._id, name: p.name, color: p.color };
		}

		let assignee = null;
		if (assignedTo) {
			const u = await User.findById(assignedTo).lean() as any;
			if (u) assignee = { _id: u._id, username: u.username };
		}

		const dueDate = fd.get('dueDate') as string | null;

		// If this update changes the assignee of a task already in WIP, check
		// the new assignee's WIP capacity.
		const existing = await KanbanTask.findById(params.taskId).select('status assignee').lean() as any;
		if (existing?.status === 'wip' && assignee && existing.assignee?._id !== assignee._id) {
			const check = await checkWipLimit(assignee._id, params.taskId);
			if (!check.ok) return fail(409, { wipLimitError: check });
		}

		const $set: any = {
			title: title.trim(),
			description: (fd.get('description') as string) || undefined,
			project,
			assignee,
			dueDate: dueDate ? new Date(dueDate) : null,
			waitingReason: (fd.get('waitingReason') as string) || null,
			waitingOn: (fd.get('waitingOn') as string) || null
		};
		// sizeClass is normally set at processing (KB2-03); accept it only if the form sends a valid value.
		const sizeClass = fd.get('sizeClass') as string | null;
		if (sizeClass && (SIZE_CLASSES as readonly string[]).includes(sizeClass)) $set.sizeClass = sizeClass;

		await KanbanTask.updateOne({ _id: params.taskId }, {
			$set,
			$push: {
				activityLog: {
					_id: generateId(), action: 'updated', details: { fields: 'task details' },
					createdAt: new Date(), createdBy: locals.user._id
				}
			}
		});

		return { success: true };
	},

	move: async ({ request, locals, params }) => {
		if (!locals.user) redirect(302, '/login');
		requirePermission(locals.user, 'kanban:write');
		await connectDB();
		const fd = await request.formData();
		const newStatus = fd.get('newStatus') as string;
		if (!newStatus) return fail(400, { error: 'Missing newStatus' });
		if (!isKanbanStatus(newStatus)) return fail(400, { error: `'${newStatus}' is not a valid status` });

		const reason = (fd.get('reason') as string | null) || (fd.get('waitingReason') as string | null) || undefined;
		const waitingOn = (fd.get('waitingOn') as string | null) || undefined;
		const waitingUntilRaw = fd.get('waitingUntil') as string | null;

		try {
			await transitionTask({
				taskId: params.taskId,
				to: newStatus,
				actor: { username: locals.user.username, via: 'ui' },
				reason,
				waitingOn,
				waitingUntil: waitingUntilRaw ? new Date(waitingUntilRaw) : undefined
			});
		} catch (e) {
			if (e instanceof TransitionError) {
				if (e.code === 'WIP_LIMIT_EXCEEDED') {
					return fail(409, { wipLimitError: e.details, error: e.message, code: e.code });
				}
				return fail(400, { error: e.message, code: e.code });
			}
			throw e;
		}

		return { success: true };
	},

	addComment: async ({ request, locals, params }) => {
		if (!locals.user) redirect(302, '/login');
		requirePermission(locals.user, 'kanban:write');
		await connectDB();
		const fd = await request.formData();
		const content = fd.get('content') as string;
		if (!content?.trim()) return fail(400, { error: 'Content is required' });

		await KanbanTask.updateOne({ _id: params.taskId }, {
			$push: {
				comments: {
					_id: generateId(),
					content: content.trim(),
					createdAt: new Date(),
					createdBy: { _id: locals.user._id, username: locals.user.username }
				}
			}
		});

		return { success: true };
	},

	addTag: async ({ request, locals, params }) => {
		if (!locals.user) redirect(302, '/login');
		requirePermission(locals.user, 'kanban:write');
		await connectDB();
		const fd = await request.formData();
		const tagId = fd.get('tagId') as string;
		if (!tagId) return fail(400, { error: 'Missing tagId' });

		await KanbanTask.updateOne({ _id: params.taskId }, { $addToSet: { tags: tagId } });
		return { success: true };
	},

	removeTag: async ({ request, locals, params }) => {
		if (!locals.user) redirect(302, '/login');
		requirePermission(locals.user, 'kanban:write');
		await connectDB();
		const fd = await request.formData();
		const tagId = fd.get('tagId') as string;
		if (!tagId) return fail(400, { error: 'Missing tagId' });

		await KanbanTask.updateOne({ _id: params.taskId }, { $pull: { tags: tagId } });
		return { success: true };
	},

	createTag: async ({ request, locals, params }) => {
		if (!locals.user) redirect(302, '/login');
		requirePermission(locals.user, 'kanban:write');
		await connectDB();
		const fd = await request.formData();
		const name = fd.get('name') as string;
		if (!name?.trim()) return fail(400, { error: 'Tag name is required' });

		// Tags are just strings — add to the task
		await KanbanTask.updateOne({ _id: params.taskId }, { $addToSet: { tags: name.trim() } });
		return { success: true };
	},

	/**
	 * KB2-07 — the stop-now test, "Yes" branch: the parent's outcome is
	 * achievable without this, so it is a NEW OPTION. Created 'captured',
	 * origin 'discovered', spawnedFrom set. 'ready' is never offered here —
	 * it goes through replenishment like everything else.
	 */
	discoverOption: async ({ request, locals, params }) => {
		if (!locals.user) redirect(302, '/login');
		requirePermission(locals.user, 'kanban:write');
		await connectDB();
		const fd = await request.formData();
		const title = fd.get('title')?.toString();
		if (!title?.trim()) return fail(400, { error: 'Title is required' });

		const parent = await KanbanTask.findById(params.taskId).lean() as any;
		if (!parent) return fail(404, { error: 'Task not found' });

		try {
			await createKanbanItem({
				title,
				description: fd.get('description')?.toString() || undefined,
				actor: { username: locals.user.username, via: 'ui' },
				board: parent.board ?? 'ops',
				project: parent.project ?? null,
				origin: 'discovered',
				spawnedFrom: params.taskId
			});
		} catch (e) {
			if (e instanceof TransitionError) return fail(400, { error: e.message, code: e.code });
			throw e;
		}
		return { success: true, discovered: true };
	},

	/**
	 * KB2-07 — the stop-now test, "No" branch: it was always inside the
	 * parent's boundary. Append as context; do NOT create an item.
	 */
	appendContext: async ({ request, locals, params }) => {
		if (!locals.user) redirect(302, '/login');
		requirePermission(locals.user, 'kanban:write');
		await connectDB();
		const fd = await request.formData();
		const text = fd.get('text')?.toString();
		if (!text?.trim()) return fail(400, { error: 'Text is required' });

		const task = await KanbanTask.findById(params.taskId).select('description').lean() as any;
		if (!task) return fail(404, { error: 'Task not found' });

		const now = new Date();
		const description = task.description
			? `${task.description}\n\n— ${text.trim()}`
			: text.trim();
		await KanbanTask.updateOne({ _id: params.taskId }, {
			$set: { description },
			$push: {
				activityLog: {
					_id: generateId(),
					action: 'context_appended',
					details: { text: text.trim(), via: 'ui' },
					createdAt: now,
					createdBy: locals.user.username
				}
			}
		});
		await AuditLog.create({
			_id: generateId(),
			tableName: 'kanban_tasks',
			recordId: params.taskId,
			action: 'UPDATE',
			newData: { contextAppended: text.trim(), via: 'ui' },
			changedBy: locals.user.username,
			changedAt: now
		});
		return { success: true };
	},

	/**
	 * KB2-07 — close a spike: record the outcome ("still unknown" is valid)
	 * and file the options it created as captured/discovered.
	 */
	closeSpike: async ({ request, locals, params }) => {
		if (!locals.user) redirect(302, '/login');
		requirePermission(locals.user, 'kanban:write');
		await connectDB();
		const fd = await request.formData();
		const outcome = fd.get('outcome')?.toString();
		const spawnOptions = fd
			.getAll('optionTitle')
			.map((v) => v.toString().trim())
			.filter(Boolean)
			.map((title) => ({ title }));

		try {
			await closeSpikeService({
				taskId: params.taskId,
				actorUsername: locals.user.username,
				via: 'ui',
				outcome: outcome ?? '',
				spawnOptions
			});
		} catch (e) {
			if (e instanceof TransitionError) return fail(400, { error: e.message, code: e.code });
			throw e;
		}
		return { success: true };
	},

	archive: async ({ locals, params }) => {
		if (!locals.user) redirect(302, '/login');
		requirePermission(locals.user, 'kanban:write');
		await connectDB();

		const task = await KanbanTask.findById(params.taskId).lean() as any;
		if (!task) return fail(404, { error: 'Task not found' });
		if (task.archived) return fail(400, { error: 'Task is already archived' });
		if (task.status !== 'done') return fail(400, { error: 'Only done tasks can be archived' });

		await KanbanTask.updateOne({ _id: params.taskId }, {
			$set: { archived: true, archivedAt: new Date() },
			$push: {
				activityLog: {
					_id: generateId(),
					action: 'archived',
					details: { fromStatus: task.status },
					createdAt: new Date(),
					createdBy: locals.user._id
				}
			}
		});

		await AuditLog.create({
			tableName: 'kanban_tasks',
			recordId: params.taskId,
			action: 'UPDATE',
			oldData: { archived: false },
			newData: { archived: true },
			changedBy: locals.user.username ?? locals.user._id
		});

		return { success: true };
	}
};

export const config = { maxDuration: 60 };
