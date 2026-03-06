import { fail, redirect, error } from '@sveltejs/kit';
import { connectDB, KanbanTask, KanbanProject, AuditLog, User } from '$lib/server/db';
import { generateId } from '$lib/server/db/utils.js';
import type { PageServerLoad, Actions } from './$types';

function mapTag(tag: string) {
	return { id: tag, name: tag, color: '#6b7280' };
}

export const load: PageServerLoad = async ({ locals, params }) => {
	if (!locals.user) redirect(302, '/login');
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
			priority: task.priority,
			taskLength: task.taskLength as 'short' | 'medium' | 'long' | undefined,
			projectId: task.project?._id ?? null,
			assignedTo: task.assignee?._id ?? null,
			dueDate: task.dueDate ?? null,
			sortOrder: task.sortOrder ?? 0,
			waitingReason: task.waitingReason ?? null,
			waitingOn: task.waitingOn ?? null,
			createdAt: task.createdAt,
			updatedAt: task.updatedAt ?? null,
			completedDate: task.completedAt ?? (task.status === 'done' ? task.statusChangedAt : null) ?? null,
			statusChangedAt: task.statusChangedAt ?? null,
			source: task.source ?? null,
			assigneeName: task.assignee?.username ?? null,
			projectName: task.project?.name ?? null,
			projectColor: task.project?.color ?? null,
			tags: (task.tags ?? []).map(mapTag)
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

		await KanbanTask.updateOne({ _id: params.taskId }, {
			$set: {
				title: title.trim(),
				description: (fd.get('description') as string) || undefined,
				priority: fd.get('priority') || 'medium',
				taskLength: fd.get('taskLength') || 'medium',
				project,
				assignee,
				dueDate: dueDate ? new Date(dueDate) : null,
				waitingReason: (fd.get('waitingReason') as string) || null,
				waitingOn: (fd.get('waitingOn') as string) || null
			},
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
		await connectDB();
		const fd = await request.formData();
		const newStatus = fd.get('newStatus') as string;
		if (!newStatus) return fail(400, { error: 'Missing newStatus' });

		const task = await KanbanTask.findById(params.taskId).lean() as any;
		if (!task) return fail(400, { error: 'Task not found' });

		await KanbanTask.updateOne({ _id: params.taskId }, {
			$set: { status: newStatus, statusChangedAt: new Date() },
			$push: {
				activityLog: {
					_id: generateId(), action: 'status_change',
					details: { from: task.status, to: newStatus },
					createdAt: new Date(), createdBy: locals.user._id
				}
			}
		});

		return { success: true };
	},

	addComment: async ({ request, locals, params }) => {
		if (!locals.user) redirect(302, '/login');
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
		await connectDB();
		const fd = await request.formData();
		const tagId = fd.get('tagId') as string;
		if (!tagId) return fail(400, { error: 'Missing tagId' });

		await KanbanTask.updateOne({ _id: params.taskId }, { $addToSet: { tags: tagId } });
		return { success: true };
	},

	removeTag: async ({ request, locals, params }) => {
		if (!locals.user) redirect(302, '/login');
		await connectDB();
		const fd = await request.formData();
		const tagId = fd.get('tagId') as string;
		if (!tagId) return fail(400, { error: 'Missing tagId' });

		await KanbanTask.updateOne({ _id: params.taskId }, { $pull: { tags: tagId } });
		return { success: true };
	},

	createTag: async ({ request, locals, params }) => {
		if (!locals.user) redirect(302, '/login');
		await connectDB();
		const fd = await request.formData();
		const name = fd.get('name') as string;
		if (!name?.trim()) return fail(400, { error: 'Tag name is required' });

		// Tags are just strings — add to the task
		await KanbanTask.updateOne({ _id: params.taskId }, { $addToSet: { tags: name.trim() } });
		return { success: true };
	}
};
