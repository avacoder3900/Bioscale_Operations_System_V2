import { json } from '@sveltejs/kit';
import { connectDB, ReceivingLot, AuditLog, generateId } from '$lib/server/db';
import { uploadFile, buildCocKey } from '$lib/server/r2';
import { extractText } from '$lib/server/ocr';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ request, locals }) => {
	if (!locals.user) return json({ error: 'Unauthorized' }, { status: 401 });
	await connectDB();

	const formData = await request.formData();
	const file = formData.get('file') as File | null;
	const manualLotNumber = formData.get('lotNumber')?.toString()?.trim();
	const lotId = formData.get('lotId')?.toString()?.trim();

	if (!file || !file.size) return json({ error: 'A photo file is required' }, { status: 400 });

	try {
		const buffer = await file.arrayBuffer();
		const ext = file.name.split('.').pop() ?? 'jpg';

		let lotNumber = manualLotNumber || '';
		let ocrRawText = '';
		if (!lotNumber) {
			const ocrResult = await extractText(buffer, file.name);
			ocrRawText = ocrResult.rawText;
			if (ocrResult.lotNumbers.length > 0) lotNumber = ocrResult.lotNumbers[0];
		}
		if (!lotNumber) return json({ error: 'Could not extract lot number.', ocrText: ocrRawText }, { status: 422 });

		const r2Key = buildCocKey(lotNumber, ext);
		await uploadFile(r2Key, buffer, file.type || 'image/jpeg');
		const fileUrl = '/api/r2/files/' + r2Key;
		const fileName = lotNumber + '.' + ext;

		let linkedLotId: string | null = null;
		if (lotId) {
			const entry = { lotNumber, r2Key, fileUrl, fileName, uploadedAt: new Date() };
			const updated = await ReceivingLot.findOneAndUpdate(
				{ $or: [{ _id: lotId }, { lotId }] },
				{ $push: { cocPhotos: entry }, $set: { cocDocumentUrl: fileUrl } },
				{ new: true }
			);
			if (updated) linkedLotId = (updated as any)._id;
		}

		await AuditLog.create({
			_id: generateId(), tableName: 'coc_photos', recordId: r2Key, action: 'INSERT',
			newData: { lotNumber, r2Key, fileName, fileUrl, linkedLotId },
			changedBy: locals.user._id, changedAt: new Date()
		});

		return json({ success: true, lotNumber, r2Key, fileName, fileUrl, linkedLotId, ocrText: ocrRawText || undefined });
	} catch (err) {
		console.error('[coc/process] Error:', err);
		return json({ error: err instanceof Error ? err.message : 'COC processing failed' }, { status: 500 });
	}
};
