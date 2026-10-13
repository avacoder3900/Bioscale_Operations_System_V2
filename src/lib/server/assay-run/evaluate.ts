/**
 * Assay-run validation test — a GROUP of real cartridges run on one unit
 * (DEVICE_SCREEN_PIPELINE_PLAN.md §3.3). Derive-on-read over cartridge_records
 * (sacred, never written here); the result is persisted on the CartridgeGroup
 * and rolled up to spu.validation.assay_run.
 *
 * Per-member metrics come from the Lambda/research `analysis` block when the
 * record carries one (analysis.wells[ch].metrics: f3_w3pre, f3_w4pre,
 * f3_baseline, f3_test, f7_*; expressions.f7_over_f3_test) and are computed
 * from the readings otherwise, using the same scan-group index ranges the
 * Cortisol 6.1 profile declares (W3 pre 0–17, W4 pre 18–35, baseline 36–77,
 * test 78–119 per channel).
 *
 * Bead index = loaded F3 / baseline F3 (the bead-delivery proxy the v5
 * roadmap names: "loaded/baseline F3"). Which metrics play "loaded" and
 * "baseline" is a criteria setting (`beadIndexNum` / `beadIndexDen`, default
 * f3_baseline / f3_w4pre) so Jacob can change the definition without a deploy.
 *
 * Lane C (the in-cartridge zero well) is a VALIDITY control, not a corrector
 * (v5 step-back 4): a cartridge whose lane C fails the fluidics rule is
 * excluded from the group statistics and listed as invalid.
 */

export interface AssayRunCriteria {
	/** Number of complete, valid cartridges the group needs. */
	minRuns: number;
	/** Bead-index window per lane (null = unset). */
	beadIndexMin: number | null;
	beadIndexMax: number | null;
	/** Max CV (%) of the bead index across the group's cartridges, per lane. */
	beadIndexCvMax: number | null;
	/** Result (ratio or quantified value) CV (%) max across the group. */
	resultCvMax: number | null;
	/** Stage check limits per run. */
	stageErrorMaxUm: number | null;
	stageHitsMax: number | null;
	/** Lane C validity: lane-C bead index must be within this fraction of lanes A/B mean (null = off). */
	laneCToleranceFrac: number | null;
	beadIndexNum: string;
	beadIndexDen: string;
	resultExpression: string;
	/** Which lanes count as sample lanes. */
	sampleLanes: string[];
}

export const DEFAULT_ASSAY_RUN_CRITERIA: AssayRunCriteria = {
	minRuns: 3,
	beadIndexMin: null,
	beadIndexMax: null,
	beadIndexCvMax: null,
	resultCvMax: null,
	stageErrorMaxUm: null,
	stageHitsMax: 0,
	laneCToleranceFrac: null,
	beadIndexNum: 'f3_baseline',
	beadIndexDen: 'f3_w4pre',
	resultExpression: 'f7_over_f3_test',
	sampleLanes: ['A', 'B']
};

export function mergeAssayRunCriteria(raw: unknown): AssayRunCriteria {
	const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
	const num = (k: keyof AssayRunCriteria) => {
		const v = r[k];
		if (v == null || v === '') return null;
		const n = Number(v);
		return Number.isFinite(n) ? n : null;
	};
	return {
		...DEFAULT_ASSAY_RUN_CRITERIA,
		minRuns: num('minRuns') ?? DEFAULT_ASSAY_RUN_CRITERIA.minRuns,
		beadIndexMin: num('beadIndexMin'),
		beadIndexMax: num('beadIndexMax'),
		beadIndexCvMax: num('beadIndexCvMax'),
		resultCvMax: num('resultCvMax'),
		stageErrorMaxUm: num('stageErrorMaxUm'),
		stageHitsMax: num('stageHitsMax') ?? DEFAULT_ASSAY_RUN_CRITERIA.stageHitsMax,
		laneCToleranceFrac: num('laneCToleranceFrac'),
		beadIndexNum: typeof r.beadIndexNum === 'string' && r.beadIndexNum ? r.beadIndexNum : DEFAULT_ASSAY_RUN_CRITERIA.beadIndexNum,
		beadIndexDen: typeof r.beadIndexDen === 'string' && r.beadIndexDen ? r.beadIndexDen : DEFAULT_ASSAY_RUN_CRITERIA.beadIndexDen,
		resultExpression: typeof r.resultExpression === 'string' && r.resultExpression ? r.resultExpression : DEFAULT_ASSAY_RUN_CRITERIA.resultExpression,
		sampleLanes: Array.isArray(r.sampleLanes) && r.sampleLanes.length ? r.sampleLanes.map(String) : DEFAULT_ASSAY_RUN_CRITERIA.sampleLanes
	};
}

const SCAN_GROUPS_61: Array<{ label: string; key: string; start: number; end: number }> = [
	{ label: 'W3 Pre', key: 'w3pre', start: 0, end: 17 },
	{ label: 'W4 Pre', key: 'w4pre', start: 18, end: 35 },
	{ label: 'Baseline', key: 'baseline', start: 36, end: 77 },
	{ label: 'Test', key: 'test', start: 78, end: 119 }
];

