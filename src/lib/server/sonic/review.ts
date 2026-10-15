/**
 * SONIC workflow steps 5–6: the operator's trim/verify (or "unusable") and the
 * analysis of the verified window.
 *
 * results[0].rawData.review = {
 *   status: 'verified' | 'unusable', startS?, endS?, reason?, by, at,
 *   history: [earlier reviews]           // a re-verify never loses the old one
 * }
 * results[0].processedData.windowAnalysis = WindowAnalysis + { at, by, referenceSessionIds }
 *
 * The recording itself is never touched. Every change is audited; the analysis
 * summary and "unusable" are journaled on the unit. Advisory only.
 */
import { AssayDefinition, AuditLog, ValidationSession, generateId } from '$lib/server/db';
import { appendSpuJournal } from '$lib/server/spu-journal';
import { analyzeSession, SPECTRO_BUCKET, setReference, writeProcessed, type Who } from './analyze';
import { readGridFile } from './archive';
import { decodeSpectrogram, type Spectrogram } from './spectrogram';
import { buildTimeline, SONIC_ASSAY_ID, type Timeline } from './timeline';
import { analyzeWindow, summarizeAnomalies, type Alignment, type ReferenceTrack, type WindowAnalysis } from './window';
import { applyIgnores, loadIgnoreRules } from './ignore';
import { estimateLandmarks, expectedDurations, measuredDurations, mergeLandmarks, placeFromLandmarks, placementAlignment } from './landmarks';
import type { Landmark } from '$lib/sonic-placement';

/** Shortest window that can hold a meaningful part of the 5-min run. */
export const MIN_WINDOW_S = 30;

let timelineCache: { at: number; tl: Timeline } | null = null;

/** The SONIC assay's 48-step timeline, from its BCODE in assay_definitions (cached 10 min). */
export async function sonicTimeline(): Promise<Timeline> {
	if (timelineCache && Date.now() - timelineCache.at < 600_000) return timelineCache.tl;
	const a = (await AssayDefinition.findById(SONIC_ASSAY_ID).select('BCODE').lean()) as any;
	const code = a?.BCODE?.code;
	if (!Array.isArray(code) || !code.length) throw new Error(`Assay ${SONIC_ASSAY_ID} has no BCODE steps`);
	const tl = buildTimeline(code, SONIC_ASSAY_ID);
	timelineCache = { at: Date.now(), tl };
	return tl;
}

async function audit(action: string, sessionId: string, who: Who, newData: Record<string, unknown>, oldData?: unknown) {
	await AuditLog.create({
		_id: generateId(),
		tableName: 'validation_sessions',
		recordId: sessionId,
		action,
		oldData: oldData ?? null,
		newData,
		changedBy: who.username,
		changedAt: new Date()
	});
}

async function loadSonic(sessionId: string) {
	const s = (await ValidationSession.findById(sessionId).lean()) as any;
	if (!s || s.type !== 'sonic') throw new Error('Sonic recording not found');
	const res = s.results?.[0];
	if (!res?._id) throw new Error('This session has no recording result');
	return { s, res };
}

/** The stored fine spectrogram of a session, or null when it hasn't been built. */
export async function loadSpectrogram(processedData: any): Promise<Spectrogram | null> {
	const meta = processedData?.spectrogram;
	if (!meta?.fileId) return null;
	const bytes = await readGridFile(SPECTRO_BUCKET, meta.fileId);
	return decodeSpectrogram(bytes, { frames: meta.frames, bands: meta.bands, frameS: meta.frameS, t0: meta.t0 });
}

function pushHistory(review: any): any[] {
	if (!review) return [];
	const { history, ...rest } = review;
	return [...(Array.isArray(history) ? history : []), rest];
}

/** Step 5: store the operator's window and run the step-6 analysis on it. */
export async function verifyWindow(sessionId: string, startS: number, endS: number, who: Who) {
	const { s, res } = await loadSonic(sessionId);
	const durationS = res.processedData?.analysis?.durationS ?? res.processedData?.fingerprint?.durationS;
	if (!(durationS > 0)) throw new Error('Analyze the recording before trimming it');
	if (!Number.isFinite(startS) || !Number.isFinite(endS)) throw new Error('Start and end must be numbers of seconds');
	if (startS < 0 || endS > durationS + 0.05) throw new Error(`The window must lie inside the recording (0–${durationS.toFixed(1)} s)`);
	if (endS - startS < MIN_WINDOW_S) throw new Error(`The window must be at least ${MIN_WINDOW_S} s long`);
	const before = res.rawData?.review ?? null;
	const review = {
		status: 'verified',
		startS: Math.round(startS * 100) / 100,
		endS: Math.round(endS * 100) / 100,
		by: who.username,
		at: new Date(),
		history: pushHistory(before)
	};
	await ValidationSession.updateOne({ _id: sessionId, 'results._id': res._id }, { $set: { 'results.$.rawData.review': review } });
	await audit('sonic_window_verified', sessionId, who, { spuUdi: s.spuUdi, startS: review.startS, endS: review.endS }, before ? { status: before.status, startS: before.startS, endS: before.endS } : null);
	return runWindowAnalysis(sessionId, who);
}

