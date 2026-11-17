import { fail } from '@sveltejs/kit';
import { requirePermission } from '$lib/server/permissions';
import { connectDB, Spu, ScreenSoak, ValidationSession } from '$lib/server/db';
import { loadScreenCriteria } from '$lib/server/screen/ingest';
import { summarizeSession } from '$lib/server/screen/summarize';
import { startSoak, stopSoak, advanceSoaks, soakRunRows, SOAK_RUNS_PER_BLOCK, SOAK_MINUTES_PER_RUN, SOAK_MAX_RUNS } from '$lib/server/screen/soak';
import type { Actions, PageServerLoad } from './$types';

/**
 * SCREEN SOAK — overnight motion stress test. Chains level-2-only screens
 * (assay motion, ≤5 runs each — the firmware cap) until the target run count.
 * The webhook fires each next block as the previous one's summary lands; this
 * page is the backstop (every load advances any soak stuck between blocks),
 * and it polls while a soak runs.
 */
export const load: PageServerLoad = async ({ locals, url }) => {
	requirePermission(locals.user, 'spu:read');
	await connectDB();

	try {
		await advanceSoaks();
	} catch (err) {
		console.error('[soak] advance on load failed', err);
	}

	const [spus, soaks] = await Promise.all([
		Spu.find({ status: { $ne: 'retired' }, 'particleLink.particleDeviceId': { $exists: true, $nin: [null, ''] } })
			.select('_id udi status')
			.sort({ udi: 1 })
			.lean() as Promise<any[]>,
		ScreenSoak.find({}).sort({ startedAt: -1 }).limit(25).lean() as Promise<any[]>
	]);

	const wanted = url.searchParams.get('id');
	const selected = (wanted ? soaks.find((s) => s._id === wanted) ?? (await ScreenSoak.findById(wanted).lean()) : null) ?? soaks.find((s) => s.status === 'running') ?? soaks[0] ?? null;

	let runs: ReturnType<typeof soakRunRows> = [];
	if (selected) {
		const ids = (selected.blocks ?? []).map((b: any) => b.sessionId).filter(Boolean);
		const criteria = await loadScreenCriteria();
		const sessions = ids.length ? ((await ValidationSession.find({ _id: { $in: ids } }).lean()) as any[]) : [];
		const byId = new Map(sessions.map((s) => [s._id as string, summarizeSession(s, criteria)]));
		runs = soakRunRows(selected.blocks ?? [], byId as any);
	}

	return JSON.parse(
		JSON.stringify({
			spus: spus.map((s) => ({ id: s._id, udi: s.udi, status: s.status })),
			soaks: soaks.map((s) => ({ id: s._id, spuUdi: s.spuUdi, status: s.status, targetRuns: s.targetRuns, runsDone: s.runsDone, startedAt: s.startedAt, endedAt: s.endedAt })),
			selected: selected
				? {
						id: selected._id,
						spuId: selected.spuId,
						spuUdi: selected.spuUdi,
						status: selected.status,
						targetRuns: selected.targetRuns,
						runsDone: selected.runsDone,
						stopOnFail: selected.stopOnFail,
						awaiting: selected.awaiting,
						blocks: selected.blocks ?? [],
						startedAt: selected.startedAt,
						startedBy: selected.startedBy?.username ?? null,
						endedAt: selected.endedAt,
						endReason: selected.endReason,
						lastError: selected.lastError,
						lastAttemptAt: selected.lastAttemptAt
					}
				: null,
			runs,
			limits: { perBlock: SOAK_RUNS_PER_BLOCK, minutesPerRun: SOAK_MINUTES_PER_RUN, maxRuns: SOAK_MAX_RUNS }
		})
	);
};

export const actions: Actions = {
	start: async ({ request, locals }) => {
		requirePermission(locals.user, 'spu:write');
		const form = await request.formData();
		const spuId = form.get('spuId')?.toString() ?? '';
		const targetRuns = Number(form.get('runs')?.toString() ?? '');
		const stopOnFail = form.get('stopOnFail') === 'on';
		if (!spuId) return fail(400, { error: 'Pick a unit' });
		const r = await startSoak({ spuId, targetRuns, stopOnFail, actor: { _id: locals.user!._id, username: locals.user!.username } });
		if (!r.ok) return fail(400, { error: r.error });
		return { started: true, soakId: r.soakId };
	},
	stop: async ({ request, locals }) => {
		requirePermission(locals.user, 'spu:write');
		const form = await request.formData();
		const id = form.get('id')?.toString() ?? '';
		const ok = await stopSoak(id, { _id: locals.user!._id, username: locals.user!.username });
		if (!ok) return fail(400, { error: 'That soak is not running' });
		return { stopped: true };
	}
};
