import { fail } from '@sveltejs/kit';
import { requirePermission } from '$lib/server/permissions';
import { connectDB, ValidationSession, GeneratedBarcode, generateId } from '$lib/server/db';
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
	}
};

export const config = { maxDuration: 60 };
