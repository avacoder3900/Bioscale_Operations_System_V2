/**
 * SCREEN ingest: level events → one validation_sessions doc (type 'screen')
 * per (device, run); the summary event closes it, evaluates it against the
 * BIMS criteria and writes the unit's validation.screen rollup.
 *
 * Idempotent on (device, run, lvl, part): a redelivered event replaces the
 * rows it carried before, never duplicates them. Events may arrive out of
 * order (Particle does not promise ordering); the session is re-evaluated on
 * every event so the page shows the latest truth.
 */
import { connectDB, Spu, ValidationSession, Integration, AuditLog, generateId } from '$lib/server/db';
import { appendSpuJournal } from '$lib/server/spu-journal';
import { autoEnterValidating } from '$lib/server/spu-auto-validate';
import {
	parseScreenEvent,
	evaluateScreenRows,
	countStatuses,
	SCREEN_LEVEL_NAMES,
	type ScreenCriteria,
	type ScreenRow,
	type ScreenSummaryEvent
} from './contract';
import type { TestPayload } from '$lib/server/test-payload';

export async function loadScreenCriteria(): Promise<ScreenCriteria> {
	const doc = (await Integration.findOne({ type: 'screen_criteria' }).lean()) as any;
	return (doc?.criteria ?? {}) as ScreenCriteria;
}

/** rawData shape of a 'screen' session. */
export interface ScreenSessionRaw {
	fw: number;
	run: number;
	/** parts received, keyed "<lvl>.<part>" → rows */
	parts: Record<string, ScreenRow[]>;
	/** parts the device said exist, keyed by level → of */
	partsExpected: Record<string, number>;
	summary: ScreenSummaryEvent | null;
	/** Level-2 background records (one per assay run), keyed by run index. */
	records?: Record<string, ScreenRecordSummary>;
	firstEventAt: string;
	lastEventAt: string;
}

export interface ScreenRecordSummary {
	runIndex: number;
	assayId: string;
	startTime: number;
	durationS: number;
	numberOfReadings: number;
	stageCheck: TestPayload['stageCheck'];
	/** Per channel mean of clear / F3 / F7 over the whole run (empty-slot background). */
	background: Record<string, { n: number; clear: number; f3: number; f7: number; laser: number }>;
	readings: TestPayload['readings'];
	receivedAt: string;
}

function flattenRows(raw: ScreenSessionRaw): ScreenRow[] {
	const keys = Object.keys(raw.parts).sort((a, b) => {
		const [la, pa] = a.split('.').map(Number);
		const [lb, pb] = b.split('.').map(Number);
		return la - lb || pa - pb;
	});
	return keys.flatMap((k) => raw.parts[k]);
}

export interface ScreenEvaluation {
	rows: ReturnType<typeof evaluateScreenRows>;
	counts: ReturnType<typeof countStatuses>;
	levels: Record<string, { name: string; counts: ReturnType<typeof countStatuses>; complete: boolean }>;
	overallPassed: boolean | null;
	failureReasons: string[];
	complete: boolean;
}

export function evaluateScreen(raw: ScreenSessionRaw, criteria: ScreenCriteria): ScreenEvaluation {
	const rows = evaluateScreenRows(flattenRows(raw), criteria);
	const counts = countStatuses(rows);
	const levels: ScreenEvaluation['levels'] = {};
	const lvls = new Set<number>([...rows.map((r) => r.level), ...Object.keys(raw.partsExpected).map(Number)]);
	for (const lvl of [...lvls].sort()) {
		const lr = rows.filter((r) => r.level === lvl);
		const expected = raw.partsExpected[String(lvl)] ?? 0;
		const got = Object.keys(raw.parts).filter((k) => k.startsWith(`${lvl}.`)).length;
		levels[String(lvl)] = { name: SCREEN_LEVEL_NAMES[lvl] ?? `Level ${lvl}`, counts: countStatuses(lr), complete: expected > 0 && got >= expected };
	}
	// The summary closes the screen. An aborted screen still publishes its
	// summary (with "aborted"), so it is complete too — just failed.
	const aborted = raw.summary?.aborted ?? null;
	const complete = raw.summary != null && (aborted != null || Object.values(levels).every((l) => l.complete));
	const failureReasons = rows.filter((r) => r.finalStatus === 'F').map((r) => `${r.label}${r.value != null ? ` = ${r.value}` : ''}${r.note ? ` (${r.note})` : ''}`);
	if (aborted && !failureReasons.some((f) => f.startsWith('ABORTED'))) failureReasons.push(`ABORTED: ${aborted}`);
	const overallPassed = complete ? failureReasons.length === 0 : null;
	return { rows, counts, levels, overallPassed, failureReasons, complete };
}

