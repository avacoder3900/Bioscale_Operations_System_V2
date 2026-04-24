/**
 * Admin-only Work Instruction upload & auto-populate action.
 *
 * Implements PRD-SPU-MFG-UNIFIED.md §4.3 / SPU-MFG-08:
 *   - Accept multipart/form-data with a `file` field (.docx or .pdf).
 *   - Parse into steps + part/qty tuples + barcode_scan fieldDefinitions.
 *   - Look up existing WI by `documentNumber`; if present, push a new version
 *     with an incremented `version` number. Otherwise create a new WI.
 *   - Write an AuditLog entry (INSERT for new WI, UPDATE for new version).
 *
 * Permissions: `workInstruction:write` AND (admin:full OR
 * workInstruction:upload-parse).
 */

import { error, fail } from '@sveltejs/kit';
import {
	connectDB,
	WorkInstruction,
	AuditLog,
	generateId
} from '$lib/server/db';
import { requirePermission, hasPermission } from '$lib/server/permissions';
import { parseWorkInstruction } from '$lib/server/wi-parser';
import type { Actions, PageServerLoad } from './$types';

const DOCX_MIME =
	'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const PDF_MIME = 'application/pdf';
const MAX_FILE_SIZE = 20 * 1024 * 1024; // 20 MB

export const load: PageServerLoad = async ({ locals }) => {
	requirePermission(locals.user, 'workInstruction:write');
	if (
		!hasPermission(locals.user, 'admin:full') &&
		!hasPermission(locals.user, 'workInstruction:upload-parse')
	) {
		throw error(403, 'Permission denied: admin-only upload-parse');
	}
	return {};
};

export const actions: Actions = {
	default: async ({ request, locals }) => {
		requirePermission(locals.user, 'workInstruction:write');
		if (
			!hasPermission(locals.user, 'admin:full') &&
			!hasPermission(locals.user, 'workInstruction:upload-parse')
		) {
			return fail(403, { error: 'Admin-only: upload-parse requires admin:full' });
		}

		await connectDB();

		const form = await request.formData();
		const file = form.get('file') as File | null;
		const documentNumber = form.get('documentNumber')?.toString().trim();
		const title = form.get('title')?.toString().trim();
		const category = form.get('category')?.toString().trim() || undefined;
		const changeNotes = form.get('changeNotes')?.toString() || undefined;

		if (!file || file.size === 0) return fail(400, { error: 'File is required' });
		if (!documentNumber) return fail(400, { error: 'documentNumber is required' });
		if (file.size > MAX_FILE_SIZE) {
			return fail(400, { error: `File too large (max ${MAX_FILE_SIZE} bytes)` });
		}

		const mime = (file.type || '').toLowerCase();
		if (mime !== DOCX_MIME && mime !== PDF_MIME) {
			return fail(400, {
				error: `Unsupported file type: ${file.type || 'unknown'} (expected .docx or .pdf)`
			});
		}

		let parsed;
		try {
			const buffer = Buffer.from(await file.arrayBuffer());
			parsed = await parseWorkInstruction(buffer, mime);
		} catch (err: any) {
			return fail(400, {
				error: `Parse failed: ${err?.message ?? 'unknown parser error'}`
			});
		}

		if (!parsed.steps.length) {
			return fail(400, { error: 'No steps detected in uploaded document' });
		}

		// Map the ParsedWI into the WorkInstruction `versions[].steps[]` shape.
		const mappedSteps = parsed.steps.map((s, idx) => ({
			_id: generateId(),
			stepNumber: s.stepNumber ?? idx + 1,
			title: s.title,
			content: s.content,
			requiresScan: s.fieldDefinitions.length > 0,
			partRequirements: s.partRequirements.map((pr) => ({
				_id: generateId(),
				partNumber: pr.partNumber,
				quantity: pr.quantity
			})),
			toolRequirements: [],
			fieldDefinitions: s.fieldDefinitions.map((fd) => ({
				_id: generateId(),
				fieldName: fd.fieldName,
				fieldLabel: fd.fieldLabel,
				fieldType: fd.fieldType,
				isRequired: fd.isRequired,
				sortOrder: fd.sortOrder,
				barcodeFieldMapping: fd.barcodeFieldMapping
			}))
		}));

		const now = new Date();
		const existing = (await WorkInstruction.findOne({ documentNumber }).lean()) as any;

		if (existing) {
			const nextVersion = (existing.currentVersion ?? existing.versions?.length ?? 0) + 1;
			const newVersion = {
				_id: generateId(),
				version: nextVersion,
				content: '',
				rawContent: '',
				changeNotes: changeNotes ?? `Uploaded ${file.name}`,
				parsedAt: now,
				parsedBy: locals.user?.username ?? 'system',
				createdAt: now,
				steps: mappedSteps
			};

			await WorkInstruction.findByIdAndUpdate(existing._id, {
				$push: { versions: newVersion },
				$set: {
					currentVersion: nextVersion,
					originalFileName: file.name,
					fileSize: file.size,
					mimeType: mime,
					updatedAt: now
				}
			});

			await AuditLog.create({
				_id: generateId(),
				tableName: 'work_instructions',
				recordId: existing._id,
				action: 'UPDATE',
				newData: {
					documentNumber,
					version: nextVersion,
					fileName: file.name,
					stepCount: mappedSteps.length
				},
				changedAt: now,
				changedBy: locals.user?.username ?? 'system',
				reason: 'WI upload-parse (new version)'
			});

			return {
				success: true,
				workInstructionId: existing._id,
				documentNumber,
				version: nextVersion,
				stepCount: mappedSteps.length,
				fieldCount: mappedSteps.reduce((n, s) => n + s.fieldDefinitions.length, 0)
			};
		}

		const id = generateId();
		await WorkInstruction.create({
			_id: id,
			documentNumber,
			title: title || documentNumber,
			category,
			status: 'draft',
			currentVersion: 1,
			originalFileName: file.name,
			fileSize: file.size,
			mimeType: mime,
			createdBy: locals.user?._id,
			versions: [
				{
					_id: generateId(),
					version: 1,
					content: '',
					rawContent: '',
					changeNotes: changeNotes ?? `Uploaded ${file.name}`,
					parsedAt: now,
					parsedBy: locals.user?.username ?? 'system',
					createdAt: now,
					steps: mappedSteps
				}
			]
		});

		await AuditLog.create({
			_id: generateId(),
			tableName: 'work_instructions',
			recordId: id,
			action: 'INSERT',
			newData: {
				documentNumber,
				title: title || documentNumber,
				fileName: file.name,
				stepCount: mappedSteps.length
			},
			changedAt: now,
			changedBy: locals.user?.username ?? 'system',
			reason: 'WI upload-parse (new work instruction)'
		});

		return {
			success: true,
			workInstructionId: id,
			documentNumber,
			version: 1,
			stepCount: mappedSteps.length,
			fieldCount: mappedSteps.reduce((n, s) => n + s.fieldDefinitions.length, 0)
		};
	}
};

export const config = { maxDuration: 60 };
