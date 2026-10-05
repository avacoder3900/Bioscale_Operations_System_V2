/**
 * Server-side sonic analysis (VALIDATION-08). The stored recording is the
 * record; everything here is derived from it and can be recomputed:
 *   analyzeSession  — R2 → decode → fingerprint → results.0.processedData
 *   scoreSession    — advisory verdict vs the hand-picked reference set of the
 *                     same assay; stored on the session + one SPU journal line.
 * Never touches Spu.validation.* or the release gate (advisory in v1).
 */
import { env } from '$env/dynamic/private';
import { ValidationSession, AuditLog, generateId } from '$lib/server/db';
import { downloadFile, getSignedDownloadUrl } from '$lib/server/r2';
import { downloadViaWorker, getR2Url } from '$lib/server/services/r2';
import { appendSpuJournal } from '$lib/server/spu-journal';
import {
	ANALYSIS_VERSION, ENVELOPE_K, SIGMA_FLOOR_DB, SPEC_SIGMA_FLOOR_DB, PASS_INSIDE_PCT, MIN_REFERENCES
} from './constants';
import { decodeRecording, NotAnalyzableError } from './decode';
import { fingerprint, type Fingerprint } from './features';
import { compareFingerprints } from './compare';

export const SONIC_ASSAYS = ['SONIC', 'BCODE', 'OTHER'] as const;
export type SonicAssay = (typeof SONIC_ASSAYS)[number];
export const ASSAY_LABELS: Record<SonicAssay, string> = {
	SONIC: 'SONIC (A78C7989, 5 min motion-only)',
	BCODE: 'BCODE run',
	OTHER: 'Other'
};

export interface Who {
	_id: string;
	username: string;
}

/**
 * The download must finish well inside the action's maxDuration (60 s) so a hung
 * Worker still ends in a stored analysis.error instead of a killed function and a
 * recording that reads "pending" forever.
 */
