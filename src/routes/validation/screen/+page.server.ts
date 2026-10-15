import { fail } from '@sveltejs/kit';
import { requirePermission } from '$lib/server/permissions';
import { connectDB, Spu, ValidationSession, Integration, AuditLog, generateId } from '$lib/server/db';
import { callFunction } from '$lib/server/particle';
import { appendSpuJournal } from '$lib/server/spu-journal';
import { loadScreenCriteria } from '$lib/server/screen/ingest';
import { summarizeSession } from '$lib/server/screen/summarize';
import { SCREEN_TREND_IDS, SCREEN_TEST_LABELS, screenTestLabel, trendValue, type ScreenCriteria } from '$lib/server/screen/contract';
import { openJobs } from '$lib/server/chunks';
import type { Actions, PageServerLoad } from './$types';

/**
 * SCREEN — the one-button device screen (firmware v102, plan §2).
 *
 * Press Screen on a unit → BIMS calls the device's `run_screen` cloud function
 * with "<levels>,<reps>" → the device runs its self-test table level by level
 * and publishes `bioscale/screen` events → the webhook assembles them into one
 * validation session (type 'screen') and, when the summary arrives, judges it
 * against `screen_criteria` and writes the unit's validation.screen rollup.
 * This page only triggers and reads; nothing here waits on the device (a full
 * screen is ~75 minutes).
 *
 * run_screen argument "levels,reps,assay" (assay blank = the production assay)
 * and return values (firmware v102 contract):
 *   1  queued            -1 busy (not idle)       -2 cartridge inserted
 *  -3 assay not on device -4 bad arguments        -5 an upload is still in flight
 */
const LEVELS_DEFAULT = '0123';
const REPS_DEFAULT = 3;

function describeReturn(v: number): string | null {
	if (v === -1) return 'The unit is busy (not idle). Wait for it to finish and try again.';
	if (v === -2) return 'A cartridge is inserted. The screen needs an empty slot.';
	if (v === -3) return 'The production assay is not on the device — load it (Load Assay) and try again.';
	if (v === -4) return 'The unit rejected the arguments (levels must be a subset of 0123, repeats 1–9).';
	if (v === -5) return 'The unit is still uploading the previous screen or sweep. Wait a minute and try again.';
	if (v < 0) return `The unit returned ${v}.`;
	return null;
}

