import { fail } from '@sveltejs/kit';
import { requirePermission } from '$lib/server/permissions';
import { connectDB, ValidationSession, GeneratedBarcode, Spu, AuditLog, generateId } from '$lib/server/db';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	requirePermission(locals.user, 'spu:read');
	await connectDB();

	const sessions = await ValidationSession.find({ type: 'thermo' })
		.sort({ createdAt: -1 })
		.limit(20)
		.lean();

	const barcodeIds = sessions.map((s: any) => s.generatedBarcodeId).filter(Boolean);
	const barcodes = barcodeIds.length ? await GeneratedBarcode.find({ _id: { $in: barcodeIds } }).lean() : [];
	const barcodeMap = new Map(barcodes.map((b: any) => [b._id, b.barcode]));

	return {
		recentSessions: sessions.map((s: any) => ({
			id: s._id,
			status: s.status,
			barcode: barcodeMap.get(s.generatedBarcodeId) ?? null,
			createdAt: s.createdAt?.toISOString() ?? new Date().toISOString(),
			config: null // config stored in session if needed
		}))
	};
};

export const actions: Actions = {
	configure: async ({ request, locals }) => {
		requirePermission(locals.user, 'spu:write');
		await connectDB();
		const form = await request.formData();

		const barcodeDoc = await GeneratedBarcode.findOneAndUpdate(
			{ prefix: 'THERMO' },
			{ $inc: { sequence: 1 } },
			{ upsert: true, new: true, setDefaultsOnInsert: true }
		);
		const seq = (barcodeDoc as any).sequence ?? 1;
		const barcode = `THERMO-${String(seq).padStart(6, '0')}`;

		const barcodeId = generateId();
		await GeneratedBarcode.create({
			_id: barcodeId,
			prefix: 'THERMO',
			sequence: seq,
			barcode,
			type: 'validation_thermo'
		});

		const sessionId = generateId();
		await ValidationSession.create({
			_id: sessionId,
			type: 'thermo',
			status: 'pending',
			userId: locals.user!._id,
			generatedBarcodeId: barcodeId,
			results: []
		});

		return { success: true, sessionId };
	},

	// Upload a thermocouple CSV and attach it (inline) to an SPU document.
	attachCsv: async ({ request, locals }) => {
		requirePermission(locals.user, 'spu:write');
		await connectDB();
		const form = await request.formData();

		const udi = form.get('udi')?.toString().trim();
		const sessionId = form.get('sessionId')?.toString().trim() || undefined;
		const file = form.get('file') as File | null;

		if (!udi) return fail(400, { attachError: 'SPU UDI or barcode is required' });
		if (!file || file.size === 0) return fail(400, { attachError: 'A CSV file is required' });

		const name = file.name.toLowerCase();
		const isCsv = name.endsWith('.csv') || file.type === 'text/csv' || file.type === 'application/vnd.ms-excel';
		if (!isCsv) return fail(400, { attachError: 'File must be a .csv' });

		// Inline storage guard — keep well under Mongo's 16MB document limit.
		const MAX_BYTES = 5 * 1024 * 1024;
		if (file.size > MAX_BYTES) {
			return fail(400, { attachError: 'CSV is too large to store inline (max 5MB)' });
		}

		const content = await file.text();
		// Count data rows (non-empty lines, minus header if present).
		const nonEmpty = content.split(/\r?\n/).filter((l) => l.trim().length > 0);
		const rowCount = nonEmpty.length > 0 ? nonEmpty.length - 1 : 0;

		const spu = await Spu.findOne({ $or: [{ udi }, { barcode: udi }] });
		if (!spu) return fail(404, { attachError: `No SPU found for "${udi}"` });
		if ((spu as any).finalizedAt) {
			return fail(400, {
				attachError: 'SPU is finalized — attachments cannot be added. Use corrections.'
			});
		}

		const now = new Date();
		const attachmentId = generateId();
		await Spu.updateOne(
			{ _id: spu._id },
			{
				$push: {
					attachments: {
						_id: attachmentId,
						kind: 'thermocouple_csv',
						fileName: file.name,
						mimeType: file.type || 'text/csv',
						fileSize: file.size,
						rowCount,
						content,
						sessionId,
						uploadedAt: now,
						uploadedBy: { _id: locals.user!._id, username: locals.user!.username }
					}
				}
			}
		);

		await AuditLog.create({
			_id: generateId(),
			tableName: 'spus',
			recordId: spu._id,
			action: 'UPDATE',
			newData: { attachment: { id: attachmentId, fileName: file.name, rowCount, fileSize: file.size } },
			changedAt: now,
			changedBy: locals.user?.username ?? 'system'
		});

		return {
			attachSuccess: true,
			attachFileName: file.name,
			attachRowCount: rowCount,
			attachUdi: (spu as any).udi ?? udi
		};
	}
};
