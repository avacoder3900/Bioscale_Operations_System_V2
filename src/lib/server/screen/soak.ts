/**
 * SCREEN SOAK engine — chains level-2-only screens into one long motion stress
 * test. See models/screen-soak.ts for the why.
 *
 * Flow:
 *   startSoak()           → first block: run_screen("2,<≤5>,<assay>")
 *   device publishes bioscale/screen events → ingest.ts creates the session and
 *     calls tagSoakSession() on creation, then onSoakBlockComplete() when the
 *     summary closes it
 *   onSoakBlockComplete() → records the block, decides done / stop / next, and
 *     fires the next block (retrying briefly while the device returns to idle)
 *   advanceSoaks()        → backstop: any running soak that is not awaiting a
 *     block gets its next block fired. Called from the soak page (which polls
 *     while open) and from the webhook when a soaking device comes online.
 *
 * Every run_screen goes through requestBlock(), which takes a short lease on
 * the soak document first so two invocations can never double-fire.
 */
import { connectDB, ScreenSoak, Spu, ValidationSession, AuditLog, generateId } from '$lib/server/db';
import { callFunction } from '$lib/server/particle';
import { appendSpuJournal } from '$lib/server/spu-journal';

/** Firmware SCREEN_MAX_REPS (brevitest-firmware.h): run_screen refuses more. */
export const SOAK_RUNS_PER_BLOCK = 5;
/** Measured on v108–v110 full screens, 2026-11: run{N}_dur_s ≈ 1623–1648 s. */
export const SOAK_MINUTES_PER_RUN = 27.5;
export const SOAK_MAX_RUNS = 40;
const DEVICE_MODE_IDLE = 0;
const LEASE_MS = 45_000;
/** A block with no session this long after its request is reported as stuck. */
const BLOCK_SILENT_MS = 20 * 60_000;

type Actor = { _id: string; username?: string };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function describeScreenReturn(v: number): string {
	if (v === -1) return 'unit busy (not idle)';
	if (v === -2) return 'a cartridge is inserted';
	if (v === -3) return 'the assay is not on the device';
	if (v === -4) return 'the unit rejected the arguments';
	if (v === -5) return 'an upload is still in flight';
	return `run_screen returned ${v}`;
}
/** Returns that will clear by themselves if we wait. Everything else ends the soak. */
const TRANSIENT = new Set([-1, -5]);

/**
 * Fire the next block if the soak is running and not already awaiting one.
 * `attempts` > 1 retries transient refusals (device still finishing the last
 * block) a few seconds apart — keep the total well under Particle's 20 s
 * webhook timeout when called from the webhook.
 */
export async function requestBlock(soakId: string, attempts = 1): Promise<{ ok: boolean; error?: string }> {
	await connectDB();
	const now = new Date();
	const soak = (await ScreenSoak.findOneAndUpdate(
		{ _id: soakId, status: 'running', awaiting: false, $or: [{ lockUntil: null }, { lockUntil: { $lt: now } }] },
		{ $set: { lockUntil: new Date(now.getTime() + LEASE_MS) } },
		{ new: true }
	).lean()) as any;
	if (!soak) return { ok: false, error: 'not runnable (finished, stopped, already awaiting, or locked)' };

	const release = (set: Record<string, unknown>) => ScreenSoak.updateOne({ _id: soakId }, { $set: { lockUntil: null, lastAttemptAt: new Date(), ...set } });

	const remaining = soak.targetRuns - soak.runsDone;
	if (remaining <= 0) {
		await finishSoak(soakId, 'completed', `All ${soak.targetRuns} runs done`);
		await release({});
		return { ok: true };
	}
	const reps = Math.min(SOAK_RUNS_PER_BLOCK, remaining);

	let lastErr = '';
	// Hard time budget: from the webhook this must finish well inside Particle's
	// 20 s timeout (repeated webhook timeouts get a webhook throttled). Whatever is
	// left undone, advanceSoaks() picks up.
	const deadline = Date.now() + 11_000;
	for (let i = 0; i < attempts; i++) {
		if (i > 0) {
			if (Date.now() + 3500 > deadline) break;
			await sleep(3500);
		}
		try {
			const st = await callFunction(soak.particleDeviceId, 'get_state', '');
			if (st?.return_value !== DEVICE_MODE_IDLE) {
				lastErr = `device not idle (mode ${st?.return_value ?? '?'})`;
				continue;
			}
			const r = await callFunction(soak.particleDeviceId, 'run_screen', `2,${reps},${soak.assayId ?? ''}`);
			const rv = Number(r?.return_value);
			if (rv > 0) {
				await ScreenSoak.updateOne(
					{ _id: soakId },
					{
						$push: { blocks: { requestedAt: new Date(), reps, sessionId: null, completedAt: null, runs: null, failed: null, aborted: null } },
						$set: { awaiting: true, lockUntil: null, lastAttemptAt: new Date(), lastError: null }
					}
				);
				return { ok: true };
			}
			lastErr = describeScreenReturn(rv);
			if (!TRANSIENT.has(rv)) {
				await release({ lastError: lastErr });
				await finishSoak(soakId, 'failed', `Device refused the next block: ${lastErr}`);
				return { ok: false, error: lastErr };
			}
		} catch (err) {
			lastErr = err instanceof Error ? err.message : String(err);
		}
	}
	await release({ lastError: lastErr });
	return { ok: false, error: lastErr };
}

