/**
 * Ignoring SONIC anomalies a person has judged harmless — always with a reason.
 *
 *   one anomaly  results[0].rawData.anomalyIgnores = [{ id, t, t0, t1, fLo, fHi, kind,
 *                step, reason, by, at, removedAt?, removedBy? }] — matched to the
 *                anomaly by time and frequency, so it survives a re-analysis (which
 *                renumbers anomalies)
 *   a rule       sonic_ignore_rules — e.g. "End-of-test beep: steps 47–48" or
 *                "Compression artifact: ≥ 8 kHz"; applies to every SONIC recording
 *
 * Ignored anomalies are kept and shown, but left out of the counts — so a recording
 * whose remaining anomalies are all ignored reads as clean (a baseline candidate).
 * Nothing is deleted: undoing sets removedAt/removedBy. Every change is audited.
 */
import { AuditLog, SonicIgnoreRule, ValidationSession, generateId } from '$lib/server/db';
import { writeProcessed, type Who } from './analyze';
import { summarizeAnomalies, type Anomaly } from './window';

export interface IgnoreRule {
	id: string;
	name: string;
	reason: string;
	kind: string | null;
	stepFrom: number | null;
	stepTo: number | null;
	fMinHz: number | null;
	fMaxHz: number | null;
	by: string | null;
	at: string | null;
}

export interface ManualIgnore {
	id: string;
	t: number;
	t0: number;
	t1: number;
	fLo: number;
	fHi: number;
	kind: string;
	step: number | null;
	reason: string;
	by: string;
	at: string;
	removedAt?: string | null;
	removedBy?: string | null;
}

type Matchable = Pick<Anomaly, 'kind' | 't' | 't0' | 't1' | 'fLo' | 'fHi' | 'step'>;

export function ruleMatches(r: IgnoreRule, a: Matchable): boolean {
	if (r.kind && r.kind !== a.kind) return false;
	if (r.stepFrom != null || r.stepTo != null) {
		if (a.step == null) return false;
		if (r.stepFrom != null && a.step < r.stepFrom) return false;
		if (r.stepTo != null && a.step > r.stepTo) return false;
	}
	if (r.fMinHz != null && a.fLo < r.fMinHz) return false;
	if (r.fMaxHz != null && a.fHi > r.fMaxHz) return false;
	return true;
}

/** Same sound as the one ignored: overlapping in time (±0.25 s) and in frequency (±25 %). */
export function manualMatches(m: ManualIgnore, a: Matchable): boolean {
	return a.t0 <= m.t1 + 0.25 && a.t1 >= m.t0 - 0.25 && a.fLo < m.fHi * 1.25 && a.fHi > m.fLo / 1.25;
}

/** Marks each anomaly ignored (a person's entry first, then rules) or clears the mark. */
export function applyIgnores(anomalies: Anomaly[], manual: ManualIgnore[], rules: IgnoreRule[]): Anomaly[] {
	const live = manual.filter((m) => !m.removedAt);
	return anomalies.map((a) => {
		const m = live.find((x) => manualMatches(x, a));
		if (m) return { ...a, ignored: { source: 'manual', id: m.id, name: null, reason: m.reason, by: m.by, at: m.at } };
		const r = rules.find((x) => ruleMatches(x, a));
		if (r) return { ...a, ignored: { source: 'rule', id: r.id, name: r.name, reason: r.reason, by: r.by, at: r.at } };
		return { ...a, ignored: null };
	});
}

const num = (v: unknown) => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));

export async function loadIgnoreRules(): Promise<IgnoreRule[]> {
	const rows = (await SonicIgnoreRule.find({ removedAt: null }).sort({ createdAt: 1 }).lean()) as any[];
	return rows.map((r) => ({
		id: r._id,
		name: r.name,
		reason: r.reason,
		kind: r.kind ?? null,
		stepFrom: num(r.stepFrom),
		stepTo: num(r.stepTo),
		fMinHz: num(r.fMinHz),
		fMaxHz: num(r.fMaxHz),
		by: r.createdBy?.username ?? null,
		at: r.createdAt ? new Date(r.createdAt).toISOString() : null
	}));
}

async function audit(action: string, tableName: string, recordId: string, who: Who, newData: unknown, oldData: unknown = null) {
	await AuditLog.create({
		_id: generateId(),
		tableName,
		recordId,
		action,
		oldData,
		newData,
		changedBy: who.username,
		changedAt: new Date()
	});
}

async function loadSession(sessionId: string) {
	const s = (await ValidationSession.findById(sessionId).select('type spuUdi results._id results.rawData.anomalyIgnores results.processedData.windowAnalysis.anomalies results.processedData.windowAnalysis.summary').lean()) as any;
	if (!s || s.type !== 'sonic') throw new Error('Sonic recording not found');
	const res = s.results?.[0];
	if (!res?._id) throw new Error('This session has no recording result');
	return { s, res };
}

