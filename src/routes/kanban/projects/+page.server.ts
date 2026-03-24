import { fail, redirect } from '@sveltejs/kit';
import { connectDB, KanbanProject, AuditLog } from '$lib/server/db';
import { generateId } from '$lib/server/db/utils.js';
import { requirePermission } from '$lib/server/permissions';
import type { PageServerLoad, Actions } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	if (!locals.user) redirect(302, '/login');
	requirePermission(locals.user, 'kanban:read');
	await connectDB();

	const projects = await KanbanProject.find().sort({ sortOrder: 1 }).lean();

	return {
		allProjects: projects.map((p: any) => ({
			id: p._id,
			name: p.name,
			description: p.description ?? null,
			color: p.color,
			isActive: p.isActive,
			sortOrder: p.sortOrder,
			createdBy: p.createdBy ?? null
		}))
	};
};

export const actions: Actions = {
	create: async ({ request, locals }) => {
		if (!locals.user) redirect(302, '/login');
		requirePermission(locals.user, 'kanban:write');
		await connectDB();
		const fd = await request.formData();
		const name = fd.get('name') as string;
		if (!name?.trim()) return fail(400, { error: 'Name is required' });

		const description = fd.get('description') as string | null;
		const color = (fd.get('color') as string) || '#3b82f6';

		const maxSort = await KanbanProject.findOne().sort({ sortOrder: -1 }).lean() as any;
		const sortOrder = (maxSort?.sortOrder ?? 0) + 1;

		const projectId = generateId();
		await KanbanProject.create({
			_id: projectId,
			name: name.trim(),
			description: description || undefined,
			color,
			sortOrder,
			createdBy: locals.user._id
		});

		await AuditLog.create({
			tableName: 'kanban_projects', recordId: projectId, action: 'INSERT',
			newData: { name: name.trim() }, changedBy: locals.user.username ?? locals.user._id
		});

		return { success: true };
	},

	update: async ({ request, locals }) => {
		if (!locals.user) redirect(302, '/login');
		requirePermission(locals.user, 'kanban:write');
		await connectDB();
		const fd = await request.formData();
		const projectId = fd.get('projectId') as string;
		if (!projectId) return fail(400, { error: 'Missing projectId' });

		const name = fd.get('name') as string;
		if (!name?.trim()) return fail(400, { error: 'Name is required' });

		const description = fd.get('description') as string | null;
		const color = fd.get('color') as string | null;

		const update: any = { name: name.trim() };
		if (description !== null) update.description = description || undefined;
		if (color) update.color = color;

		await KanbanProject.updateOne({ _id: projectId }, { $set: update });

		// Also update denormalized project data in tasks
		await (await import('$lib/server/db')).KanbanTask.updateMany(
			{ 'project._id': projectId },
			{ $set: { 'project.name': name.trim(), ...(color ? { 'project.color': color } : {}) } }
		);

		return { success: true };
	},

	toggleActive: async ({ request, locals }) => {
		if (!locals.user) redirect(302, '/login');
		requirePermission(locals.user, 'kanban:write');
		await connectDB();
		const fd = await request.formData();
		const projectId = fd.get('projectId') as string;
		if (!projectId) return fail(400, { error: 'Missing projectId' });

		const project = await KanbanProject.findById(projectId) as any;
		if (!project) return fail(400, { error: 'Project not found' });

		await KanbanProject.updateOne({ _id: projectId }, { $set: { isActive: !project.isActive } });
		return { success: true };
	}
};

export const config = { maxDuration: 60 };
