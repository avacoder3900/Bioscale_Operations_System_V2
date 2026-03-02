import { requirePermission } from '$lib/server/permissions';
import { connectDB, ValidationSession, GeneratedBarcode, User } from '$lib/server/db';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	requirePermission(locals.user, 'spu:read');
	await connectDB();

	const todayStart = new Date();
	todayStart.setHours(0, 0, 0, 0);

	const [sessions, statsByType, todayBarcodes] = await Promise.all([
		ValidationSession.find().sort({ createdAt: -1 }).limit(20).lean(),
		ValidationSession.aggregate([
			{
				$group: {
					_id: '$type',
					total: { $sum: 1 },
					passed: {
						$sum: { $cond: [{ $eq: ['$status', 'completed'] }, 1, 0] }
					},
					failed: {
						$sum: { $cond: [{ $eq: ['$status', 'failed'] }, 1, 0] }
					}
				}
			}
		]),
		GeneratedBarcode.countDocuments({ createdAt: { $gte: todayStart } })
	]);

	// Build user lookup for session usernames
	const userIds = [...new Set((sessions as any[]).map(s => s.userId).filter(Boolean))];
	const users = userIds.length > 0
		? await User.find({ _id: { $in: userIds } }).select('_id username').lean()
		: [];
	const userMap = new Map(users.map((u: any) => [u._id, u.username]));

	// Build barcode lookup for sessions
	const barcodeIds = [...new Set((sessions as any[]).map(s => s.generatedBarcodeId).filter(Boolean))];
	const barcodes = barcodeIds.length > 0
		? await GeneratedBarcode.find({ _id: { $in: barcodeIds } }).select('_id barcode').lean()
		: [];
	const barcodeMap = new Map(barcodes.map((b: any) => [b._id, b.barcode]));

	// Build stats per instrument type
	const typeStatsMap = new Map(statsByType.map((s: any) => [s._id, s]));
	const makeStats = (type: string) => {
		const s = typeStatsMap.get(type);
		return { total: s?.total ?? 0, passed: s?.passed ?? 0, failed: s?.failed ?? 0 };
	};

	return {
		recentSessions: (sessions as any[]).map(s => ({
			id: s._id,
			type: s.type ?? 'unknown',
			status: s.status ?? 'pending',
			startedAt: s.startedAt ?? null,
			completedAt: s.completedAt ?? null,
			createdAt: s.createdAt,
			barcode: barcodeMap.get(s.generatedBarcodeId) ?? null,
			username: userMap.get(s.userId) ?? null
		})),
		stats: {
			spectrophotometer: makeStats('spectrophotometer'),
			thermocouple: makeStats('thermocouple'),
			magnetometer: makeStats('magnetometer')
		},
		barcodeStats: {
			today: todayBarcodes
		}
	};
};