export const load: PageServerLoad = async ({ locals, url }) => {
	requirePermission(locals.user, 'spu:read');
	await connectDB();

	const udi = url.searchParams.get('udi')?.trim() || null;
	const metric = url.searchParams.get('metric')?.trim() || 'homerep';

	const [spus, criteria] = await Promise.all([
		Spu.find({ status: { $ne: 'retired' }, 'particleLink.particleDeviceId': { $exists: true, $nin: [null, ''] } })
			.select('_id udi status validation.screen particleLink.particleDeviceId')
			.sort({ udi: 1 })
			.lean() as Promise<any[]>,
		loadScreenCriteria()
	]);

	const q: Record<string, unknown> = { type: 'screen' };
	if (udi) q.spuUdi = udi;
	const sessions = (await ValidationSession.find(q).sort({ startedAt: -1 }).limit(udi ? 60 : 40).lean()) as any[];
	const history = sessions.map((s) => summarizeSession(s, criteria));

	// Per-unit trends: numeric value of each trend id over this unit's completed screens, oldest first.
	let trends: Array<{ id: string; label: string; unit: string; points: Array<{ at: string; value: number; sessionId: string }> }> = [];
	if (udi) {
		const ordered = [...history].reverse();
		trends = SCREEN_TREND_IDS.map((t) => ({
			...t,
			points: ordered.flatMap((h) => {
				const v = trendValue(h.rows, t.id);
				return v != null ? [{ at: h.startedAt ?? h.lastEventAt ?? '', value: v, sessionId: h.id }] : [];
			})
		})).filter((t) => t.points.length > 0);
	}

	// Fleet compare: the latest value of one metric per unit.
	const latestPerUnit = new Map<string, ReturnType<typeof summarizeSession>>();
	const all = udi ? ((await ValidationSession.find({ type: 'screen' }).sort({ startedAt: -1 }).limit(200).lean()) as any[]).map((s) => summarizeSession(s, criteria)) : history;
	for (const h of all) if (h.spuUdi && !latestPerUnit.has(h.spuUdi)) latestPerUnit.set(h.spuUdi, h);
	const compare = [...latestPerUnit.values()]
		.map((h) => {
			const row = h.rows.find((r) => r.id === metric) ?? h.rows.find((r) => r.id === `${metric}1`);
			return { spuUdi: h.spuUdi, spuId: h.spuId, at: h.startedAt, value: trendValue(h.rows, metric), status: row?.status ?? null, sessionId: h.id };
		})
		.filter((c) => c.value != null)
		.sort((a, b) => (a.value as number) - (b.value as number));

	const jobs = await openJobs('screen_record', 20);

	return {
		spus: spus.map((s) => ({ id: s._id, udi: s.udi, status: s.status, screen: s.validation?.screen?.status ?? 'pending', screenAt: s.validation?.screen?.completedAt ? new Date(s.validation.screen.completedAt).toISOString() : null })),
		defaults: { levels: LEVELS_DEFAULT, reps: REPS_DEFAULT },
		filterUdi: udi,
		metric,
		metrics: [...SCREEN_TREND_IDS.map((t) => ({ id: t.id, label: t.label })), ...Object.keys(SCREEN_TEST_LABELS).filter((id) => !SCREEN_TREND_IDS.some((t) => t.id === id)).map((id) => ({ id, label: screenTestLabel(id) }))],
		history: JSON.parse(JSON.stringify(history)),
		trends,
		compare,
		criteria,
		criteriaIds: [...new Set([...Object.keys(SCREEN_TEST_LABELS), ...Object.keys(criteria)])].map((id) => ({ id, label: screenTestLabel(id) })),
		openJobs: jobs
	};
};

