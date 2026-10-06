import { fail } from '@sveltejs/kit';
import { requirePermission } from '$lib/server/permissions';
import { connectDB, Spu, ValidationSession, User } from '$lib/server/db';
import {
	BENCH,
	BENCH_TYPES,
	FIRMWARE_POSITION_LIMIT_UM,
	FIRMWARE_MAX_SCAN_POINTS,
	parseBenchType,
	runBenchRead,
	type BenchType
} from '$lib/server/optical-bench';
import type { Actions, PageServerLoad } from './$types';

// Read logic, fixed settings and the firmware contract live in
// $lib/server/optical-bench.ts (shared with the fleet-run endpoint).

const BATCHES_SHOWN = 8;

export const load: PageServerLoad = async ({ locals }) => {
	requirePermission(locals.user, 'spu:read');
	await connectDB();

	const spus = (await Spu.find({ status: { $ne: 'retired' }, 'particleLink.particleDeviceId': { $exists: true, $nin: [null, ''] } })
		.select('_id udi status particleLink.particleDeviceId')
		.sort({ udi: 1 })
		.lean()) as any[];

	// Failed sessions only exist for fleet runs (so a batch lists every unit); the
	// history table keeps showing readings only.
	const sessions = (await ValidationSession.find({ type: { $in: BENCH_TYPES }, status: { $ne: 'failed' } })
		.select('_id type spuId spuUdi userId createdAt rawData')
		.sort({ createdAt: -1 })
		.limit(60)
		.lean()) as any[];

	// Fleet runs ("Run on all units"): every session the run created carries
	// rawData.batchId. Newest batches first, every unit's row inside.
	const batchIds = (
		(await ValidationSession.aggregate([
			{ $match: { type: { $in: [...BENCH_TYPES] }, 'rawData.batchId': { $exists: true } } },
			{ $group: { _id: '$rawData.batchId', at: { $min: '$createdAt' } } },
			{ $sort: { at: -1 } },
			{ $limit: BATCHES_SHOWN }
		])) as Array<{ _id: string; at: Date }>
	).map((b) => b._id);
	const batchSessions = batchIds.length
		? ((await ValidationSession.find({ 'rawData.batchId': { $in: batchIds } })
				.select('_id type spuId spuUdi userId createdAt status rawData')
				.sort({ spuUdi: 1 })
				.lean()) as any[])
		: [];

	const userIds = [...new Set([...sessions, ...batchSessions].map((s) => s.userId).filter(Boolean))];
	const users = userIds.length ? ((await User.find({ _id: { $in: userIds } }, { username: 1 }).lean()) as any[]) : [];
	const nameOf = new Map(users.map((u) => [u._id, u.username]));

	const batches = batchIds.map((id) => {
		const rows = batchSessions.filter((s) => s.rawData?.batchId === id);
		const times = rows.map((s) => new Date(s.createdAt).getTime()).filter(Number.isFinite);
		return {
			id,
			type: (rows[0]?.type ?? 'laser') as BenchType,
			by: nameOf.get(rows[0]?.userId) ?? null,
			startedAt: times.length ? new Date(Math.min(...times)).toISOString() : null,
			finishedAt: times.length ? new Date(Math.max(...times)).toISOString() : null,
			rows: rows.map((s) => ({
				id: s._id as string,
				spuId: (s.spuId ?? null) as string | null,
				spuUdi: (s.spuUdi ?? null) as string | null,
				ok: s.status !== 'failed',
				error: (s.rawData?.error ?? null) as string | null,
				at: s.createdAt ? new Date(s.createdAt).toISOString() : null,
				result: s.status !== 'failed' ? (s.rawData ?? null) : null
			}))
		};
	});

	return {
		bench: { ...BENCH, positionLimitUm: FIRMWARE_POSITION_LIMIT_UM, maxScanPoints: FIRMWARE_MAX_SCAN_POINTS },
		spus: spus.map((s) => ({ id: s._id, udi: s.udi, status: s.status, deviceId: s.particleLink?.particleDeviceId ?? null })),
		history: sessions.map((s) => ({
			id: s._id as string,
			type: s.type as BenchType,
			spuId: (s.spuId ?? null) as string | null,
			spuUdi: (s.spuUdi ?? null) as string | null,
			by: nameOf.get(s.userId) ?? null,
			at: s.createdAt ? new Date(s.createdAt).toISOString() : null,
			result: s.rawData ?? null
		})),
		batches: JSON.parse(JSON.stringify(batches))
	};
};

export const actions: Actions = {
	run: async ({ request, locals }) => {
		requirePermission(locals.user, 'spu:write');
		await connectDB();

		const form = await request.formData();
		const num = (k: string, d: number) => {
			const v = Number(form.get(k)?.toString() ?? '');
			return Number.isFinite(v) ? v : d;
		};
		const out = await runBenchRead(
			{
				spuId: form.get('spuId')?.toString() ?? '',
				type: parseBenchType(form.get('type')?.toString()),
				start: num('start', FIRMWARE_POSITION_LIMIT_UM - 4400),
				end: num('end', FIRMWARE_POSITION_LIMIT_UM),
				stepUm: num('stepUm', 400)
			},
			{ _id: locals.user!._id, username: locals.user!.username }
		);
		if (!out.ok) return fail(out.status, { error: out.error });
		return { ran: true, type: out.type, sessionId: out.sessionId, spuUdi: out.spuUdi, result: out.result };
	}
};

export const config = { maxDuration: 60 };
