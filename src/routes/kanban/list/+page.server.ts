import { redirect } from '@sveltejs/kit';
import { connectDB, KanbanTask } from '$lib/server/db';
import { requirePermission } from '$lib/server/permissions';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, url }) => {
	if (!locals.user) redirect(302, '/login');
	requirePermission(locals.user, 'kanban:read');
	await connectDB();

	const project = url.searchParams.get('project');
	const status = url.searchParams.get('status');
	const assignee = url.searchParams.get('assignee');
	const source = url.searchParams.get('source');

	const filter: any = { archived: false };
	if (project) filter['project._id'] = project;
	if (status) filter.status = status;
	if (assignee) filter['assignee._id'] = assignee;
	if (source) filter.source = source;

	const tasks = await KanbanTask.find(filter).sort({ rank: 1 }).lean();

	return {
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
			createdAt: t.createdAt,
			statusChangedAt: t.statusChangedAt ?? null,
			assigneeName: t.assignee?.username ?? null,
			projectName: t.project?.name ?? null,
			projectColor: t.project?.color ?? null,
			tags: (t.tags ?? []).map((tag: string) => ({ id: tag, name: tag, color: '#6b7280' }))
		}))
	};
};

export const config = { maxDuration: 60 };