const DOWNLOAD_TIMEOUT_MS = 25_000;

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(new Error(`${what} timed out after ${Math.round(ms / 1000)} s`)), ms);
	});
	return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Server-side reads go through the Worker (the S3 keys in Vercel are known-bad, and
 * falling back to them only replaced the Worker's real error with a credentials one).
 * The S3 client is used only where no Worker is configured (local dev).
 */
async function fetchRecording(key: string): Promise<Uint8Array> {
	let bytes: Uint8Array;
	if (env.R2_WORKER_URL) {
		bytes = new Uint8Array(await withTimeout(downloadViaWorker(key), DOWNLOAD_TIMEOUT_MS, 'recording download'));
	} else {
		bytes = await withTimeout(
			(async () => {
				const { body } = await downloadFile(key);
				return new Uint8Array(await new Response(body).arrayBuffer());
			})(),
			DOWNLOAD_TIMEOUT_MS,
			'recording download'
		);
	}
	if (!bytes.byteLength) throw new Error('the stored recording is empty (0 bytes)');
	return bytes;
}

/** Playable URL: the Worker's /file/ route when configured, else a presigned S3 URL. */
export async function recordingUrl(key: string): Promise<string | null> {
	try {
		if (env.R2_WORKER_URL) return getR2Url(key);
		return await getSignedDownloadUrl(key, 3600);
	} catch {
		return null;
	}
}

function pd(session: any): Record<string, any> {
	return (session?.results?.[0]?.processedData ?? null) || {};
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

/**
 * Set keys inside results.<resultId>.processedData without rewriting the rest of it,
 * so an analyze that takes a few seconds cannot wipe a reference mark or verdict written
 * meanwhile (a whole-object $set built from a stale read did exactly that). processedData
 * starts as null from the upload and Mongo cannot $set a sub-path under null, so it is
 * first turned into {} — only while it is still null/missing.
 */
async function writeProcessed(sessionId: string, resultId: string, patch: Record<string, unknown>, extra: Record<string, unknown> = {}) {
	await ValidationSession.updateOne(
		{ _id: sessionId, results: { $elemMatch: { _id: resultId, processedData: null } } },
		{ $set: { 'results.$.processedData': {} } }
	);
	const set: Record<string, unknown> = { ...extra };
	for (const [k, v] of Object.entries(patch)) set[`results.$.processedData.${k}`] = v;
	const r = await ValidationSession.updateOne({ _id: sessionId, 'results._id': resultId }, { $set: set });
	if (r.matchedCount === 0) throw new Error('Sonic recording not found');
}

export async function analyzeSession(sessionId: string, who: Who) {
	const s = (await ValidationSession.findById(sessionId).lean()) as any;
	if (!s || s.type !== 'sonic') throw new Error('Sonic recording not found');
	const result = s.results?.[0];
	const raw = result?.rawData ?? {};
	if (!raw.r2Key) throw new Error('This session has no stored recording');

	const started = Date.now();
	let analysis: Record<string, unknown>;
	let fp: Fingerprint | null = null;
	try {
		const bytes = await fetchRecording(raw.r2Key);
		const dec = await decodeRecording(bytes, raw.fileName ?? '');
		fp = fingerprint(dec.samples);
		analysis = {
			version: ANALYSIS_VERSION,
			analyzedAt: new Date(),
			analyzedBy: who.username,
			durationS: fp.durationS,
			sampleRate: fp.sampleRate,
			sourceRate: dec.sourceRate,
			channels: dec.channels,
			decoder: dec.decoder,
			ms: Date.now() - started
		};
	} catch (err) {
		analysis = {
			version: ANALYSIS_VERSION,
			analyzedAt: new Date(),
			analyzedBy: who.username,
			error: err instanceof NotAnalyzableError ? err.message : `analysis failed: ${err instanceof Error ? err.message : String(err)}`
		};
	}
	// A failed RE-analysis (Worker hiccup, timeout) must not wipe a good fingerprint —
	// that would silently drop a reference unit from its reference set. Keep the last
	// good analysis and record the failed attempt beside it instead.
	const hadFingerprint = !!pd(s).fingerprint;
	if (!fp && hadFingerprint) {
		await writeProcessed(sessionId, result._id, { lastFailure: { at: analysis.analyzedAt, by: who.username, error: analysis.error } });
	} else {
		await writeProcessed(sessionId, result._id, { analysis, fingerprint: fp, lastFailure: null });
	}
	await audit('sonic_analysis', sessionId, who, {
		keptPreviousFingerprint: !fp && hadFingerprint,
		spuUdi: s.spuUdi,
		r2Key: raw.r2Key,
		version: ANALYSIS_VERSION,
		ok: !!fp,
		error: (analysis.error as string) ?? null,
		durationS: fp?.durationS ?? null,
		events: fp?.events.length ?? null
	});
	return { ok: !!fp, error: (analysis.error as string) ?? null };
}

export interface LoadedFingerprint {
	id: string;
	spuId: string | null;
	spuUdi: string;
	assay: string | null;
	fileName: string | null;
	at: string | null;
	reference: boolean;
	fp: Fingerprint;
}

/** Sessions with a fingerprint, as compare items. */
export async function loadFingerprints(filter: Record<string, unknown>): Promise<LoadedFingerprint[]> {
	const rows = (await ValidationSession.find({ type: 'sonic', 'results.0.processedData.fingerprint': { $ne: null }, ...filter })
		.select('spuId spuUdi createdAt results')
		.sort({ createdAt: 1 })
		.lean()) as any[];
	return rows
		.filter((r) => r.results?.[0]?.processedData?.fingerprint)
		.map((r) => {
			const res = r.results[0];
			return {
				id: r._id,
				spuId: r.spuId ?? null,
				spuUdi: r.spuUdi ?? '?',
				assay: res.rawData?.assay ?? null,
				fileName: res.rawData?.fileName ?? null,
				at: r.createdAt ? new Date(r.createdAt).toISOString() : null,
				reference: !!res.processedData?.reference?.on,
				fp: res.processedData.fingerprint as Fingerprint
			};
		});
}

export function referenceFilter(assay: string) {
	return { 'results.0.rawData.assay': assay, 'results.0.processedData.reference.on': true };
}

export interface LiveVerdict {
	status: 'scored' | 'insufficient' | 'no-assay' | 'not-analyzed';
	referenceCount: number;
	passed?: number;
	total?: number;
	perSection?: { name: string; a: number; b: number; loudInPct: number; toneInPct: number; pass: boolean }[];
	referenceSessionIds?: string[];
}

/** Score one recording against today's reference set (no writes). */
export async function liveVerdict(sessionId: string): Promise<LiveVerdict> {
	const s = (await ValidationSession.findById(sessionId).lean()) as any;
	const res = s?.type === 'sonic' ? s.results?.[0] : undefined;
	const fp = res?.processedData?.fingerprint as Fingerprint | undefined;
	if (!fp) return { status: 'not-analyzed', referenceCount: 0 };
	const assay = res.rawData?.assay;
	if (!assay) return { status: 'no-assay', referenceCount: 0 };
	const refs = (await loadFingerprints(referenceFilter(assay))).filter((r) => r.id !== sessionId);
	if (refs.length < MIN_REFERENCES) return { status: 'insufficient', referenceCount: refs.length };
	const items = [...refs.map((r) => ({ id: r.id, label: r.spuUdi, fp: r.fp })), { id: sessionId, label: s.spuUdi, fp }];
	const c = compareFingerprints(items, { referenceIds: refs.map((r) => r.id) });
	const mine = c.scores[items.length - 1];
	// scores[i][k] lines up with envelopes[k], not sections[k]: compareFingerprints skips
	// a section with no bins on the shared grid without pushing a score for it.
	const perSection = c.envelopes.map((sec, k) => ({
		name: sec.name,
		a: Math.round(sec.a * 10) / 10,
		b: Math.round(sec.b * 10) / 10,
		loudInPct: Math.round(mine[k]?.loudIn ?? 0),
		toneInPct: Math.round(mine[k]?.specIn ?? 0),
		pass: !!mine[k]?.pass
	}));
	return {
		status: 'scored',
		referenceCount: refs.length,
		passed: perSection.filter((p) => p.pass).length,
		total: perSection.length,
		perSection,
		referenceSessionIds: refs.map((r) => r.id)
	};
}

/** Store the advisory verdict on the session and journal it. Returns the verdict (or why not). */
export async function scoreSession(sessionId: string, who: Who) {
	const v = await liveVerdict(sessionId);
	if (v.status !== 'scored') return v;
	// 0/0 would store passed:true with nothing checked.
	if (!v.total) throw new Error('No sections to score — this recording shares no running stretch with the reference set');
	const s = (await ValidationSession.findById(sessionId).lean()) as any;
	if (!s?.results?.[0]) throw new Error('Sonic recording not found');
	const res = s.results[0];
	const assay = res.rawData?.assay;
	const allPass = v.passed === v.total;
	const failureReasons = v.perSection!
		.filter((p) => !p.pass)
		.map((p) => `${p.name} ${p.a.toFixed(0)}–${p.b.toFixed(0)}s: loudness shape ${p.loudInPct}% inside, tone colour ${p.toneInPct}% inside`);
	const verdict = {
		at: new Date(),
		by: who.username,
		assay,
		referenceSessionIds: v.referenceSessionIds,
		passedSections: v.passed,
		totalSections: v.total,
		perSection: v.perSection,
		advisory: true
	};
	await writeProcessed(sessionId, res._id, { verdict }, {
		'results.$.passed': allPass,
		overallPassed: allPass,
		failureReasons,
		criteriaUsed: {
			kind: 'sonic_reference_envelope',
			envelopeK: ENVELOPE_K,
			sigmaFloorDb: SIGMA_FLOOR_DB,
			specSigmaFloorDb: SPEC_SIGMA_FLOOR_DB,
			passInsidePct: PASS_INSIDE_PCT,
			assay,
			referenceSessionIds: v.referenceSessionIds,
			analysisVersion: ANALYSIS_VERSION,
			advisory: true
		}
	});
	await audit('sonic_verdict', sessionId, who, { spuUdi: s.spuUdi, assay, passed: v.passed, total: v.total, references: v.referenceCount, failureReasons }, pd(s).verdict ?? null);
	if (s.spuId) {
		await appendSpuJournal(
			s.spuId,
			`Sonic: ${v.passed}/${v.total} sections pass vs ${v.referenceCount} ${assay} references (advisory)` +
				(failureReasons.length ? `\nOutside the band: ${failureReasons.map((r) => r.split(':')[0]).join(', ')}` : ''),
			who,
			{ source: 'validation', refKind: 'validation_session', refId: sessionId, refLabel: 'Sonic verdict' }
		);
	}
	return v;
}

export async function setReference(sessionId: string, on: boolean, who: Who) {
	const s = (await ValidationSession.findById(sessionId).lean()) as any;
	if (!s || s.type !== 'sonic') throw new Error('Sonic recording not found');
	const res = s.results?.[0];
	if (!res?._id) throw new Error('This session has no recording result');
	if (on && !res.processedData?.fingerprint) throw new Error('Analyze the recording before using it as a reference');
	if (on && !res.rawData?.assay) throw new Error('Set the assay before using it as a reference');
	const before = pd(s).reference ?? null;
	// Already in that state: keep who/when actually set it, and no duplicate audit row.
	if (!!before?.on === on) return;
	const reference = { on, by: who.username, at: new Date() };
	await writeProcessed(sessionId, res._id, { reference });
	await audit(on ? 'sonic_reference_set' : 'sonic_reference_cleared', sessionId, who, { spuUdi: s.spuUdi, assay: res.rawData?.assay ?? null }, before);
}

export async function setAssay(sessionId: string, assay: SonicAssay, who: Who) {
	const s = (await ValidationSession.findById(sessionId).lean()) as any;
	if (!s || s.type !== 'sonic') throw new Error('Sonic recording not found');
	const res = s.results?.[0];
	if (!res?._id) throw new Error('This session has no recording result');
	const before = res.rawData?.assay ?? null;
	if (before === assay) return;
	const update: Record<string, unknown> = { 'results.$.rawData.assay': assay };
	// A reference only counts for its own assay — changing the assay drops the reference mark,
	// in the same update so it is never a reference under the wrong assay. processedData is an
	// object whenever reference.on is set, so the sub-path $set is safe.
	if (pd(s).reference?.on) update['results.$.processedData.reference'] = { on: false, by: who.username, at: new Date() };
	await ValidationSession.updateOne({ _id: sessionId, 'results._id': res._id }, { $set: update });
	await audit('sonic_assay_set', sessionId, who, { spuUdi: s.spuUdi, assay }, { assay: before });
}
