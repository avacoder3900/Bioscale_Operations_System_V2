import { connectDB, ValidationSession } from '$lib/server/db';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ url }) => {
	try {
		await connectDB();

		const status = url.searchParams.get('status') || null;
		const startDate = url.searchParams.get('startDate') || null;
		const endDate = url.searchParams.get('endDate') || null;

		const query: Record<string, any> = { type: 'spectrophotometer' };
		if (status) query.status = status;
		if (startDate || endDate) {
			query.createdAt = {};
			if (startDate) query.createdAt.$gte = new Date(startDate);
			if (endDate) {
				const end = new Date(endDate);
				end.setHours(23, 59, 59, 999);
				query.createdAt.$lte = end;
			}
		}

		const sessions = await ValidationSession.find(query)
			.sort({ createdAt: -1 })
			.limit(200)
			.lean() as any[];

		const mapped = sessions.map((s) => {
			const result = (s.results ?? [])[0] as any;
			const processed = result?.processedData ?? {};
			const metrics = processed?.metrics ?? {};
			return {
				id: String(s._id),
				status: s.status ?? 'pending',
				startedAt: s.startedAt?.toISOString?.() ?? null,
				completedAt: s.completedAt?.toISOString?.() ?? null,
				createdAt: s.createdAt?.toISOString?.() ?? new Date().toISOString(),
				barcode: s.barcode ?? null,
				username: s.userId ?? null,
				passed: s.overallPassed ?? result?.passed ?? null,
				peakWavelength: metrics.peakWavelength ?? null,
				peakAbsorbance: metrics.peakAbsorbance ?? null
			};
		});

		const total = mapped.length;
		const passed = mapped.filter((s) => s.passed === true).length;
		const failed = mapped.filter((s) => s.passed === false).length;

		return {
			sessions: mapped,
			stats: { total, passed, failed },
			filters: { status, startDate, endDate }
		};
	} catch {
		return {
			sessions: [],
			stats: { total: 0, passed: 0, failed: 0 },
			filters: { status: null, startDate: null, endDate: null }
		};
	}
};

export const config = { maxDuration: 60 };
