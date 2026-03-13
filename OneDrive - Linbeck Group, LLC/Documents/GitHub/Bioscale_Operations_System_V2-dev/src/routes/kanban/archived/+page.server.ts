import { fail, redirect } from '@sveltejs/kit';
import { connectDB, KanbanTask, AuditLog } from '$lib/server/db';
import type { PageServerLoad, Actions } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	if (!locals.user) redirect(302, '/login');
	await connectDB();

	const tasks = await KanbanTask.find({ archived: true }).sort({ archivedAt: -1 }).lean();

	return {
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
			waitingReason: t.waitingReason ?? null,
			waitingOn: t.waitingOn ?? null,
			createdAt: t.createdAt,
			statusChangedAt: t.statusChangedAt ?? null,
			archivedAt: t.archivedAt ?? null,
			assigneeName: t.assignee?.username ?? null,
			projectName: t.project?.name ?? null,
			projectColor: t.project?.color ?? null,
			tags: (t.tags ?? []).map((tag: string) => ({ id: tag, name: tag, color: '#6b7280' }))
		}))
	};
};

export const actions: Actions = {
	archiveDone: async ({ locals }) => {
		if (!locals.user) redirect(302, '/login');
		await connectDB();

		const result = await KanbanTask.updateMany(
			{ status: 'done', archived: false },
			{ $set: { archived: true, archivedAt: new Date() } }
		);

		await AuditLog.create({
			tableName: 'kanban_tasks', recordId: 'bulk',
			action: 'UPDATE', newData: { archived: true, count: result.modifiedCount },
			changedBy: locals.user.username ?? locals.user._id
		});

		return { success: true, count: result.modifiedCount };
	}
};