/** Re-marks one recording's stored anomalies and recounts — no re-analysis. */
export async function refreshIgnores(sessionId: string, rules?: IgnoreRule[]) {
	const { res } = await loadSession(sessionId);
	const wa = res.processedData?.windowAnalysis;
	if (!wa?.anomalies) return null;
	const marked = applyIgnores(wa.anomalies, res.rawData?.anomalyIgnores ?? [], rules ?? (await loadIgnoreRules()));
	const summary = summarizeAnomalies(marked, wa.summary?.referenceCount ?? 0, !!wa.summary?.truncated);
	await writeProcessed(sessionId, res._id, { 'windowAnalysis.anomalies': marked, 'windowAnalysis.summary': summary });
	return summary;
}

/** After a rule change: re-mark every analyzed SONIC recording. */
export async function refreshAllIgnores() {
	const rules = await loadIgnoreRules();
	const rows = (await ValidationSession.find({ type: 'sonic', 'results.0.processedData.windowAnalysis.anomalies': { $exists: true } })
		.select('_id')
		.lean()) as any[];
	for (const r of rows) await refreshIgnores(r._id, rules);
	return rows.length;
}

export async function ignoreAnomaly(sessionId: string, anomalyId: string, reason: string, who: Who) {
	reason = reason.trim();
	if (reason.length < 3) throw new Error('Describe why this anomaly is being ignored');
	const { s, res } = await loadSession(sessionId);
	const a = (res.processedData?.windowAnalysis?.anomalies ?? []).find((x: Anomaly) => x.id === anomalyId) as Anomaly | undefined;
	if (!a) throw new Error('That anomaly is no longer in the analysis — reload the page');
	const entry: ManualIgnore = {
		id: generateId(),
		t: a.t,
		t0: a.t0,
		t1: a.t1,
		fLo: a.fLo,
		fHi: a.fHi,
		kind: a.kind,
		step: a.step,
		reason,
		by: who.username,
		at: new Date().toISOString()
	};
	const list = [...(res.rawData?.anomalyIgnores ?? []), entry];
	await ValidationSession.updateOne({ _id: sessionId, 'results._id': res._id }, { $set: { 'results.$.rawData.anomalyIgnores': list } });
	await audit('sonic_anomaly_ignored', 'validation_sessions', sessionId, who, { spuUdi: s.spuUdi, anomaly: { id: a.id, kind: a.kind, t: a.t, step: a.step, fLo: a.fLo, fHi: a.fHi, deltaDb: a.deltaDb }, reason });
	return refreshIgnores(sessionId);
}

export async function restoreAnomaly(sessionId: string, ignoreId: string, who: Who) {
	const { s, res } = await loadSession(sessionId);
	const list: ManualIgnore[] = res.rawData?.anomalyIgnores ?? [];
	const m = list.find((x) => x.id === ignoreId && !x.removedAt);
	if (!m) throw new Error('That ignore entry is not active');
	const next = list.map((x) => (x.id === ignoreId ? { ...x, removedAt: new Date().toISOString(), removedBy: who.username } : x));
	await ValidationSession.updateOne({ _id: sessionId, 'results._id': res._id }, { $set: { 'results.$.rawData.anomalyIgnores': next } });
	await audit('sonic_anomaly_restored', 'validation_sessions', sessionId, who, { spuUdi: s.spuUdi, ignoreId }, m);
	return refreshIgnores(sessionId);
}

export interface RuleInput {
	name: string;
	reason: string;
	kind: string | null;
	stepFrom: number | null;
	stepTo: number | null;
	fMinHz: number | null;
	fMaxHz: number | null;
}

export async function addIgnoreRule(input: RuleInput, who: Who) {
	const name = input.name.trim();
	const reason = input.reason.trim();
	if (!name) throw new Error('Give the rule a name');
	if (reason.length < 3) throw new Error('Describe why anomalies like this are ignored');
	const r = {
		kind: input.kind || null,
		stepFrom: num(input.stepFrom),
		stepTo: num(input.stepTo),
		fMinHz: num(input.fMinHz),
		fMaxHz: num(input.fMaxHz)
	};
	if (r.kind == null && r.stepFrom == null && r.stepTo == null && r.fMinHz == null && r.fMaxHz == null) {
		throw new Error('A rule needs at least one condition (kind, steps or frequency) — it would ignore everything');
	}
	if (r.stepFrom != null && r.stepTo != null && r.stepFrom > r.stepTo) throw new Error('Step "from" is after step "to"');
	if (r.fMinHz != null && r.fMaxHz != null && r.fMinHz > r.fMaxHz) throw new Error('Minimum frequency is above the maximum');
	const doc = await SonicIgnoreRule.create({ _id: generateId(), name, reason, ...r, createdBy: { _id: who._id, username: who.username }, createdAt: new Date() });
	await audit('sonic_ignore_rule_created', 'sonic_ignore_rules', doc._id, who, { name, reason, ...r });
	const recordings = await refreshAllIgnores();
	return { id: doc._id as string, recordings };
}

export async function removeIgnoreRule(ruleId: string, who: Who) {
	const before = (await SonicIgnoreRule.findById(ruleId).lean()) as any;
	if (!before || before.removedAt) throw new Error('That rule is not active');
	await SonicIgnoreRule.updateOne({ _id: ruleId }, { $set: { removedAt: new Date(), removedBy: { _id: who._id, username: who.username } } });
	await audit('sonic_ignore_rule_removed', 'sonic_ignore_rules', ruleId, who, { removed: true }, { name: before.name, reason: before.reason });
	return { recordings: await refreshAllIgnores() };
}
