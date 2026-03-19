import { requirePermission } from '$lib/server/permissions';
import { connectDB, ValidationSession, GeneratedBarcode, User } from '$lib/server/db';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, url }) => {
	requirePermission(locals.user, 'spu:read');
	await connectDB();

	// Parse query filters
	const statusFilter = url.searchParams.get('status');
	const fromDate = url.searchParams.get('from');
	const toDate = url.searchParams.get('to');

	// Build query
	const query: Record<string, any> = { type: 'thermo' };
	if (statusFilter === 'passed') {
		query.status = 'completed';
	} else if (statusFilter === 'failed') {
		query.status = 'failed';
	}
	if (fromDate || toDate) {
		query.createdAt = {};
		if (fromDate) query.createdAt.$gte = new Date(fromDate);
		if (toDate) {
			const end = new Date(toDate);
			end.setDate(end.getDate() + 1);
			query.createdAt.$lte = end;
		}
	}

	const sessions = await ValidationSession.find(query)
		.sort({ createdAt: -1 })
		.lean() as any[];

	// Resolve barcodes
	const barcodeIds = sessions.map(s => s.generatedBarcodeId).filter(Boolean);
	const barcodes = barcodeIds.length
		? await GeneratedBarcode.find({ _id: { $in: barcodeIds } }).lean() as any[]
		: [];
	const barcodeMap = new Map(barcodes.map(b => [b._id, b.barcode]));

	// Resolve usernames
	const userIds = [...new Set(sessions.map(s => s.userId).filter(Boolean))];
	const users = userIds.length
		? await User.find({ _id: { $in: userIds } }, { username: 1 }).lean() as any[]
		: [];
	const userMap = new Map(users.map(u => [u._id, u.username]));

	// Compute stats
	const allThermoSessions = await ValidationSession.find({ type: 'thermo' }).lean() as any[];
	const total = allThermoSessions.length;
	const passed = allThermoSessions.filter(s => s.status === 'completed').length;
	const failed = allThermoSessions.filter(s => s.status === 'failed').length;

	return {
		sessions: sessions.map((s: any) => {
			// Extract temp stats from the thermocouple result
			const thermoResult = s.results?.find((r: any) => r.testType === 'thermocouple');
			const stats = thermoResult?.processedData?.stats;

			return {
				id: s._id,
				status: s.status,
				passed: thermoResult?.passed ?? null,
				startedAt: s.startedAt?.toISOString?.() ?? null,
				completedAt: s.completedAt?.toISOString?.() ?? null,
				createdAt: s.createdAt?.toISOString?.() ?? new Date().toISOString(),
				barcode: s.barcode ?? barcodeMap.get(s.generatedBarcodeId) ?? null,
				username: userMap.get(s.userId) ?? null,
				minTemp: stats?.min ?? null,
				maxTemp: stats?.max ?? null,
				avgTemp: stats?.average ?? null
			};
		}),
		stats: { total, passed, failed },
		filters: {
			status: statusFilter,
			from: fromDate,
			to: toDate
		}
	};
};
