import { requirePermission } from '$lib/server/permissions';
import { connectDB, AssemblySession, Spu, User } from '$lib/server/db';
import type { PageServerLoad } from './$types';

function formatElapsed(ms: number): string {
	if (!Number.isFinite(ms) || ms <= 0) return '0s';
	const totalSec = Math.floor(ms / 1000);
	const hours = Math.floor(totalSec / 3600);
	const minutes = Math.floor((totalSec % 3600) / 60);
	const seconds = totalSec % 60;

	const parts: string[] = [];
	if (hours > 0) parts.push(`${hours}h`);
	if (minutes > 0) parts.push(`${minutes}m`);
	if (seconds > 0) parts.push(`${seconds}s`);
	if (parts.length === 0) return '0s';
	return parts.join(' ');
}

function parseDateParam(raw: string | null): Date | null {
	if (!raw) return null;
	const d = new Date(raw);
	if (Number.isNaN(d.getTime())) return null;
	return d;
}

export const load: PageServerLoad = async ({ url, locals }) => {
	requirePermission(locals.user, 'spu:read');
	await connectDB();

	const operatorUsernameParam = url.searchParams.get('operatorUsername')?.trim() || '';
	const dateFromRaw = url.searchParams.get('dateFrom');
	const dateToRaw = url.searchParams.get('dateTo');
	const dateFrom = parseDateParam(dateFromRaw);
	const dateTo = parseDateParam(dateToRaw);
	// For dateTo, if provided as pure YYYY-MM-DD, include the entire day
	const dateToInclusive = (() => {
		if (!dateTo) return null;
		if (dateToRaw && /^\d{4}-\d{2}-\d{2}$/.test(dateToRaw)) {
			return new Date(dateTo.getTime() + 24 * 60 * 60 * 1000 - 1);
		}
		return dateTo;
	})();

	const query: Record<string, unknown> = {
		status: 'completed',
		completedAt: { $ne: null }
	};

	if (dateFrom || dateToInclusive) {
		const range: Record<string, Date> = {};
		if (dateFrom) range.$gte = dateFrom;
		if (dateToInclusive) range.$lte = dateToInclusive;
		query.completedAt = { $ne: null, ...range };
	}

	const sessions = await AssemblySession.find(query)
		.sort({ completedAt: -1 })
		.limit(500)
		.lean();

	// Collect userIds and spuIds
	const userIds = [
		...new Set(sessions.map((s: any) => s.userId).filter(Boolean) as string[])
	];
	const spuIds = [
		...new Set(sessions.map((s: any) => s.spuId).filter(Boolean) as string[])
	];

	const [users, spus] = await Promise.all([
		userIds.length
			? User.find({ _id: { $in: userIds } }, { username: 1 }).lean()
			: Promise.resolve([] as Array<{ _id: string; username?: string }>),
		spuIds.length
			? Spu.find({ _id: { $in: spuIds } }, { udi: 1 }).lean()
			: Promise.resolve([] as Array<{ _id: string; udi?: string }>)
	]);

	const userMap = new Map<string, string>(
		(users as Array<{ _id: string; username?: string }>).map((u) => [u._id, u.username ?? ''])
	);
	const spuMap = new Map<string, string>(
		(spus as Array<{ _id: string; udi?: string }>).map((s) => [s._id, s.udi ?? ''])
	);

	// Distinct operators list for filter dropdown (based on completed sessions found)
	const distinctOperatorsMap = new Map<string, { userId: string; username: string }>();
	for (const uid of userIds) {
		const uname = userMap.get(uid) ?? '';
		if (uname) {
			distinctOperatorsMap.set(uid, { userId: uid, username: uname });
		}
	}
	const distinctOperators = Array.from(distinctOperatorsMap.values()).sort((a, b) =>
		a.username.localeCompare(b.username)
	);

	// Build rows + apply in-memory operator filter (by username)
	const operatorFilter = operatorUsernameParam;
	const builds = sessions
		.map((s: any) => {
			const startedAt: Date | null = s.startedAt ? new Date(s.startedAt) : null;
			const completedAt: Date | null = s.completedAt ? new Date(s.completedAt) : null;
			const elapsedMs =
				startedAt && completedAt ? completedAt.getTime() - startedAt.getTime() : 0;
			const operatorUsername = s.userId ? userMap.get(s.userId) ?? '' : '';
			const udi = s.spuId ? spuMap.get(s.spuId) ?? '' : '';
			return {
				spuId: s.spuId ?? '',
				udi,
				operatorUsername,
				startedAt: startedAt ? startedAt.toISOString() : null,
				completedAt: completedAt ? completedAt.toISOString() : null,
				elapsedMs,
				elapsedFormatted: formatElapsed(elapsedMs)
			};
		})
		.filter((row) => (operatorFilter ? row.operatorUsername === operatorFilter : true));

	return JSON.parse(
		JSON.stringify({
			builds,
			filters: {
				operatorUsername: operatorUsernameParam || null,
				dateFrom: dateFromRaw || null,
				dateTo: dateToRaw || null
			},
			distinctOperators
		})
	);
};
