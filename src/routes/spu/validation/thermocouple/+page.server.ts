import { fail, redirect } from '@sveltejs/kit';
import { requirePermission } from '$lib/server/permissions';
import { connectDB, ValidationSession, GeneratedBarcode, AuditLog, generateId } from '$lib/server/db';
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
			barcode: s.barcode ?? barcodeMap.get(s.generatedBarcodeId) ?? null,
			createdAt: s.createdAt?.toISOString() ?? new Date().toISOString(),
			config: s.config ?? null
		}))
	};
};

export const actions: Actions = {
	configure: async ({ request, locals }) => {
		requirePermission(locals.user, 'spu:write');
		await connectDB();
		const form = await request.formData();

		// Read config from form
		const durationSeconds = Number(form.get('durationSeconds')) || 60;
		const intervalSeconds = Number(form.get('interval')) || 1;
		const minTemp = Number(form.get('minTemp'));
		const maxTemp = Number(form.get('maxTemp'));

		// Validate
		if (durationSeconds <= 0) return fail(400, { error: 'Duration must be positive' });
		if (intervalSeconds <= 0) return fail(400, { error: 'Interval must be positive' });
		if (isNaN(minTemp) || isNaN(maxTemp)) return fail(400, { error: 'Temperature range is required' });
		if (minTemp >= maxTemp) return fail(400, { error: 'Min temperature must be less than max' });

		// Generate barcode
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

		// Create session with config
		const sessionId = generateId();
		await ValidationSession.create({
			_id: sessionId,
			type: 'thermo',
			status: 'pending',
			userId: locals.user!._id,
			generatedBarcodeId: barcodeId,
			barcode,
			config: { durationSeconds, intervalSeconds, minTemp, maxTemp },
			results: []
		});

		// Audit log
		await AuditLog.create({
			_id: generateId(),
			action: 'thermocouple_session_created',
			resourceType: 'validation_session',
			resourceId: sessionId,
			userId: locals.user!._id,
			username: locals.user!.username,
			timestamp: new Date(),
			details: { barcode, durationSeconds, intervalSeconds, minTemp, maxTemp }
		});

		throw redirect(303, `/spu/validation/thermocouple/${sessionId}`);
	}
};