export const actions: Actions = {
	/** Fire run_screen on a unit. Returns at once; results arrive by webhook. */
	run: async ({ request, locals }) => {
		requirePermission(locals.user, 'spu:write');
		await connectDB();
		const form = await request.formData();
		const spuId = form.get('spuId')?.toString() ?? '';
		let levels = (form.get('levels')?.toString() ?? LEVELS_DEFAULT).replace(/[^0-3]/g, '');
		levels = [...new Set(levels.split(''))].sort().join('') || LEVELS_DEFAULT;
		const repsRaw = Number(form.get('reps')?.toString() ?? REPS_DEFAULT);
		const reps = Number.isInteger(repsRaw) && repsRaw >= 1 && repsRaw <= 9 ? repsRaw : REPS_DEFAULT;
		if (!spuId) return fail(400, { error: 'Pick a unit' });
		const spu = (await Spu.findById(spuId).select('udi particleLink.particleDeviceId').lean()) as any;
		if (!spu?.particleLink?.particleDeviceId) return fail(400, { error: 'That unit has no Particle device linked' });
		const deviceId = spu.particleLink.particleDeviceId as string;
		// Third field = assay id; blank means the production assay the firmware defaults to.
		const arg = `${levels},${reps},`;
		let rv: number;
		try {
			const r = await callFunction(deviceId, 'run_screen', arg);
			rv = Number(r.return_value);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			if (/not found/i.test(msg)) return fail(400, { error: `The unit has no "run_screen" function — it needs firmware v102.` });
			return fail(502, { error: `Could not reach the unit: ${msg}` });
		}
		const why = describeReturn(rv);
		if (why) return fail(400, { error: why });
		const who = { _id: locals.user!._id, username: locals.user!.username };
		await AuditLog.create({
			_id: generateId(),
			tableName: 'spus',
			recordId: spuId,
			action: 'screen_requested',
			newData: { spuUdi: spu.udi, levels, reps, deviceId },
			changedBy: who.username,
			changedAt: new Date()
		});
		await appendSpuJournal(spuId, `Screen requested (levels ${levels}, ×${reps}) — results arrive from the device as it runs`, who, { source: 'validation', refLabel: 'Screen' });
		return { queued: true, spuUdi: spu.udi, levels, reps };
	},

	/** Operator confirms the buzzer / LED they heard or saw. */
	confirm: async ({ request, locals }) => {
		requirePermission(locals.user, 'spu:write');
		await connectDB();
		const form = await request.formData();
		const sessionId = form.get('sessionId')?.toString() ?? '';
		const id = form.get('id')?.toString() ?? '';
		const passed = form.get('passed')?.toString() === '1';
		if (!sessionId || !['buzz', 'led'].includes(id)) return fail(400, { error: 'Bad confirm' });
		const session = (await ValidationSession.findById(sessionId).select('_id spuId').lean()) as any;
		if (!session) return fail(404, { error: 'Session not found' });
		const now = new Date();
		await ValidationSession.updateOne(
			{ _id: sessionId },
			{
				$pull: { results: { testType: 'operator_confirm', 'rawData.id': id } }
			}
		);
		await ValidationSession.updateOne(
			{ _id: sessionId },
			{
				$push: { results: { _id: generateId(), testType: 'operator_confirm', rawData: { id }, processedData: null, passed, notes: locals.user!.username, createdAt: now } }
			}
		);
		await AuditLog.create({
			_id: generateId(),
			tableName: 'validation_sessions',
			recordId: sessionId,
			action: 'operator_confirm',
			newData: { id, passed },
			changedBy: locals.user!.username,
			changedAt: now
		});
		return { confirmed: id, passed };
	},

	/** Save the BIMS-side limits (Integration doc 'screen_criteria'). */
	saveCriteria: async ({ request, locals }) => {
		requirePermission(locals.user, 'spu:write');
		await connectDB();
		const form = await request.formData();
		const raw = form.get('criteria')?.toString() ?? '{}';
		let parsed: ScreenCriteria;
		try {
			parsed = JSON.parse(raw);
			if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
		} catch (e) {
			return fail(400, { error: `Criteria must be a JSON object keyed by test id: ${e instanceof Error ? e.message : String(e)}` });
		}
		const clean: ScreenCriteria = {};
		for (const [id, c] of Object.entries(parsed)) {
			if (!c || typeof c !== 'object') continue;
			const o: any = {};
			if (c.min != null && c.min !== ('' as any)) o.min = Number(c.min);
			if (c.max != null && c.max !== ('' as any)) o.max = Number(c.max);
			if (c.warnOnly) o.warnOnly = true;
			if (c.ignore) o.ignore = true;
			if (typeof c.label === 'string' && c.label) o.label = c.label;
			if (Object.keys(o).length) clean[id] = o;
		}
		const prev = (await Integration.findOne({ type: 'screen_criteria' }).lean()) as any;
		await Integration.findOneAndUpdate(
			{ type: 'screen_criteria' },
			{ $set: { type: 'screen_criteria', criteria: clean, updatedBy: locals.user!.username, updatedAt: new Date() }, $setOnInsert: { _id: generateId(), isActive: true } },
			{ upsert: true }
		);
		await AuditLog.create({
			_id: generateId(),
			tableName: 'integrations',
			recordId: 'screen_criteria',
			action: 'UPDATE',
			oldData: prev?.criteria ?? null,
			newData: clean,
			changedBy: locals.user!.username,
			changedAt: new Date()
		});
		return { criteriaSaved: true, count: Object.keys(clean).length };
	}
};

export const config = { maxDuration: 60 };
