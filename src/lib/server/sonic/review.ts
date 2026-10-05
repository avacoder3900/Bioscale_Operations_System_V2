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
import { analyzeWindow, type Alignment, type ReferenceTrack, type WindowAnalysis } from './window';

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

/** Step 6: alignment to the 48 steps, anomaly checks and the report, on the verified window. */
export async function runWindowAnalysis(sessionId: string, who: Who): Promise<WindowAnalysis & { at: Date; by: string; referenceSessionIds: string[] }> {
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
	const refs = await referenceTracks(sessionId);
	const wa = analyzeWindow(spec, tl, review.startS, review.endS, refs);
	const stored = { ...wa, at: new Date(), by: who.username, referenceSessionIds: refs.map((r) => r.id) };
	await writeProcessed(sessionId, res._id, { windowAnalysis: stored });
	await audit('sonic_window_analysis', sessionId, who, {
		spuUdi: s.spuUdi,
		window: wa.window,
		alignment: wa.alignment,
		anomalies: wa.summary.total,
		bySeverity: wa.summary.bySeverity,
		references: refs.length
	});
	if (s.spuId) {
		const { total, bySeverity, stepsWithAnomalies } = wa.summary;
		const line = total
			? `Sonic analysis (advisory): ${total} anomal${total === 1 ? 'y' : 'ies'} — ${bySeverity.high} high, ${bySeverity.medium} medium, ${bySeverity.low} low — in step${stepsWithAnomalies.length === 1 ? '' : 's'} ${stepsWithAnomalies.join(', ')}.`
			: 'Sonic analysis (advisory): no anomalies found in the verified window.';
		await appendSpuJournal(
			s.spuId,
			`${line} Window ${wa.window.startS}–${wa.window.endS} s, fit ${wa.alignment.quality} (r = ${wa.alignment.corr}), ${refs.length} reference${refs.length === 1 ? '' : 's'}.`,
			who,
			{ source: 'validation', refKind: 'validation_session', refId: sessionId, refLabel: 'Sonic analysis' }
		);
	}
	return stored;
}
