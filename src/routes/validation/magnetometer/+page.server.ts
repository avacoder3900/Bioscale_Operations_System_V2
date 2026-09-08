import { requirePermission } from '$lib/server/permissions';
import { connectDB, ValidationSession, User } from '$lib/server/db';
import { extractMagTestTime } from '$lib/server/magnetometer-time';
import type { PageServerLoad } from './$types';

/**
 * Magnetometer Validation - the chronological run log.
 *
 * This route used to be the device-read page; that moved to
 * /validation/magnetometer/run. No server-side filters: the page sorts
 * client-side via the arrow in the Date header.
 */
export const load: PageServerLoad = async ({ locals }) => {
	requirePermission(locals.user, 'spu:read');
	await connectDB();

	// Sessions are written with type 'mag' by both the fetch action and the poll
	// endpoint; only 5 stray records in production ever used 'magnetometer'.
	const sessions = (await ValidationSession.find({ type: { $in: ['mag', 'magnetometer'] } })
		.sort({ createdAt: -1 })
		.limit(200)
		.lean()) as any[];

	// Resolve usernames. The previous version of this page put the raw userId in
	// the User column, so it rendered a nanoid rather than a name.
	const userIds = [...new Set(sessions.map((s) => s.userId).filter(Boolean))];
	const users = userIds.length
		? ((await User.find({ _id: { $in: userIds } }, { username: 1 }).lean()) as any[])
		: [];
	const userMap = new Map(users.map((u) => [u._id, u.username]));

	/** Lowest / highest Z (gauss) across every well and channel in a run. */
	function gaussRange(raw: any): { min: number | null; max: number | null } {
		if (!Array.isArray(raw) || raw.length === 0) return { min: null, max: null };
		const zs = raw
			.flatMap((w: any) => [w?.chA_Z, w?.chB_Z, w?.chC_Z])
			.filter((z: any): z is number => typeof z === 'number');
		if (!zs.length) return { min: null, max: null };
		return { min: Math.min(...zs), max: Math.max(...zs) };
	}

	const mapped = sessions.map((s) => {
		const result = (s.results ?? [])[0] as any;
		const processed = result?.processedData ?? {};
		const wells = s.magResults ?? processed?.magResults ?? null;
		const { min, max } = gaussRange(wells);

		// When the test actually ran on the device — NOT when it was pulled into
		// BIMS; those differ by days on some units. Stored testRanAt first, else
		// recovered from the raw payload header. Deliberately no fall back to
		// completedAt/createdAt: magnetometer-time.ts exists precisely because
		// showing the pull time as the test time was the original bug, so a run
		// with no recoverable timestamp renders as unknown.
		const testRanAt = s.testRanAt ?? extractMagTestTime(s.rawData)?.at ?? null;

		return {
			id: String(s._id),
			testRanAt: testRanAt ? new Date(testRanAt).toISOString() : null,
			status: s.status ?? 'pending',
			passed: s.overallPassed ?? result?.passed ?? null,
			completedAt: s.completedAt?.toISOString?.() ?? null,
			createdAt: s.createdAt?.toISOString?.() ?? new Date().toISOString(),
			spuUdi: s.spuUdi ?? null,
			spuId: s.spuId ?? null,
			username: userMap.get(s.userId) ?? null,
			gaussMin: min,
			gaussMax: max
		};
	});

	const total = mapped.length;
	const passed = mapped.filter((s) => s.passed === true).length;
	const failed = mapped.filter((s) => s.passed === false).length;

	return { sessions: mapped, stats: { total, passed, failed } };
};

export const config = { maxDuration: 60 };