export interface IngestResult {
	sessionId: string;
	spuId: string | null;
	spuUdi: string | null;
	complete: boolean;
	overallPassed: boolean | null;
}

/** Apply one `bioscale/screen` event. */
export async function ingestScreenEvent(particleDeviceId: string, data: unknown, publishedAt: Date | null): Promise<IngestResult | { error: string }> {
	const ev = parseScreenEvent(data);
	if (!ev) return { error: 'not a screen event' };
	await connectDB();
	const spu = (await Spu.findOne({ 'particleLink.particleDeviceId': particleDeviceId }).select('_id udi validationResetAt finalizedAt').lean()) as any;
	const at = publishedAt ?? new Date();
	const atIso = at.toISOString();

	let session = (await ValidationSession.findOne({ type: 'screen', particleDeviceId, 'rawData.run': ev.run }).lean()) as any;
	let raw: ScreenSessionRaw;
	let sessionId: string;
	if (!session) {
		sessionId = generateId();
		raw = { fw: ev.fw, run: ev.run, parts: {}, partsExpected: {}, summary: null, firstEventAt: atIso, lastEventAt: atIso };
		await ValidationSession.create({
			_id: sessionId,
			type: 'screen',
			spuId: spu?._id ?? null,
			spuUdi: spu?.udi ?? null,
			particleDeviceId,
			status: 'running',
			startedAt: at,
			testRanAt: at,
			rawData: raw,
			results: []
		});
	} else {
		sessionId = session._id;
		raw = session.rawData as ScreenSessionRaw;
		raw.parts = raw.parts ?? {};
		raw.partsExpected = raw.partsExpected ?? {};
	}
	if (!('rows' in ev)) {
		if (ev.error) return { error: `device refused the screen: ${ev.error}` };
		raw.summary = ev;
	} else {
		raw.parts[`${ev.lvl}.${ev.part}`] = ev.rows;
		raw.partsExpected[String(ev.lvl)] = Math.max(raw.partsExpected[String(ev.lvl)] ?? 0, ev.of);
	}
	raw.fw = ev.fw || raw.fw;
	raw.lastEventAt = atIso;
	if (atIso < raw.firstEventAt) raw.firstEventAt = atIso;

	const criteria = await loadScreenCriteria();
	const evaln = evaluateScreen(raw, criteria);
	const status = evaln.complete ? (evaln.overallPassed ? 'completed' : 'failed') : 'running';
	await ValidationSession.updateOne(
		{ _id: sessionId },
		{
			$set: {
				rawData: raw,
				status,
				completedAt: evaln.complete ? at : null,
				overallPassed: evaln.overallPassed,
				failureReasons: evaln.failureReasons,
				criteriaUsed: criteria,
				results: Object.entries(evaln.levels).map(([lvl, l]) => ({
					_id: generateId(),
					testType: `screen_level_${lvl}`,
					rawData: null,
					processedData: { level: Number(lvl), name: l.name, counts: l.counts, complete: l.complete },
					passed: l.complete ? l.counts.fail === 0 : null,
					notes: null,
					createdAt: at
				}))
			}
		}
	);

	if (evaln.complete && spu && !spu.finalizedAt) {
		const rollupStatus = evaln.overallPassed ? 'passed' : 'failed';
		await Spu.updateOne(
			{ _id: spu._id },
			{
				$set: {
					'validation.screen': {
						status: rollupStatus,
						sessionId,
						completedAt: at,
						testRanAt: new Date(raw.firstEventAt),
						rawData: { fw: raw.fw, run: raw.run, summary: raw.summary },
						results: { counts: evaln.counts, levels: evaln.levels },
						failureReasons: evaln.failureReasons,
						criteriaUsed: criteria
					}
				}
			}
		);
		await autoEnterValidating(spu._id, 'screen');
		await AuditLog.create({
			_id: generateId(),
			tableName: 'spus',
			recordId: spu._id,
			action: 'UPDATE',
			oldData: null,
			newData: { validationType: 'screen', status: rollupStatus, sessionId, counts: evaln.counts, failureReasons: evaln.failureReasons },
			changedAt: at,
			changedBy: 'particle-webhook',
			reason: `SCREEN ${rollupStatus.toUpperCase()} (fw ${raw.fw}, run ${raw.run}): ${evaln.counts.pass} pass / ${evaln.counts.fail} fail / ${evaln.counts.warn} warn`
		});
		await appendSpuJournal(
			spu._id,
			`Screen ${rollupStatus} — ${evaln.counts.pass} pass, ${evaln.counts.fail} fail, ${evaln.counts.warn} warn, ${evaln.counts.skip} skipped (fw ${raw.fw}, run ${raw.run})`,
			{ _id: 'system:particle-webhook', username: 'particle-webhook' },
			{ source: 'validation', refKind: 'validation_session', refId: sessionId, refLabel: 'Screen' }
		);
	}
	return { sessionId, spuId: spu?._id ?? null, spuUdi: spu?.udi ?? null, complete: evaln.complete, overallPassed: evaln.overallPassed };
}

