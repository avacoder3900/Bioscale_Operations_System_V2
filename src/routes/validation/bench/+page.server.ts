import { fail } from '@sveltejs/kit';
import { requirePermission } from '$lib/server/permissions';
import { connectDB, Spu, ValidationSession, User, AuditLog, generateId } from '$lib/server/db';
import { callFunction, getVariable } from '$lib/server/particle';
import { appendSpuJournal } from '$lib/server/spu-journal';
import type { Actions, PageServerLoad } from './$types';

/**
 * Optical bench (2026-09-17 plan): cartridge-free reads. The stage carries the
 * sensors and the lasers are fixed, so at the right stage position each sensor
 * sits directly in its laser's beam.
 *
 *  - laser  — lasers on, all ten AS7341 bands + photodiode per channel
 *  - dark   — same read with the lasers off (ambient / leakage)
 *  - scan   — photodiode + clear vs. stage position, to FIND the laser position
 *
 * Firmware v96 exposes cloud functions `laser_read` / `dark_read` / `laser_scan`
 * (deferred to the device main loop; the function returns the seq the result
 * will carry) and parks the result JSON in the `optical_bench` variable. BIMS
 * calls the function, polls the variable until that seq shows up, and stores
 * the result as a validation session against the unit. Contract:
 * brevitest-device/firmware/Docs/V96_BLANK_SONIC_LASER_HANDOFF.md, Change 6.
 */
const BENCH_TYPES = ['laser', 'dark', 'laser_scan'] as const;
type BenchType = (typeof BENCH_TYPES)[number];
const FN: Record<BenchType, string> = { laser: 'laser_read', dark: 'dark_read', laser_scan: 'laser_scan' };
const BANDS = ['f1', 'f2', 'f3', 'f4', 'f5', 'f6', 'f7', 'f8', 'clear', 'nir'] as const;
const POLL_EVERY_MS = 1500;
const POLL_MAX = 24; // 36 s — a re-home + move + three reads is well under that

function describeReturn(v: number): string | null {
	if (v === -1) return 'The unit is busy (not idle). Wait for it to finish and try again.';
	if (v === -2) return 'A cartridge is inserted. The bench reads need an empty slot.';
	if (v === -3) return 'The unit rejected the arguments (position outside the stage travel, or too many scan points).';
	if (v < 0) return `The unit returned ${v}.`;
	return null;
}

export const load: PageServerLoad = async ({ locals }) => {
	requirePermission(locals.user, 'spu:read');
	await connectDB();

	const spus = (await Spu.find({ status: { $ne: 'retired' }, 'particleLink.particleDeviceId': { $exists: true, $nin: [null, ''] } })
		.select('_id udi status')
		.sort({ udi: 1 })
		.lean()) as any[];

	const sessions = (await ValidationSession.find({ type: { $in: BENCH_TYPES } })
		.select('_id type spuId spuUdi userId createdAt rawData')
		.sort({ createdAt: -1 })
		.limit(60)
		.lean()) as any[];
	const userIds = [...new Set(sessions.map((s) => s.userId).filter(Boolean))];
	const users = userIds.length ? ((await User.find({ _id: { $in: userIds } }, { username: 1 }).lean()) as any[]) : [];
	const nameOf = new Map(users.map((u) => [u._id, u.username]));

	// The position each unit last used for a laser read — the found alignment.
	const lastPos = new Map<string, number>();
	for (const s of sessions) {
		if (s.type === 'laser' && s.spuId && !lastPos.has(s.spuId) && typeof s.rawData?.pos === 'number') lastPos.set(s.spuId, s.rawData.pos);
	}

	return {
		spus: spus.map((s) => ({ id: s._id, udi: s.udi, status: s.status, lastLaserPos: lastPos.get(s._id) ?? null })),
		history: sessions.map((s) => ({
			id: s._id as string,
			type: s.type as BenchType,
			spuId: (s.spuId ?? null) as string | null,
			spuUdi: (s.spuUdi ?? null) as string | null,
			by: nameOf.get(s.userId) ?? null,
			at: s.createdAt ? new Date(s.createdAt).toISOString() : null,
			result: s.rawData ?? null
		}))
	};
};

