import { fail, redirect } from '@sveltejs/kit';
import { requirePermission } from '$lib/server/permissions';
import { connectDB, ValidationSession, GeneratedBarcode, User, generateId } from '$lib/server/db';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	requirePermission(locals.user, 'spu:read');
	await connectDB();

	const sessions = await ValidationSession.find({ type: 'mag' })
		.sort({ createdAt: -1 })
		.limit(20)
		.lean();

	const userIds = [...new Set(sessions.map((s: any) => s.userId).filter(Boolean))];
	const users = userIds.length ? await User.find({ _id: { $in: userIds } }, { username: 1 }).lean() : [];
	const userMap = new Map(users.map((u: any) => [u._id, u.username]));

	// Get barcodes for sessions
	const barcodeIds = sessions.map((s: any) => s.generatedBarcodeId).filter(Boolean);
	const barcodes = barcodeIds.length ? await GeneratedBarcode.find({ _id: { $in: barcodeIds } }).lean() : [];
	const barcodeMap = new Map(barcodes.map((b: any) => [b._id, b.barcode]));

	const total = sessions.length;
	const passed = sessions.filter((s: any) => s.status === 'completed' && s.results?.some((r: any) => r.passed)).length;
	const failed = sessions.filter((s: any) => s.status === 'failed' || s.results?.some((r: any) => r.passed === false)).length;
	const inProgress = sessions.filter((s: any) => s.status === 'in_progress').length;

	return {
		recentSessions: sessions.map((s: any) => ({
			id: s._id,
			status: s.status,
			startedAt: s.startedAt?.toISOString() ?? null,
			completedAt: s.completedAt?.toISOString() ?? null,
			createdAt: s.createdAt?.toISOString() ?? new Date().toISOString(),
			barcode: barcodeMap.get(s.generatedBarcodeId) ?? null,
			username: userMap.get(s.userId) ?? null
		})),
		stats: { total, passed, failed, inProgress }
	};
};

export const actions: Actions = {
	start: async ({ locals }) => {
		requirePermission(locals.user, 'spu:write');
		await connectDB();

		// Generate barcode atomically
		const barcodeDoc = await GeneratedBarcode.findOneAndUpdate(
			{ prefix: 'MAG' },
			{ $inc: { sequence: 1 } },
			{ upsert: true, new: true, setDefaultsOnInsert: true }
		);
		const seq = (barcodeDoc as any).sequence ?? 1;
		const barcode = `MAG-${String(seq).padStart(6, '0')}`;

		const barcodeId = generateId();
		await GeneratedBarcode.create({
			_id: barcodeId,
			prefix: 'MAG',
			sequence: seq,
			barcode,
			type: 'validation_mag'
		});

		const sessionId = generateId();
		await ValidationSession.create({
			_id: sessionId,
			type: 'mag',
			status: 'in_progress',
			startedAt: new Date(),
			userId: locals.user!._id,
			generatedBarcodeId: barcodeId,
			results: []
		});

		redirect(303, `/spu/validation/magnetometer/${sessionId}`);
	}
};