export async function startSoak(opts: { spuId: string; targetRuns: number; stopOnFail: boolean; actor: Actor }): Promise<{ ok: boolean; soakId?: string; error?: string }> {
	await connectDB();
	const targetRuns = Math.round(opts.targetRuns);
	if (!Number.isInteger(targetRuns) || targetRuns < 1 || targetRuns > SOAK_MAX_RUNS) return { ok: false, error: `Runs must be 1–${SOAK_MAX_RUNS}` };
	const spu = (await Spu.findById(opts.spuId).select('_id udi particleLink.particleDeviceId').lean()) as any;
	const deviceId = spu?.particleLink?.particleDeviceId;
	if (!deviceId) return { ok: false, error: 'That unit has no Particle device linked' };
	const existing = await ScreenSoak.findOne({ particleDeviceId: deviceId, status: 'running' }).select('_id').lean();
	if (existing) return { ok: false, error: `${spu.udi} already has a soak running — stop it first` };

	// Refuse up front rather than create a soak that immediately fails.
	try {
		const st = await callFunction(deviceId, 'get_state', '');
		if (st?.return_value !== DEVICE_MODE_IDLE) return { ok: false, error: `${spu.udi} is not idle (mode ${st?.return_value ?? '?'}). Wait for the current operation to finish.` };
	} catch (err) {
		return { ok: false, error: `Could not reach ${spu.udi}: ${err instanceof Error ? err.message : String(err)}` };
	}

	const soakId = generateId();
	await ScreenSoak.create({
		_id: soakId,
		spuId: spu._id,
		spuUdi: spu.udi,
		particleDeviceId: deviceId,
		status: 'running',
		targetRuns,
		stopOnFail: opts.stopOnFail,
		startedAt: new Date(),
		startedBy: { _id: opts.actor._id, username: opts.actor.username }
	});
	const first = await requestBlock(soakId, 1);
	if (!first.ok) {
		await finishSoak(soakId, 'failed', `First block did not start: ${first.error}`);
		return { ok: false, error: `The unit did not start the first block: ${first.error}` };
	}
	await AuditLog.create({
		_id: generateId(),
		tableName: 'screen_soaks',
		recordId: soakId,
		action: 'INSERT',
		newData: { spuId: spu._id, spuUdi: spu.udi, targetRuns, stopOnFail: opts.stopOnFail, deviceId },
		changedAt: new Date(),
		changedBy: opts.actor.username ?? opts.actor._id,
		reason: `Screen soak started on ${spu.udi}: ${targetRuns} assay-motion runs (~${Math.round((targetRuns * SOAK_MINUTES_PER_RUN) / 60 * 10) / 10} h)`
	});
	await appendSpuJournal(spu._id, `Motion soak started — ${targetRuns} assay-motion runs, ~${Math.round((targetRuns * SOAK_MINUTES_PER_RUN) / 60 * 10) / 10} h${opts.stopOnFail ? ', stops on first fail' : ''}`, opts.actor, { source: 'validation', refKind: 'screen_soak', refId: soakId, refLabel: 'Screen soak' });
	return { ok: true, soakId };
}

async function finishSoak(soakId: string, status: 'completed' | 'stopped' | 'failed', reason: string, actor?: Actor) {
	const res = await ScreenSoak.updateOne({ _id: soakId, status: 'running' }, { $set: { status, endedAt: new Date(), endReason: reason } });
	if (res.modifiedCount === 0) return;
	const soak = (await ScreenSoak.findById(soakId).lean()) as any;
	await AuditLog.create({
		_id: generateId(),
		tableName: 'screen_soaks',
		recordId: soakId,
		action: 'UPDATE',
		newData: { status, reason, runsDone: soak?.runsDone },
		changedAt: new Date(),
		changedBy: actor?.username ?? 'system:screen-soak',
		reason: `Screen soak ${status}: ${reason}`
	});
	if (soak?.spuId) {
		await appendSpuJournal(soak.spuId, `Motion soak ${status} after ${soak.runsDone}/${soak.targetRuns} runs — ${reason}`, actor ?? { _id: 'system:screen-soak', username: 'screen-soak' }, { source: 'validation', refKind: 'screen_soak', refId: soakId, refLabel: 'Screen soak' });
	}
}

