/**
 * POST /api/coc/process
 *
 * Full COC photo processing pipeline:
 *   1. Accept photo upload
 *   2. Send to OCR service → extract lot number (L-YYYY-MM-DD-XX)
 *   3. Create (or reuse) a date folder in Box  (e.g. "2026-03-23")
 *   4. Rename the photo to the lot number and upload to that folder
 *   5. Return the folder URL and file URL for linking from BIMS
 *
 * Form fields:
 *   - file: File          (required) the COC photo
 *   - lotNumber: string   (optional) manual override — skip OCR if provided
 *
 * Env vars used:
 *   BOX_COC_FOLDER_ID  — root folder in Box for COC photos (required)
 *   OCR_API_URL         — OCR microservice base URL (optional — manual entry fallback)
 */
import { json } from '@sveltejs/kit';
import { connectDB, AuditLog, generateId } from '$lib/server/db';
import { uploadFile, getOrCreateDateFolder } from '$lib/server/box';
import { extractText, parseLotNumbers } from '$lib/server/ocr';
import { env } from '$env/dynamic/private';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ request, locals }) => {
	if (!locals.user) {
		return json({ error: 'Unauthorized' }, { status: 401 });
	}

	const cocRootFolderId = env.BOX_COC_FOLDER_ID;
	if (!cocRootFolderId) {
		return json({ error: 'BOX_COC_FOLDER_ID is not configured' }, { status: 500 });
	}

	await connectDB();

	const formData = await request.formData();
	const file = formData.get('file') as File | null;
	const manualLotNumber = formData.get('lotNumber')?.toString()?.trim();

	if (!file || !file.size) {
		return json({ error: 'A photo file is required' }, { status: 400 });
	}

	try {
		const buffer = await file.arrayBuffer();
		const ext = file.name.split('.').pop() ?? 'jpg';

		// --- Step 1: Extract lot number via OCR or use manual override ---
		let lotNumber = manualLotNumber || '';
		let ocrRawText = '';

		if (!lotNumber) {
			const ocrResult = await extractText(buffer, file.name);
			ocrRawText = ocrResult.rawText;

			if (ocrResult.lotNumbers.length > 0) {
				lotNumber = ocrResult.lotNumbers[0]; // take the first match
			}
		}

		if (!lotNumber) {
			// OCR didn't find a lot number and none was provided manually
			return json(
				{
					error: 'Could not extract a lot number from the photo. Please enter it manually.',
					ocrText: ocrRawText,
					lotNumbers: []
				},
				{ status: 422 }
			);
		}

		// --- Step 2: Create date folder in Box ---
		const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
		const dateFolder = await getOrCreateDateFolder(cocRootFolderId, today);

		// --- Step 3: Upload photo named after the lot number ---
		const fileName = `${lotNumber}.${ext}`;
		const uploaded = await uploadFile(dateFolder.id, fileName, buffer);

		// Use BIMS proxy URL so the file loads inline (not Box redirect)
		const fileUrl = `/api/box/files/${uploaded.id}/view`;
		const folderUrl = `https://app.box.com/folder/${dateFolder.id}`;

		// --- Step 4: Audit log ---
		await AuditLog.create({
			_id: generateId(),
			tableName: 'coc_photos',
			recordId: uploaded.id,
			action: 'INSERT',
			newData: {
				lotNumber,
				fileName,
				folderId: dateFolder.id,
				folderName: dateFolder.name,
				fileUrl,
				folderUrl
			},
			changedBy: locals.user._id,
			changedAt: new Date()
		});

		return json({
			success: true,
			lotNumber,
			fileId: uploaded.id,
			fileName: uploaded.name,
			fileUrl,
			folderId: dateFolder.id,
			folderUrl,
			ocrText: ocrRawText || undefined
		});
	} catch (err) {
		console.error('[coc/process] Error:', err);
		return json(
			{ error: err instanceof Error ? err.message : 'COC processing failed' },
			{ status: 500 }
		);
	}
};
