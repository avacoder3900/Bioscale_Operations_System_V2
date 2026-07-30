import { fail, redirect } from '@sveltejs/kit';
import { connectDB, KanbanTask, KanbanProject, AuditLog } from '$lib/server/db';
import { requirePermission } from '$lib/server/permissions';
import { transitionTask, createKanbanItem, TransitionError } from '$lib/server/kanban/transition';
import { isKanbanStatus } from '$lib/shared/kanban-status';
import type { PageServerLoad, Actions } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	if (!locals.user) redirect(302, '/login');
	requirePermission(locals.user, 'kanban:read');
	await connectDB();

	const tasks = await KanbanTask.find({ archived: false }).sort({ rank: 1 }).lean();

	return {
		currentUserId: locals.user._id as string,
		tasks: tasks.map((t: any) => ({
			id: t._id,
			title: t.title,
			description: t.description ?? null,
			status: t.status,
			sizeClass: t.sizeClass ?? null,
			rank: t.rank ?? 0,
			projectId: t.project?._id ?? null,
			assignedTo: t.assignee?._id ?? null,
			dueDate: t.dueDate ?? null,
			waitingReason: t.waitingReason ?? null,
			waitingOn: t.waitingOn ?? null,
			blockedReason: t.blockedReason ?? null,
			createdAt: t.createdAt,
			statusChangedAt: t.statusChangedAt ?? null,
			source: t.source ?? null,
			assigneeName: t.assignee?.username ?? null,
			projectName: t.project?.name ?? null,
			projectColor: t.project?.color ?? null,
			tags: (t.tags ?? []).map((tag: string) => ({ id: tag, name: tag, color: '#6b7280' })),
			daysInStatus: t.statusChangedAt
				? Math.floor((Date.now() - new Date(t.statusChangedAt).getTime()) / 86400000)
				: 0
		}))
	};
};

export const actions: Actions = {
	create: async ({ request, locals }) => {
		if (!locals.user) redirect(302, '/login');
		requirePermission(locals.user, 'kanban:write');
		await connectDB();
		const fd = await request.formData();
		const title = fd.get('title') as string;
		if (!title?.trim()) return fail(400, { error: 'Title is required' });

		const projectId = fd.get('projectId') as string | null;
		const assignedTo = fd.get('assignedTo') as string | null;
		const dueDate = fd.get('dueDate') as string | null;
		const description = fd.get('description') as string | null;

		let project = null;
		if (projectId) {
			const p = await KanbanProject.findById(projectId).lean() as any;
			if (p) project = { _id: p._id, name: p.name, color: p.color };
		}

		let assignee = null;
		if (assignedTo) {
			const { User } = await import('$lib/server/db');
			const u = await User.findById(assignedTo).lean() as any;
			if (u) assignee = { _id: u._id, username: u.username };
		}

		try {
			await createKanbanItem({
				title,
				description: description || undefined,
				project,
				assignee,
				dueDate: dueDate ? new Date(dueDate) : undefined,
				actor: { username: locals.user.username, via: 'ui' }
			});
		} catch (e) {
			if (e instanceof TransitionError) return fail(400, { error: e.message, code: e.code });
			throw e;
		}

		return { success: true };
	},

	move: async ({ request, locals }) => {
		if (!locals.user) redirect(302, '/login');
		requirePermission(locals.user, 'kanban:write');
		await connectDB();
		const fd = await request.formData();
		const taskId = fd.get('taskId') as string;
		const newStatus = fd.get('newStatus') as string;
		if (!taskId || !newStatus) return fail(400, { error: 'Missing taskId or newStatus' });
		if (!isKanbanStatus(newStatus)) return fail(400, { error: `'${newStatus}' is not a valid status` });

		const reason = (fd.get('reason') as string | null) || (fd.get('waitingReason') as string | null) || undefined;
		const waitingOn = (fd.get('waitingOn') as string | null) || undefined;
		const waitingUntilRaw = fd.get('waitingUntil') as string | null;

		try {
			await transitionTask({
				taskId,
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

	delete: async ({ request, locals }) => {
		if (!locals.user) redirect(302, '/login');
		requirePermission(locals.user, 'kanban:write');
		await connectDB();
		const fd = await request.formData();
		const taskId = fd.get('taskId') as string;
		if (!taskId) return fail(400, { error: 'Missing taskId' });

		const task = await KanbanTask.findById(taskId).lean() as any;
		if (!task) return fail(400, { error: 'Task not found' });

		await KanbanTask.deleteOne({ _id: taskId });

		await AuditLog.create({
			tableName: 'kanban_tasks',
			recordId: taskId,
			action: 'DELETE',
			oldData: { title: task.title, status: task.status },
			changedBy: locals.user.username ?? locals.user._id
		});

		return { success: true };
	}
};

export const config = { maxDuration: 60 };
