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

	/** A finite number, or null. Guards every magnitude against NaN/Infinity. */
	function num(v: any): number | null {
		return typeof v === 'number' && Number.isFinite(v) ? v : null;
	}

	function range(values: number[]): { min: number | null; max: number | null } {
		if (!values.length) return { min: null, max: null };
		return { min: Math.min(...values), max: Math.max(...values) };
	}

	const CHANNELS = ['chA', 'chB', 'chC'] as const;

	/**
	 * Lowest / highest FIELD MAGNITUDE (gauss) across every well and channel.
	 *
	 * This column used to project Z alone, which is why the list disagreed with
	 * the detail page (which derives sqrt(x² + y² + z²)). Preference order, best
	 * source first:
	 *   1. fieldSummary.minMag / maxMag — precomputed at ingest.
	 *   2. per-well chA_mag / chB_mag / chC_mag — stored per-channel magnitudes.
	 *   3. sqrt(x² + y² + z²) from the stored components — every run written
	 *      before magnitudes were persisted, i.e. the common case until the
	 *      separate backfill runs.
	 *   4. Z alone — the previous behaviour, kept so a run carrying only Z still
	 *      renders a number instead of going blank.
	 *
	 * magResults is Schema.Types.Mixed, so a legacy or malformed payload carries
	 * no shape guarantee: anything unusable falls through to { null, null } and
	 * renders as '—', exactly like the old null return. It must never throw out
	 * of the load function and 500 the whole list.
	 */
	function fieldRange(summary: any, raw: any): { min: number | null; max: number | null } {
		try {
			const summaryMin = num(summary?.minMag);
			const summaryMax = num(summary?.maxMag);
			if (summaryMin !== null || summaryMax !== null) {
				return { min: summaryMin, max: summaryMax };
			}

			if (!Array.isArray(raw) || raw.length === 0) return { min: null, max: null };

			const stored: number[] = raw.flatMap((w: any) =>
				CHANNELS.map((c) => num(w?.[`${c}_mag`])).filter((m): m is number => m !== null)
			);
			if (stored.length) return range(stored);

			const derived: number[] = raw.flatMap((w: any) =>
				CHANNELS.map((c) => {
					const x = num(w?.[`${c}_X`]);
					const y = num(w?.[`${c}_Y`]);
					const z = num(w?.[`${c}_Z`]);
					if (x === null || y === null || z === null) return null;
					return num(Math.sqrt(x * x + y * y + z * z));
				}).filter((m): m is number => m !== null)
			);
			if (derived.length) return range(derived);

			const zOnly: number[] = raw.flatMap((w: any) =>
				CHANNELS.map((c) => num(w?.[`${c}_Z`])).filter((z): z is number => z !== null)
			);
			return range(zOnly);
		} catch {
			return { min: null, max: null };
		}
	}

	const mapped = sessions.map((s) => {
		const result = (s.results ?? [])[0] as any;
		const processed = result?.processedData ?? {};
		const wells = s.magResults ?? processed?.magResults ?? null;
		const { min, max } = fieldRange(s.fieldSummary ?? processed?.fieldSummary, wells);

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
			// Field magnitude in gauss — NOT Z alone, despite the legacy key names.
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
