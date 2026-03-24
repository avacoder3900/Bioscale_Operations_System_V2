import { fail, redirect } from '@sveltejs/kit';
import { connectDB, KanbanTask, KanbanProject, AuditLog } from '$lib/server/db';
import { generateId } from '$lib/server/db/utils.js';
import { requirePermission } from '$lib/server/permissions';
import type { PageServerLoad, Actions } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	if (!locals.user) redirect(302, '/login');
	requirePermission(locals.user, 'kanban:read');
	await connectDB();

	const tasks = await KanbanTask.find({ archived: false }).sort({ sortOrder: 1 }).lean();

	return {
		currentUserId: locals.user._id as string,
		tasks: tasks.map((t: any) => ({
			id: t._id,
			title: t.title,
			description: t.description ?? null,
			status: t.status,
			prioritized: t.prioritized ?? false,
			taskLength: t.taskLength,
			projectId: t.project?._id ?? null,
			assignedTo: t.assignee?._id ?? null,
			dueDate: t.dueDate ?? null,
			sortOrder: t.sortOrder ?? 0,
			waitingReason: t.waitingReason ?? null,
			waitingOn: t.waitingOn ?? null,
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

		const status = (fd.get('status') as string) || 'backlog';
		const prioritized = fd.get('prioritized') === 'true';
		const taskLength = (fd.get('taskLength') as string) || 'medium';
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

		const taskId = generateId();
		await KanbanTask.create({
			_id: taskId,
			title: title.trim(),
			description: description || undefined,
			status,
			prioritized,
			taskLength,
			project,
			assignee,
			dueDate: dueDate ? new Date(dueDate) : undefined,
			statusChangedAt: new Date(),
			createdBy: locals.user._id
		});

		await AuditLog.create({
			tableName: 'kanban_tasks',
			recordId: taskId,
			action: 'INSERT',
			newData: { title: title.trim(), status },
			changedBy: locals.user.username ?? locals.user._id
		});

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

		const sortOrder = fd.get('sortOrder') ? Number(fd.get('sortOrder')) : undefined;
		const waitingReason = fd.get('waitingReason') as string | null;
		const waitingOn = fd.get('waitingOn') as string | null;

		const task = await KanbanTask.findById(taskId) as any;
		if (!task) return fail(400, { error: 'Task not found' });

		const oldStatus = task.status;
		const update: any = {
			status: newStatus,
			statusChangedAt: new Date()
		};
		if (sortOrder !== undefined) update.sortOrder = sortOrder;
		if (newStatus === 'waiting') {
			update.waitingReason = waitingReason || null;
			update.waitingOn = waitingOn || null;
		}

		await KanbanTask.updateOne({ _id: taskId }, {
			$set: update,
			$push: {
				activityLog: {
					_id: generateId(),
					action: 'status_change',
					details: { from: oldStatus, to: newStatus },
					createdAt: new Date(),
					createdBy: locals.user.username ?? locals.user._id
				}
			}
		});

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
