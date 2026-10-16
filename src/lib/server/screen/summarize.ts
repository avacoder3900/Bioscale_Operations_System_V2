/**
 * One 'screen' validation session → the shape the pages and the CSV export
 * render. Kept out of +page.server.ts because SvelteKit forbids extra exports
 * there (the build fails on them, svelte-check does not catch it).
 */
import { evaluateScreen, type ScreenSessionRaw } from './ingest';
import { screenTestDoc, screenTestRep, baseTestId, type ScreenCriteria } from './contract';

export interface ScreenRowOut {
	/** 1-based position in the device's emission order — the row number on the report. */
	seq: number;
	id: string;
	/** Bare id with the rep stripped (run rows keep their run number). */
	base: string;
	rep: number | null;
	label: string;
	what: string;
	rule: string;
	level: number;
	status: string;
	deviceStatus: string;
	value: number | string | null;
	limit: number | null;
	ms: number;
	note: string | null;
}

export interface ScreenReview {
	by: { _id: string; username: string } | null;
	at: string | null;
	verdict: 'accepted' | 'rejected' | 'rerun' | null;
	notes: string | null;
}

export function summarizeSession(s: any, criteria: ScreenCriteria) {
	const raw = (s.rawData ?? {}) as ScreenSessionRaw;
	const ev = evaluateScreen({ ...raw, parts: raw.parts ?? {}, partsExpected: raw.partsExpected ?? {} }, criteria);
	return {
		id: s._id as string,
		spuId: (s.spuId ?? null) as string | null,
		spuUdi: (s.spuUdi ?? null) as string | null,
		particleDeviceId: (s.particleDeviceId ?? null) as string | null,
		fw: raw.fw ?? null,
		run: raw.run ?? null,
		status: s.status as string,
		startedAt: s.startedAt ? new Date(s.startedAt).toISOString() : null,
		completedAt: s.completedAt ? new Date(s.completedAt).toISOString() : null,
		lastEventAt: raw.lastEventAt ?? null,
		complete: ev.complete,
		overallPassed: ev.overallPassed,
		counts: ev.counts,
		levels: ev.levels,
		failureReasons: ev.failureReasons,
		summary: raw.summary ?? null,
		records: Object.values(raw.records ?? {}).map((r: any) => ({
			runIndex: r.runIndex,
			assayId: r.assayId,
			durationS: r.durationS,
			numberOfReadings: r.numberOfReadings,
			stageCheck: r.stageCheck ?? null,
			background: r.background ?? null
		})),
		rows: ev.rows.map((r, i): ScreenRowOut => {
			const doc = screenTestDoc(r.id);
			return {
				seq: i + 1,
				id: r.id,
				base: baseTestId(r.id),
				rep: screenTestRep(r.id),
				label: r.label,
				what: doc.what,
				rule: doc.rule,
				level: r.level,
				status: r.finalStatus,
				deviceStatus: r.deviceStatus,
				value: r.value,
				limit: r.limit ?? r.criterion?.max ?? r.criterion?.min ?? null,
				ms: r.ms,
				note: r.note
			};
		}),
		override: s.override ?? null,
		review: (s.review
			? { by: s.review.by ?? null, at: s.review.at ? new Date(s.review.at).toISOString() : null, verdict: s.review.verdict ?? null, notes: s.review.notes ?? null }
			: null) as ScreenReview | null,
		operatorConfirms: (s.results ?? []).filter((r: any) => r.testType === 'operator_confirm').map((r: any) => ({ id: r.rawData?.id, passed: r.passed, by: r.notes, at: r.createdAt }))
	};
}