/** Attach a level-2 background record (reassembled `bioscale/screen_record`) to its screen session. */
export async function attachScreenRecord(particleDeviceId: string, run: number, runIndex: number, payload: TestPayload, receivedAt: Date): Promise<{ sessionId: string | null }> {
	await connectDB();
	const session = (await ValidationSession.findOne({ type: 'screen', particleDeviceId, 'rawData.run': run }).select('_id rawData').lean()) as any;
	const background: ScreenRecordSummary['background'] = {};
	for (const ch of ['A', 'B', 'C']) {
		const rs = payload.readings.filter((r) => r.channel === ch);
		const m = (k: 'clear' | 'f3' | 'f7' | 'laser_output') => (rs.length ? rs.reduce((s, r) => s + (r[k] ?? 0), 0) / rs.length : 0);
		background[ch] = { n: rs.length, clear: Math.round(m('clear') * 10) / 10, f3: Math.round(m('f3') * 10) / 10, f7: Math.round(m('f7') * 10) / 10, laser: Math.round(m('laser_output') * 10) / 10 };
	}
	const summary: ScreenRecordSummary = {
		runIndex,
		assayId: payload.assayId,
		startTime: payload.startTime,
		durationS: payload.duration,
		numberOfReadings: payload.numberOfReadings,
		stageCheck: payload.stageCheck,
		background,
		readings: payload.readings,
		receivedAt: receivedAt.toISOString()
	};
	if (!session) {
		// The record beat its screen events (or the screen never published) — park it
		// in a session of its own so the data is never dropped.
		const id = generateId();
		const spu = (await Spu.findOne({ 'particleLink.particleDeviceId': particleDeviceId }).select('_id udi').lean()) as any;
		await ValidationSession.create({
			_id: id,
			type: 'screen',
			spuId: spu?._id ?? null,
			spuUdi: spu?.udi ?? null,
			particleDeviceId,
			status: 'running',
			startedAt: receivedAt,
			rawData: { fw: 0, run, parts: {}, partsExpected: {}, summary: null, records: { [String(runIndex)]: summary }, firstEventAt: receivedAt.toISOString(), lastEventAt: receivedAt.toISOString() },
			results: []
		});
		return { sessionId: id };
	}
	await ValidationSession.updateOne({ _id: session._id }, { $set: { [`rawData.records.${runIndex}`]: summary } });
	return { sessionId: session._id };
}
