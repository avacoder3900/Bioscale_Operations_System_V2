import { connectDB, ValidationSession } from '$lib/server/db';
import { extractMagTestTime, pullDelaySeconds } from '$lib/server/magnetometer-time';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ url }) => {
	try {
		await connectDB();

		const status = url.searchParams.get('status') || null;
		const from = url.searchParams.get('from') || null;
		const to = url.searchParams.get('to') || null;

		// Sessions are written with type 'mag' by both the fetch action and the poll
		// endpoint; only 5 stray records in production ever used 'magnetometer'. This
		// page used to query the latter alone and so showed almost nothing.
		const query: Record<string, any> = { type: { $in: ['mag', 'magnetometer'] } };
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
			const magData = s.magResults ?? processed?.magResults ?? {};

			// Prefer the stored testRanAt, but derive it from rawData for the sessions
			// recorded before that field existed. rawData is already on every document,
			// so every historical row gets a correct time with no migration and without
			// touching a single stored record.
			const derived = extractMagTestTime(s.rawData);
			const testRanAt: Date | null = s.testRanAt ?? derived?.at ?? null;
			const recordedAt: Date | null = s.completedAt ?? s.createdAt ?? null;

			return {
				id: String(s._id),
				status: s.status ?? 'pending',
				passed: s.overallPassed ?? result?.passed ?? null,
				startedAt: s.startedAt?.toISOString?.() ?? null,
				completedAt: s.completedAt?.toISOString?.() ?? null,
				createdAt: s.createdAt?.toISOString?.() ?? new Date().toISOString(),
				testRanAt: testRanAt ? new Date(testRanAt).toISOString() : null,
				pullDelaySeconds: pullDelaySeconds(
					testRanAt ? new Date(testRanAt) : null,
					recordedAt ? new Date(recordedAt) : null
				),
				spuUdi: s.spuUdi ?? null,
				barcode: s.barcode ?? null,
				username: s.userId ?? null,
				avgMagnitude: magData.avgMagnitude ?? processed?.avgMagnitude ?? null
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
