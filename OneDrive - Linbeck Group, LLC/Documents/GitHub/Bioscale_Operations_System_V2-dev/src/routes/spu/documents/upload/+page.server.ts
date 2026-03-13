import { fail } from '@sveltejs/kit';
import { hasPermission } from '$lib/server/permissions';
import { connectDB, DocumentRepository, WorkInstruction, PartDefinition, AuditLog, generateId } from '$lib/server/db';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	return {
		canUploadWorkInstruction: hasPermission(locals.user, 'workInstruction:write'),
		canUploadDocument: hasPermission(locals.user, 'documentRepo:write')
	};
};

export const actions: Actions = {
	upload: async ({ request, locals }) => {
		await connectDB();
		const form = await request.formData();

		// Get all 'file' fields — the enhance handler sets the real file,
		// but a hidden input with the same name may also exist. Pick the actual File.
		const fileEntries = form.getAll('file');
		const file = fileEntries.find((f): f is File => f instanceof File && f.size > 0) as File | undefined;
		const title = form.get('title')?.toString().trim() || undefined;
		const description = form.get('description')?.toString().trim() || undefined;

		if (!file || file.size === 0) return fail(400, { error: 'File is required' });

		const fileName = file.name.toLowerCase();
		const isWorkInstruction = fileName.includes('wimf') || fileName.includes('wi-')
			|| fileName.includes('work instruction') || fileName.includes('work_instruction')
			|| fileName.endsWith('.pdf') || fileName.endsWith('.docx');

		const id = generateId();
		const now = new Date();
		const username = locals.user?.username ?? 'system';

		if (isWorkInstruction && hasPermission(locals.user, 'workInstruction:write')) {
			const docNumber = extractDocumentNumber(file.name);
			// Check for duplicate document number
			if (docNumber) {
				const existing = await WorkInstruction.findOne({ documentNumber: docNumber }).lean() as any;
				if (existing) {
					return fail(409, {
						error: `Work instruction ${docNumber} already exists`,
						existingId: existing._id
					});
				}
			}

			await WorkInstruction.create({
				_id: id,
				title: title || file.name.replace(/\.(pdf|docx)$/i, ''),
				documentNumber: docNumber || `WI-${id.slice(0, 8).toUpperCase()}`,
				originalFileName: file.name,
				fileSize: file.size,
				mimeType: file.type || 'application/octet-stream',
				status: 'draft',
				currentVersion: 1,
				versions: [{
					version: 1,
					content: description || '',
					steps: [],
					createdAt: now
				}],
				createdBy: username
			});

			await AuditLog.create({
				_id: generateId(), tableName: 'work_instructions', recordId: id,
				action: 'INSERT', newData: { title, documentNumber: docNumber, fileName: file.name },
				changedAt: now, changedBy: username
			});

			return {
				success: true,
				type: 'work_instruction' as const,
				workInstructionId: id,
				parsed: {
					docType: 'work_instruction',
					documentNumber: docNumber,
					title: title || file.name,
					fileName: file.name,
					steps: []
				}
			};
		} else {
			// Regular document upload
			if (!hasPermission(locals.user, 'documentRepo:write')) {
				return fail(403, { error: 'Permission denied: requires documentRepo:write' });
			}

			await DocumentRepository.create({
				_id: id,
				fileName: file.name,
				originalFileName: file.name,
				fileSize: file.size,
				mimeType: file.type || 'application/octet-stream',
				description: title,
				uploadedAt: now,
				uploadedBy: locals.user?._id
			});

			await AuditLog.create({
				_id: generateId(), tableName: 'document_repository', recordId: id,
				action: 'INSERT', newData: { fileName: file.name },
				changedAt: now, changedBy: username
			});

			return {
				success: true,
				type: 'document' as const,
				documentId: id,
				parsed: {
					fileName: file.name,
					docType: 'document'
				}
			};
		}
	}
};

/** Extract document number from filename like "WIMF-SPU-01 v15.docx" -> "WIMF-SPU-01" */
function extractDocumentNumber(filename: string): string | null {
	const match = filename.match(/(WIMF-[A-Z]+-\d+|WI-[A-Z]+-\d+|WI-\d+)/i);
	return match ? match[1].toUpperCase() : null;
}