export interface LaneMetrics {
	metrics: Record<string, number>;
	expressions: Record<string, number>;
	beadIndex: number | null;
	result: number | null;
	source: 'analysis' | 'readings' | 'none';
}

export interface MemberEvaluation {
	cartridgeId: string;
	spuUdi: string | null;
	assayId: string | null;
	status: string | null;
	runAt: string | null;
	complete: boolean;
	lanes: Record<string, LaneMetrics>;
	stageCheck: { endErrorUm: number; limitHits: number; firstHitUm: number; switchFound: boolean } | null;
	quantValue: number | null;
	quantUnit: string | null;
	valid: boolean;
	invalidReasons: string[];
}

function mean(a: number[]): number | null {
	return a.length ? a.reduce((s, v) => s + v, 0) / a.length : null;
}
function cvPct(a: number[]): number | null {
	if (a.length < 2) return null;
	const m = mean(a)!;
	if (m === 0) return null;
	const sd = Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / (a.length - 1));
	return (sd / Math.abs(m)) * 100;
}
const r3 = (v: number | null) => (v == null || !Number.isFinite(v) ? null : Math.round(v * 1000) / 1000);

function laneFromRecord(record: any, ch: string, c: AssayRunCriteria): LaneMetrics {
	const a = record?.analysis?.wells?.[ch];
	let metrics: Record<string, number> = {};
	let expressions: Record<string, number> = {};
	let source: LaneMetrics['source'] = 'none';
	if (a?.metrics && typeof a.metrics === 'object') {
		metrics = Object.fromEntries(Object.entries(a.metrics).filter(([, v]) => typeof v === 'number')) as Record<string, number>;
		expressions = Object.fromEntries(Object.entries(a.expressions ?? {}).filter(([, v]) => typeof v === 'number')) as Record<string, number>;
		source = 'analysis';
	} else {
		const readings: any[] = (record?.rawData?.readings ?? []).filter((r: any) => r?.channel === ch).sort((p: any, q: any) => p.number - q.number);
		if (readings.length) {
			for (const g of SCAN_GROUPS_61) {
				const rs = readings.filter((r) => r.number >= g.start && r.number <= g.end);
				if (!rs.length) continue;
				metrics[`f3_${g.key}`] = Math.round(mean(rs.map((r) => Number(r.f3) || 0))!);
				metrics[`f7_${g.key}`] = Math.round(mean(rs.map((r) => Number(r.f7) || 0))!);
			}
			for (const g of SCAN_GROUPS_61) {
				const f3 = metrics[`f3_${g.key}`],
					f7 = metrics[`f7_${g.key}`];
				if (f3 != null && f7 != null && f3 !== 0) expressions[`f7_over_f3_${g.key}`] = f7 / f3;
			}
			source = 'readings';
		}
	}
	const num = metrics[c.beadIndexNum],
		den = metrics[c.beadIndexDen];
	const beadIndex = num != null && den != null && den !== 0 ? r3(num / den) : null;
	const result = expressions[c.resultExpression] != null ? r3(expressions[c.resultExpression]) : null;
	return { metrics, expressions, beadIndex, result, source };
}

export function evaluateMember(record: any, c: AssayRunCriteria): MemberEvaluation {
	const lanes: Record<string, LaneMetrics> = {};
	for (const ch of ['A', 'B', 'C']) lanes[ch] = laneFromRecord(record, ch, c);
	const sc = record?.rawData?.stageCheck ?? null;
	const stageCheck = sc && typeof sc === 'object'
		? { endErrorUm: Number(sc.endErrorUm) || 0, limitHits: Number(sc.limitHits) || 0, firstHitUm: Number(sc.firstHitUm ?? -1), switchFound: sc.switchFound !== false }
		: null;
	const complete = record?.status === 'completed' || (Array.isArray(record?.rawData?.readings) && record.rawData.readings.length > 0);
	const invalidReasons: string[] = [];
	if (!complete) invalidReasons.push('not run yet');
	const sample = c.sampleLanes.map((l) => lanes[l]?.beadIndex).filter((v): v is number => v != null);
	if (complete && !sample.length) invalidReasons.push('no bead index (no analysis and no readings)');
	if (c.laneCToleranceFrac != null && lanes.C?.beadIndex != null && sample.length) {
		const m = mean(sample)!;
		if (m > 0 && Math.abs(lanes.C.beadIndex - m) / m > c.laneCToleranceFrac) invalidReasons.push(`lane C bead index ${lanes.C.beadIndex} off the sample lanes by more than ${Math.round(c.laneCToleranceFrac * 100)} %`);
	}
	if (stageCheck) {
		if (c.stageHitsMax != null && stageCheck.limitHits > c.stageHitsMax) invalidReasons.push(`${stageCheck.limitHits} limit-switch hits during the run`);
		if (c.stageErrorMaxUm != null && Math.abs(stageCheck.endErrorUm) > c.stageErrorMaxUm) invalidReasons.push(`stage error ${stageCheck.endErrorUm} µm`);
		if (!stageCheck.switchFound) invalidReasons.push('limit switch not found at end of test');
	}
	const quant = record?.analysis?.wells?.A?.quant ?? null;
	const runAt = record?.checkpoints?.completed?.when ?? record?.checkpoints?.underway?.when ?? record?.createdAt ?? null;
	return {
		cartridgeId: String(record?._id ?? ''),
		spuUdi: record?.device?.name ?? null,
		assayId: record?.assayId ?? null,
		status: record?.status ?? null,
		runAt: runAt ? new Date(runAt).toISOString() : null,
		complete,
		lanes,
		stageCheck,
		quantValue: typeof quant?.value === 'number' ? quant.value : null,
		quantUnit: typeof quant?.unit === 'string' ? quant.unit : null,
		valid: complete && invalidReasons.length === 0,
		invalidReasons
	};
}

