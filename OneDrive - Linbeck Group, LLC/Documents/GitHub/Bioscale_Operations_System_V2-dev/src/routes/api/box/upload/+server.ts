/**
 * Box file upload endpoint.
 * Accepts multipart form data with a file and folderId.
 */
import { json, redirect } from '@sveltejs/kit';
import { connectDB, AuditLog, generateId } from '$lib/server/db';
import { uploadFile } from '$lib/server/box';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ request, locals }) => {
	if (!locals.user) {
		return json({ message: 'Unauthorized' }, { status: 401 });
	}

	await connectDB();

	const formData = await request.formData();
	const file = formData.get('file') as File | null;
	const folderId = formData.get('folderId')?.toString();

	if (!file) {
		return json({ message: 'No file provided' }, { status: 400 });
	}
	if (!folderId) {
		return json({ message: 'No folder ID provided' }, { status: 400 });
	}

	try {
		const buffer = await file.arrayBuffer();
		const result = await uploadFile(folderId, file.name, buffer);

		await AuditLog.create({
			_id: generateId(),
			tableName: 'box_files',
			recordId: result.id,
			action: 'INSERT',
			newData: { fileName: result.name, folderId, size: result.size },
			changedBy: locals.user.username ?? locals.user._id
		});

		return json({ success: true, file: result });
	} catch (err) {
		return json(
			{ message: err instanceof Error ? err.message : 'Upload failed' },
			{ status: 500 }
		);
	}
};