/** Step 5 alternative: the recording can't be used (talking, door slam, phone moved…). */
export async function markUnusable(sessionId: string, reason: string, who: Who) {
	const { s, res } = await loadSonic(sessionId);
	const why = reason.trim();
	if (!why) throw new Error('Say why the recording is unusable');
	const before = res.rawData?.review ?? null;
	// An unusable recording must not stay a reference.
	if (res.processedData?.reference?.on) await setReference(sessionId, false, who);
	const review = { status: 'unusable', reason: why.slice(0, 500), by: who.username, at: new Date(), history: pushHistory(before) };
	await ValidationSession.updateOne({ _id: sessionId, 'results._id': res._id }, { $set: { 'results.$.rawData.review': review } });
	await audit('sonic_marked_unusable', sessionId, who, { spuUdi: s.spuUdi, reason: review.reason }, before ? { status: before.status } : null);
	if (s.spuId) {
		await appendSpuJournal(s.spuId, `Sonic recording marked unusable — re-record. Reason: ${review.reason}`, who, {
			source: 'validation',
			refKind: 'validation_session',
			refId: sessionId,
			refLabel: 'Sonic fingerprint'
		});
	}
}

/** Verified SONIC references (other than `excludeId`) that have a spectrogram and a fitted alignment. */
async function referenceTracks(excludeId: string): Promise<ReferenceTrack[]> {
	const rows = (await ValidationSession.find({
		_id: { $ne: excludeId },
		type: 'sonic',
		'results.0.rawData.assay': 'SONIC',
		'results.0.rawData.review.status': 'verified',
		'results.0.processedData.reference.on': true,
		'results.0.processedData.windowAnalysis.alignment': { $exists: true },
		'results.0.processedData.spectrogram.fileId': { $exists: true }
	})
		.select('results.processedData.spectrogram results.processedData.windowAnalysis.alignment')
		.limit(30)
		.lean()) as any[];
	const out: ReferenceTrack[] = [];
	for (const r of rows) {
		const p = r.results?.[0]?.processedData;
		try {
			const spec = await loadSpectrogram(p);
			if (spec) out.push({ id: r._id, spec, alignment: p.windowAnalysis.alignment as Alignment });
		} catch (err) {
			console.warn(`[sonic] reference ${r._id} spectrogram unreadable: ${err instanceof Error ? err.message : String(err)}`);
		}
	}
	return out;
}

/**
 * Step 6 on the verified window:
 *   1. landmarks — the analysis' estimates (sequence-matched to the loud stretches,
 *      using the measured timeline from the other verified recordings), with any
 *      placement a person has saved taking precedence;
 *   2. every step placed from the landmarks (measured durations between them);
 *   3. the anomaly checks and the report, on that placement.
 * `journal: false` skips the unit-journal line (bulk re-analysis).
 */