export interface GroupEvaluation {
	members: MemberEvaluation[];
	n: number;
	nValid: number;
	lanes: Record<string, { beadIndexMean: number | null; beadIndexCv: number | null; resultMean: number | null; resultCv: number | null; n: number }>;
	beadIndexMean: number | null;
	beadIndexCv: number | null;
	resultMean: number | null;
	resultCv: number | null;
	stage: { maxAbsErrorUm: number | null; totalHits: number; runsWithStageCheck: number };
	passed: boolean | null;
	failureReasons: string[];
	criteriaUsed: AssayRunCriteria;
	evaluatedAt: string;
}

export function evaluateGroup(records: any[], c: AssayRunCriteria): GroupEvaluation {
	const members = records.map((r) => evaluateMember(r, c));
	const valid = members.filter((m) => m.valid);
	const lanes: GroupEvaluation['lanes'] = {};
	for (const ch of ['A', 'B', 'C']) {
		const bi = valid.map((m) => m.lanes[ch]?.beadIndex).filter((v): v is number => v != null);
		const rs = valid.map((m) => m.lanes[ch]?.result).filter((v): v is number => v != null);
		lanes[ch] = { beadIndexMean: r3(mean(bi)), beadIndexCv: r3(cvPct(bi)), resultMean: r3(mean(rs)), resultCv: r3(cvPct(rs)), n: bi.length };
	}
	const sampleBi = valid.flatMap((m) => c.sampleLanes.map((l) => m.lanes[l]?.beadIndex)).filter((v): v is number => v != null);
	const sampleRs = valid.flatMap((m) => c.sampleLanes.map((l) => m.lanes[l]?.result)).filter((v): v is number => v != null);
	const errs = members.map((m) => m.stageCheck?.endErrorUm).filter((v): v is number => v != null);
	const stage = {
		maxAbsErrorUm: errs.length ? Math.max(...errs.map(Math.abs)) : null,
		totalHits: members.reduce((s, m) => s + (m.stageCheck?.limitHits ?? 0), 0),
		runsWithStageCheck: members.filter((m) => m.stageCheck).length
	};
	const failureReasons: string[] = [];
	const complete = members.filter((m) => m.complete).length >= c.minRuns;
	if (!complete) failureReasons.push(`${members.filter((m) => m.complete).length}/${c.minRuns} cartridges run`);
	for (const m of members) if (m.complete && !m.valid) failureReasons.push(`${m.cartridgeId}: ${m.invalidReasons.join('; ')}`);
	if (valid.length < c.minRuns) failureReasons.push(`${valid.length}/${c.minRuns} valid cartridges`);
	const biMean = mean(sampleBi),
		biCv = cvPct(sampleBi),
		rsMean = mean(sampleRs),
		rsCv = cvPct(sampleRs);
	if (biMean != null) {
		if (c.beadIndexMin != null && biMean < c.beadIndexMin) failureReasons.push(`bead index ${r3(biMean)} below ${c.beadIndexMin}`);
		if (c.beadIndexMax != null && biMean > c.beadIndexMax) failureReasons.push(`bead index ${r3(biMean)} above ${c.beadIndexMax}`);
	}
	if (c.beadIndexCvMax != null && biCv != null && biCv > c.beadIndexCvMax) failureReasons.push(`bead index CV ${r3(biCv)} % above ${c.beadIndexCvMax} %`);
	if (c.resultCvMax != null && rsCv != null && rsCv > c.resultCvMax) failureReasons.push(`result CV ${r3(rsCv)} % above ${c.resultCvMax} %`);
	const passed = complete ? failureReasons.length === 0 : null;
	return {
		members,
		n: members.length,
		nValid: valid.length,
		lanes,
		beadIndexMean: r3(biMean),
		beadIndexCv: r3(biCv),
		resultMean: r3(rsMean),
		resultCv: r3(rsCv),
		stage,
		passed,
		failureReasons,
		criteriaUsed: c,
		evaluatedAt: new Date().toISOString()
	};
}