export async function stopSoak(soakId: string, actor: Actor): Promise<boolean> {
	await connectDB();
	const soak = (await ScreenSoak.findById(soakId).select('status').lean()) as any;
	if (soak?.status !== 'running') return false;
	await finishSoak(soakId, 'stopped', `Stopped by ${actor.username ?? actor._id} (a block already on the device finishes its runs)`, actor);
	return true;
}

/**
 * Called by ingest when it CREATES a screen session: if the device has a soak
 * awaiting a block, this session is that block. Returns the soak id (or null).
 */
export async function tagSoakSession(particleDeviceId: string, sessionId: string): Promise<string | null> {
	// 'stopped' too: a block already on the device when the soak was stopped still
	// belongs to it (and must stay out of the unit's screen rollup). Bounded by the
	// request time so a later, unrelated manual screen is never swallowed.
	const soak = (await ScreenSoak.findOne({ particleDeviceId, status: { $in: ['running', 'stopped'] }, awaiting: true }).sort({ startedAt: -1 }).lean()) as any;
	if (!soak) return null;
	const idx = (soak.blocks ?? []).findIndex((b: any) => !b.sessionId);
	if (idx < 0) return null;
	const age = Date.now() - new Date(soak.blocks[idx].requestedAt).getTime();
	if (!(age >= -60_000 && age < 3 * 60 * 60_000)) return null;
	const res = await ScreenSoak.updateOne({ _id: soak._id, [`blocks.${idx}.sessionId`]: null }, { $set: { [`blocks.${idx}.sessionId`]: sessionId } });
	if (res.modifiedCount === 0) return null;
	await ValidationSession.updateOne({ _id: sessionId }, { $set: { 'rawData.soakId': soak._id } });
	return soak._id;
}

/**
 * Called by ingest every time a soak-tagged session evaluates as complete
 * (redeliveries included — the block is only recorded once).
 */
export async function onSoakBlockComplete(
	soakId: string,
	sessionId: string,
	evaln: { failureReasons: string[]; levels: Record<string, { counts: { pass: number; fail: number; warn: number; skip: number; info: number } }> },
	raw: { parts?: Record<string, unknown>; summary?: { aborted?: string | null } | null },
	opts: { fireNext: boolean } = { fireNext: true }
): Promise<void> {
	const soak = (await ScreenSoak.findById(soakId).lean()) as any;
	if (!soak) return;
	const idx = (soak.blocks ?? []).findIndex((b: any) => b.sessionId === sessionId);
	if (idx < 0 || soak.blocks[idx].completedAt) return;

	const runs = Object.keys(raw.parts ?? {}).filter((k) => /^2[._]/.test(k)).length;
	const failed = evaln.failureReasons.length > 0;
	const aborted = raw.summary?.aborted ?? null;
	const res = await ScreenSoak.updateOne(
		{ _id: soakId, [`blocks.${idx}.completedAt`]: null },
		{
			$set: { [`blocks.${idx}.completedAt`]: new Date(), [`blocks.${idx}.runs`]: runs, [`blocks.${idx}.failed`]: failed, [`blocks.${idx}.aborted`]: aborted, awaiting: false },
			$inc: { runsDone: runs }
		}
	);
	if (res.modifiedCount === 0) return; // a concurrent delivery recorded it
	const runsDone = soak.runsDone + runs;
	if (soak.status !== 'running') return;

	if (failed && soak.stopOnFail) {
		await finishSoak(soakId, 'failed', `Block ${idx + 1} failed: ${evaln.failureReasons.slice(0, 3).join('; ')}`);
		return;
	}
	if (aborted && runs === 0) {
		await finishSoak(soakId, 'failed', `Block ${idx + 1} aborted before any run: ${aborted}`);
		return;
	}
	if (runsDone >= soak.targetRuns) {
		await finishSoak(soakId, 'completed', `All ${soak.targetRuns} runs done${failed ? ' (some blocks had failures)' : ''}`);
		return;
	}
	if (opts.fireNext) await requestBlock(soakId, 3);
}

/**
 * Backstop: fire the next block for any running soak that is idle between
 * blocks (the webhook retry missed it), and report a block the device never
 * answered. Cheap when nothing is running.
 */
