import { json } from '@sveltejs/kit';
import { requireAgentApiKey } from '$lib/server/api-auth';
import { connectDB, KanbanTemplate, User, AuditLog, generateId } from '$lib/server/db';
import { hasPermission, isAdmin } from '$lib/server/permissions';
import type { RequestHandler } from './$types';

/** KB2-11: workflow templates. GET = list; POST = create/update (kanban:admin). */
export const GET: RequestHandler = async ({ request, url }) => {
	requireAgentApiKey(request);
	await connectDB();
	const filter: any = url.searchParams.get('includeInactive') === '1' ? {} : { active: true };
	const templates = await KanbanTemplate.find(filter).sort({ name: 1 }).lean();
	return json({ success: true, data: { templates: JSON.parse(JSON.stringify(templates)) } });
};

export const POST: RequestHandler = async ({ request }) => {
	requireAgentApiKey(request);
	await connectDB();
	const body = await request.json();
	const { templateId, actor, ...fields } = body;

	if (!actor?.trim()) return json({ success: false, error: 'actor (username) is required' }, { status: 400 });
	const user: any = await User.findOne({ username: actor.trim().toLowerCase() }).select('username isActive roles').lean();
	if (!user || user.isActive === false) return json({ success: false, error: `Actor '${actor}' is not an active BIMS user.` }, { status: 401 });
	if (!hasPermission(user, 'kanban:admin') && !isAdmin(user)) {
		return json({ success: false, error: `${user.username} does not hold kanban:admin.` }, { status: 403 });
	}

	const allowed = ['name', 'board', 'active', 'itemType', 'sizeClass', 'classOfService', 'titleTemplate', 'dor', 'tags', 'defaultProjectId', 'notes'];
	const $set: Record<string, unknown> = {};
	for (const k of allowed) if (fields[k] !== undefined) $set[k] = fields[k];

	let doc: any;
	if (templateId) {
		doc = await KanbanTemplate.findByIdAndUpdate(templateId, { $set }, { new: true }).lean();
		if (!doc) return json({ success: false, error: 'Template not found' }, { status: 404 });
	} else {
		if (!$set.name || !$set.titleTemplate || !$set.sizeClass || !($set as any).dor?.deliverable) {
			return json({ success: false, error: 'name, titleTemplate, sizeClass, dor.deliverable are required' }, { status: 400 });
		}
		doc = (await KanbanTemplate.create({ _id: generateId(), ...$set, createdBy: user.username })).toObject();
	}
	await AuditLog.create({
		_id: generateId(), tableName: 'kanban_templates', recordId: doc._id,
		action: templateId ? 'UPDATE' : 'INSERT', newData: $set, changedBy: user.username, changedAt: new Date()
	});
	return json({ success: true, data: JSON.parse(JSON.stringify(doc)) }, { status: templateId ? 200 : 201 });
};
