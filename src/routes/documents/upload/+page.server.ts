import { fail, redirect } from '@sveltejs/kit';
import { requirePermission } from '$lib/server/permissions';
import { connectDB, DocumentRepository, AuditLog, generateId } from '$lib/server/db';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	requirePermission(locals.user, 'documentRepo:write');
	return {};
};

export const actions: Actions = {
	default: async ({ request, locals }) => {
		requirePermission(locals.user, 'documentRepo:write');
		await connectDB();
		const form = await request.formData();
		const file = form.get('file') as File | null;
		const title = form.get('title')?.toString().trim() || undefined;
		const category = form.get('category')?.toString().trim() || undefined;

		if (!file || file.size === 0) return fail(400, { error: 'File is required' });

		const id = generateId();
		const now = new Date();

		await DocumentRepository.create({
			_id: id,
			fileName: file.name,
			originalFileName: file.name,
			fileSize: file.size,
			mimeType: file.type || 'application/octet-stream',
			category,
			description: title,
			uploadedAt: now,
			uploadedBy: locals.user?._id
		});

		await AuditLog.create({
			_id: generateId(), tableName: 'document_repository', recordId: id,
			action: 'INSERT', newData: { fileName: file.name, category },
			changedAt: now, changedBy: locals.user?.username ?? 'system'
		});

		return { success: true };
	}
};

export const config = { maxDuration: 60 };