export async function runWindowAnalysis(sessionId: string, who: Who, opts: { journal?: boolean } = {}) {
	let { s, res } = await loadSonic(sessionId);
	const review = res.rawData?.review;
	if (review?.status !== 'verified') throw new Error('Trim and verify the recording first');
	if (!res.processedData?.spectrogram?.fileId) {
		// Analyzed before the fine spectrogram existed: build it now.
		const r = await analyzeSession(sessionId, who);
		if (!r.ok) throw new Error(`Could not analyze the recording: ${r.error}`);
		({ s, res } = await loadSonic(sessionId));
	}
	const spec = await loadSpectrogram(res.processedData);
	if (!spec) throw new Error('The recording has no spectrogram — re-analyze it');
	const tl = await sonicTimeline();
	const durationS: number = res.processedData?.analysis?.durationS ?? spec.t0 + spec.frames * spec.frameS;

	const measured = await measuredDurations(tl, sessionId);
	const durations = expectedDurations(tl, measured?.durations ?? null);
	const { landmarks: estimates, segments } = estimateLandmarks(spec, tl, review.startS, review.endS, measured?.durations ?? null);
	const saved: Landmark[] | null = res.rawData?.stepPlacement?.landmarks ?? null;
	const landmarks = mergeLandmarks(estimates, saved);
	const placed = placeFromLandmarks(tl, landmarks, durations, durationS);
	const alignment = placementAlignment(spec, tl, placed, review.startS, review.endS);

	const refs = await referenceTracks(sessionId);
	const wa = analyzeWindow(spec, tl, review.startS, review.endS, refs, alignment);
	// Anomalies a person ignored (this recording, or by a rule) stay ignored after re-analysis.
	wa.anomalies = applyIgnores(wa.anomalies, res.rawData?.anomalyIgnores ?? [], await loadIgnoreRules());
	wa.summary = summarizeAnomalies(wa.anomalies, wa.summary.referenceCount, wa.summary.truncated);
	const stored = {
		...wa,
		steps: placed,
		landmarks: { estimates, used: landmarks, segments },
		durations: durations.map((d) => Math.round(d * 100) / 100),
		measured: measured ? { from: measured.from, confirmedOnly: measured.confirmedOnly } : null,
		placement: res.rawData?.stepPlacement?.confirmed
			? { confirmed: true, by: res.rawData.stepPlacement.by ?? null, at: res.rawData.stepPlacement.at ?? null }
			: { confirmed: false },
		at: new Date(),
		by: who.username,
		referenceSessionIds: refs.map((r) => r.id)
	};
	await writeProcessed(sessionId, res._id, { windowAnalysis: stored });
	await audit('sonic_window_analysis', sessionId, who, {
		spuUdi: s.spuUdi,
		window: wa.window,
		alignment: { method: alignment.method, corr: alignment.corr, quality: alignment.quality },
		landmarksFound: estimates.filter((l) => l.found).length,
		landmarksAdjusted: landmarks.filter((l) => l.source === 'user').length,
		measuredFrom: measured?.from ?? 0,
		anomalies: wa.summary.total,
		bySeverity: wa.summary.bySeverity,
		references: refs.length
	});
	if (s.spuId && opts.journal !== false) {
		const { total, bySeverity, stepsWithAnomalies } = wa.summary;
		const line = total
			? `Sonic analysis (advisory): ${total} anomal${total === 1 ? 'y' : 'ies'} — ${bySeverity.high} high, ${bySeverity.medium} medium, ${bySeverity.low} low — in step${stepsWithAnomalies.length === 1 ? '' : 's'} ${stepsWithAnomalies.join(', ')}.`
			: 'Sonic analysis (advisory): no anomalies found in the verified window.';
		const ignoredNote = wa.summary.ignored ? ` ${wa.summary.ignored} more ignored as known harmless.` : '';
		await appendSpuJournal(
			s.spuId,
			`${line}${ignoredNote} Window ${wa.window.startS}–${wa.window.endS} s; steps placed from ${landmarks.length} landmarks (${stored.placement.confirmed ? 'confirmed' : 'estimated'}), fit r = ${alignment.corr}; ${refs.length} reference${refs.length === 1 ? '' : 's'}.`,
			who,
			{ source: 'validation', refKind: 'validation_session', refId: sessionId, refLabel: 'Sonic analysis' }
		);
	}
	return stored;
}

/**
 * A person's step placement: the landmark times they reviewed (adjusted or kept),
 * saved as confirmed, then the window re-analyzed with it. Earlier placements are
 * kept in history; confirmed placements feed the measured timeline.
 */
export async function saveStepPlacement(sessionId: string, landmarks: Landmark[], who: Who) {
	const { s, res } = await loadSonic(sessionId);
	if (res.rawData?.review?.status !== 'verified') throw new Error('Trim and verify the recording first');
	const tl = await sonicTimeline();
	const valid = new Set(tl.steps.filter((x) => x.landmark).map((x) => x.index));
	const clean = landmarks
		.filter((l) => valid.has(Number(l.step)) && Number.isFinite(+l.t0) && Number.isFinite(+l.t1) && +l.t1 > +l.t0)
		.map((l) => ({ step: Number(l.step), t0: Math.round(+l.t0 * 100) / 100, t1: Math.round(+l.t1 * 100) / 100, source: 'user' as const }))
		.sort((a, b) => a.step - b.step);
	if (!clean.length) throw new Error('No landmark times to save');
	for (let k = 1; k < clean.length; k++) {
		if (clean[k].t0 < clean[k - 1].t1 - 0.05) throw new Error(`Step ${clean[k].step} starts before step ${clean[k - 1].step} ends — keep the landmarks in order`);
	}
	const before = res.rawData?.stepPlacement ?? null;
	const history = before ? [...(Array.isArray(before.history) ? before.history : []), { landmarks: before.landmarks, by: before.by, at: before.at }] : [];
	const placement = { landmarks: clean, confirmed: true, by: who.username, at: new Date(), history };
	await ValidationSession.updateOne({ _id: sessionId, 'results._id': res._id }, { $set: { 'results.$.rawData.stepPlacement': placement } });
	await audit('sonic_step_placement_saved', sessionId, who, { spuUdi: s.spuUdi, landmarks: clean.length }, before ? { landmarks: before.landmarks?.length ?? 0, by: before.by } : null);
	return runWindowAnalysis(sessionId, who);
}

/** Drop the saved placement: back to the analysis' estimates. */
export async function resetStepPlacement(sessionId: string, who: Who) {
	const { s, res } = await loadSonic(sessionId);
	const before = res.rawData?.stepPlacement ?? null;
	if (before) {
		await ValidationSession.updateOne({ _id: sessionId, 'results._id': res._id }, { $unset: { 'results.$.rawData.stepPlacement': '' } });
		await audit('sonic_step_placement_reset', sessionId, who, { spuUdi: s.spuUdi }, { landmarks: before.landmarks, by: before.by, at: before.at });
	}
	return runWindowAnalysis(sessionId, who);
}
