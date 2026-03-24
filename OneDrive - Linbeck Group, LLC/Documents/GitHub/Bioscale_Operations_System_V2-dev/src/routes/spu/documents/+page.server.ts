import { fail, redirect } from '@sveltejs/kit';
import { connectDB, File, generateId } from '$lib/server/db';
import { requirePermission } from '$lib/server/permissions';
import type { PageServerLoad, Actions } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	if (!locals.user) redirect(302, '/login');
	requirePermission(locals.user, 'document:read');
	await connectDB();

	const files = await File.find({}).sort({ uploadedAt: -1 }).lean();

	return {
		files: files.map((f: any) => ({
			id: f._id,
			filename: f.filename ?? f.originalName ?? '',
			fileType: f.mimeType ?? f.fileType ?? 'application/octet-stream',
			fileSize: f.size ?? f.fileSize ?? 0,
			version: f.version ?? 1,
			isLatest: f.isLatest ?? true,
			uploadedAt: f.uploadedAt ?? f.createdAt ?? null,
			uploadedBy: f.uploadedBy ?? null,
			url: f.url ?? null
		}))
	};
};

export const actions: Actions = {
	upload: async ({ request, locals }) => {
		if (!locals.user) redirect(302, '/login');
		requirePermission(locals.user, 'document:write');
		await connectDB();
		const form = await request.formData();
		const file = form.get('file') as File;
		if (!file || !file.name) return fail(400, { error: 'No file uploaded' });

		const bytes = await file.arrayBuffer();
		const buffer = Buffer.from(bytes);
		const docId = generateId();

		await File.create({
			_id: docId,
			filename: file.name,
			originalName: file.name,
			mimeType: file.type,
			size: buffer.byteLength,
			fileSize: buffer.byteLength,
			version: 1,
			isLatest: true,
			uploadedAt: new Date(),
			uploadedBy: locals.user._id,
			data: buffer
		});

		return { success: true, fileId: docId };
	},

	delete: async ({ request, locals }) => {
		if (!locals.user) redirect(302, '/login');
		requirePermission(locals.user, 'document:write');
		await connectDB();
		const form = await request.formData();
		const fileId = form.get('fileId')?.toString();
		if (!fileId) return fail(400, { error: 'File ID required' });
		await File.deleteOne({ _id: fileId });
		return { success: true };
	}
};