export async function advanceSoaks(filter: { particleDeviceId?: string } = {}): Promise<void> {
	await connectDB();
	const running = (await ScreenSoak.find({ status: 'running', ...filter }).select('_id awaiting blocks lastError lastAttemptAt particleDeviceId').lean()) as any[];
	for (const s of running) {
		if (!s.awaiting) {
			await requestBlock(s._id, 1);
			continue;
		}
		const idx = (s.blocks?.length ?? 0) - 1;
		const last = s.blocks?.[idx];
		if (!last?.requestedAt) continue;
		const age = Date.now() - new Date(last.requestedAt).getTime();
		if (!last.sessionId && age > BLOCK_SILENT_MS) {
			const msg = 'No screen data from the device since the last block was requested — check the unit is online and idle';
			if (s.lastError !== msg) await ScreenSoak.updateOne({ _id: s._id }, { $set: { lastError: msg } });
		}
		// Overdue block (device rebooted mid-block, or the summary was lost): if the
		// device is idle, the block is over — close it with what arrived and move on.
		// Only probed well past the block's expected length, and at most every 5 min.
		const overdue = age > (last.reps ?? SOAK_RUNS_PER_BLOCK) * SOAK_MINUTES_PER_RUN * 60_000 + 20 * 60_000;
		const recentlyProbed = s.lastAttemptAt && Date.now() - new Date(s.lastAttemptAt).getTime() < 5 * 60_000;
		if (!overdue || recentlyProbed) continue;
		await ScreenSoak.updateOne({ _id: s._id }, { $set: { lastAttemptAt: new Date() } });
		let idle = false;
		try {
			idle = (await callFunction(s.particleDeviceId, 'get_state', ''))?.return_value === DEVICE_MODE_IDLE;
		} catch {
			/* offline — the spark/status 'online' webhook will retry */
		}
		if (!idle) continue;
		const sess = last.sessionId ? ((await ValidationSession.findById(last.sessionId).select('rawData.parts').lean()) as any) : null;
		const runs = Object.keys(sess?.rawData?.parts ?? {}).filter((k) => /^2[._]/.test(k)).length;
		const res = await ScreenSoak.updateOne(
			{ _id: s._id, [`blocks.${idx}.completedAt`]: null },
			{
				$set: { [`blocks.${idx}.completedAt`]: new Date(), [`blocks.${idx}.runs`]: runs, [`blocks.${idx}.aborted`]: 'interrupted (device idle, no summary)', awaiting: false, lastError: `Block ${idx + 1} was interrupted after ${runs} run(s); continuing` },
				$inc: { runsDone: runs }
			}
		);
		if (res.modifiedCount) await requestBlock(s._id, 1);
	}
}

/** One row per assay-motion run across the whole soak, numbered globally. */
export interface SoakRunRow {
	n: number;
	block: number;
	sessionId: string;
	at: string | null;
	done: string | null;
	hits: number | null;
	err: number | null;
	wellErr: (number | null)[];
	homeMs: number | null;
	travel: number | null;
	durS: number | null;
	tempC: number | null;
	fails: string[];
	warns: string[];
}

export function soakRunRows(
	blocks: Array<{ sessionId: string | null }>,
	sessionsById: Map<string, { rows: Array<{ id: string; value: unknown; status: string; level: number; rep: number | null; label: string }>; records: Array<{ runIndex: number; receivedAt: string | null }> }>
): SoakRunRow[] {
	const out: SoakRunRow[] = [];
	let n = 0;
	blocks.forEach((b, bi) => {
		const s = b.sessionId ? sessionsById.get(b.sessionId) : null;
		if (!s) return;
		const parts = [...new Set(s.rows.filter((r) => r.level === 2 && r.rep != null).map((r) => r.rep as number))].sort((a, c) => a - c);
		for (const part of parts) {
			n++;
			const rr = s.rows.filter((r) => r.level === 2 && r.rep === part);
			const num = (suffix: string) => {
				const r = rr.find((x) => x.id === `run${part}_${suffix}`);
				return typeof r?.value === 'number' ? r.value : null;
			};
			const rec = s.records.find((x) => x.runIndex === part);
			const temp = num('temp');
			out.push({
				n,
				block: bi + 1,
				sessionId: b.sessionId!,
				at: rec?.receivedAt ?? null,
				done: (rr.find((x) => x.id === `run${part}_done`)?.status as string) ?? null,
				hits: num('hits'),
				err: num('err'),
				wellErr: [1, 2, 3, 4, 5, 6].map((w) => num(`w${w}_err`)),
				homeMs: num('home_ms'),
				travel: num('travel'),
				durS: num('dur_s'),
				tempC: temp != null ? temp / 10 : null,
				fails: rr.filter((x) => x.status === 'F').map((x) => x.label),
				warns: rr.filter((x) => x.status === 'W').map((x) => x.label)
			});
		}
	});
	return out;
}
