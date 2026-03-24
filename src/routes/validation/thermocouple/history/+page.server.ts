import { connectDB, ValidationSession } from '$lib/server/db';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ url }) => {
	try {
		await connectDB();

		const status = url.searchParams.get('status') || null;
		const from = url.searchParams.get('from') || null;
		const to = url.searchParams.get('to') || null;

		const query: Record<string, any> = { type: 'thermocouple' };
		if (status) query.status = status;
		if (from || to) {
			query.createdAt = {};
			if (from) query.createdAt.$gte = new Date(from);
			if (to) {
				const end = new Date(to);
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
			const stats = processed?.stats ?? {};
			return {
				id: String(s._id),
				status: s.status ?? 'pending',
				passed: s.overallPassed ?? result?.passed ?? null,
				startedAt: s.startedAt?.toISOString?.() ?? null,
				completedAt: s.completedAt?.toISOString?.() ?? null,
				createdAt: s.createdAt?.toISOString?.() ?? new Date().toISOString(),
				barcode: s.barcode ?? null,
				username: s.userId ?? null,
				minTemp: stats.min ?? null,
				maxTemp: stats.max ?? null,
				avgTemp: stats.average ?? null
			};
		});

		const total = mapped.length;
		const passed = mapped.filter((s) => s.passed === true).length;
		const failed = mapped.filter((s) => s.passed === false).length;

		return {
			sessions: mapped,
			stats: { total, passed, failed },
			filters: { status, from, to }
		};
	} catch {
		return {
			sessions: [],
			stats: { total: 0, passed: 0, failed: 0 },
			filters: { status: null, from: null, to: null }
		};
	}
};

export const config = { maxDuration: 60 };