export const actions: Actions = {
	run: async ({ request, locals }) => {
		requirePermission(locals.user, 'spu:write');
		await connectDB();

		const form = await request.formData();
		const spuId = form.get('spuId')?.toString() ?? '';
		const typeRaw = form.get('type')?.toString() ?? 'laser';
		const type = (BENCH_TYPES as readonly string[]).includes(typeRaw) ? (typeRaw as BenchType) : 'laser';
		const num = (k: string, d: number) => {
			const v = Number(form.get(k)?.toString() ?? '');
			return Number.isFinite(v) ? v : d;
		};
		const pos = num('pos', 21000);
		const gain = num('gain', 1);
		const astep = num('astep', 499);
		const atime = num('atime', 49);
		const start = num('start', pos - 2000);
		const end = num('end', pos + 2000);
		const stepUm = num('stepUm', 400);

		if (!spuId) return fail(400, { error: 'Pick a unit' });
		const spu = (await Spu.findById(spuId).select('udi particleLink.particleDeviceId').lean()) as any;
		if (!spu?.particleLink?.particleDeviceId) return fail(400, { error: 'That unit has no Particle device linked' });
		const deviceId = spu.particleLink.particleDeviceId as string;

		const arg =
			type === 'laser_scan'
				? [start, end, stepUm, gain, astep, atime].join(',')
				: [pos, gain, astep, atime].join(',');

		// 1. Trigger. The function returns the seq the result will carry.
		let seq: number;
		try {
			const r = await callFunction(deviceId, FN[type], arg);
			seq = Number(r.return_value);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			if (/not found/i.test(msg)) {
				return fail(400, { error: `The unit has no "${FN[type]}" function — it needs firmware v96.` });
			}
			return fail(502, { error: `Could not reach the unit: ${msg}` });
		}
		const why = describeReturn(seq);
		if (why) return fail(400, { error: why });

		// 2. Poll the variable until that seq shows up (or the device reports an error).
		let result: any = null;
		for (let i = 0; i < POLL_MAX; i++) {
			await new Promise((r) => setTimeout(r, POLL_EVERY_MS));
			try {
				const v = await getVariable(deviceId, 'optical_bench');
				const raw = typeof v?.result === 'string' ? v.result : '';
				if (!raw) continue;
				const parsed = JSON.parse(raw);
				if (Number(parsed?.seq) === seq) {
					result = parsed;
					break;
				}
			} catch {
				// transient — keep polling
			}
		}
		if (!result) return fail(504, { error: `The unit accepted the request (seq ${seq}) but no result arrived within ${(POLL_MAX * POLL_EVERY_MS) / 1000} s. Check the device log.` });
		if (result.error) return fail(400, { error: `The unit reported: ${result.error}` });

		// 3. Store it against the unit as validation data.
		const who = { _id: locals.user!._id, username: locals.user!.username };
		const now = new Date();
		const sessionId = generateId();
		const rawData = { ...result, requested: { type, pos, gain, astep, atime, start, end, stepUm }, bands: BANDS };
		await ValidationSession.create({
			_id: sessionId,
			type,
			spuId,
			spuUdi: spu.udi,
			particleDeviceId: deviceId,
			status: 'completed',
			startedAt: now,
			completedAt: now,
			userId: who._id,
			rawData,
			results: [{ _id: generateId(), testType: type, rawData: result, processedData: null, passed: null, createdAt: now }]
		});
		await AuditLog.create({
			_id: generateId(),
			tableName: 'validation_sessions',
			recordId: sessionId,
			action: 'optical_bench_read',
			newData: { spuId, spuUdi: spu.udi, type, seq, arg },
			changedBy: who.username,
			changedAt: now
		});
		const summary =
			type === 'laser_scan'
				? `Laser position scan ${start}–${end} µm (step ${stepUm})`
				: `${type === 'dark' ? 'Dark read' : 'Laser-into-sensor read'} at ${result.pos ?? pos} µm, gain ${result.gain ?? gain}` +
					(Array.isArray(result.ch) ? ` — pd A/B/C ${result.ch.map((c: any) => c.pd ?? '—').join('/')}` : '');
		await appendSpuJournal(spuId, `Optical bench: ${summary}`, who, { source: 'validation', refKind: 'validation_session', refId: sessionId, refLabel: 'Optical bench' });

		return { ran: true, type, sessionId, spuUdi: spu.udi, result };
	}
};

export const config = { maxDuration: 60 };
