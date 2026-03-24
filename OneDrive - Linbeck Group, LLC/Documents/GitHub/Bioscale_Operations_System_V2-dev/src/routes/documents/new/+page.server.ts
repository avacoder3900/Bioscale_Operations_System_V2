import { fail, redirect } from '@sveltejs/kit';
import { requirePermission } from '$lib/server/permissions';
import { connectDB, Document, AuditLog, generateId } from '$lib/server/db';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	requirePermission(locals.user, 'document:write');
	return {};
};

export const actions: Actions = {
	default: async ({ request, locals }) => {
		requirePermission(locals.user, 'document:write');
		await connectDB();
		const form = await request.formData();
		const documentNumber = form.get('documentNumber')?.toString().trim();
		const title = form.get('title')?.toString().trim();
		const category = form.get('category')?.toString().trim() || undefined;
		const content = form.get('content')?.toString() ?? '';

		if (!documentNumber || !title) {
			return fail(400, { error: 'Document number and title are required', documentNumber, title, category, content });
		}

		const existing = await Document.findOne({ documentNumber });
		if (existing) {
			return fail(400, { error: 'Document number already exists', documentNumber, title, category, content });
		}

		const docId = generateId();
		const revisionId = generateId();
		const now = new Date();

		await Document.create({
			_id: docId,
			documentNumber,
			title,
			category,
			currentRevision: '1',
			status: 'draft',
			ownerId: locals.user?._id,
			createdBy: locals.user?._id,
			revisions: [{
				_id: revisionId,
				revision: '1',
				content,
				status: 'draft',
				createdAt: now,
				createdBy: locals.user?._id,
				trainingRecords: []
			}]
		});

		await AuditLog.create({
			_id: generateId(), tableName: 'documents', recordId: docId,
			action: 'INSERT', newData: { documentNumber, title, category },
			changedAt: now, changedBy: locals.user?.username ?? 'system'
		});

		redirect(303, `/documents/${docId}`);
	}
};
