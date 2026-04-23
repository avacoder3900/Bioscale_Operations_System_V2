/**
 * Manufacturing Analysis — the single surface for all runs/failures/timers/FMEA/SPC.
 *
 * Phase 1 shows everything even if datasets are empty — the UI is the ball of
 * clay, we'll carve later as the data set and use patterns stabilize.
 */
import { redirect } from '@sveltejs/kit';
import {
	connectDB, OpentronsRobot, Equipment, AssayDefinition,
	ProcessAnalyticsEvent, SpecLimit, FmeaRecord, SpcSignal, CauseEffectDiagram,
	ManufacturingSettings
} from '$lib/server/db';
import { requirePermission } from '$lib/server/permissions';
import { loadUnifiedRuns } from '$lib/server/analytics/runs-feed.js';
import {
	describe, histogram, paretoFromCounts, capability, imrChart, pChart,
	oneWayAnova, fpy, rty
} from '$lib/server/analytics/stats.js';
import { PROCESS_TYPES, PROCESS_LABELS, inferShift } from '$lib/server/analytics/types.js';
import type { UnifiedRun, GlobalFilters, ProcessType } from '$lib/server/analytics/types.js';
import type { PageServerLoad } from './$types';
import { analysisActions } from './actions.js';

export const config = { maxDuration: 60 };
export const actions = analysisActions;

function parseFilters(url: URL): GlobalFilters {
	const qp = url.searchParams;
	const parseList = (key: string) => {
		const v = qp.get(key);
		if (!v) return null;
		return v.split(',').filter(Boolean);
	};
	const parseDate = (key: string) => {
		const v = qp.get(key);
		if (!v) return null;
		const d = new Date(v);
		return isNaN(d.getTime()) ? null : d;
	};
	// Default date range: last 30 days
	let from = parseDate('from');
	let to = parseDate('to');
	if (!from && !to) {
		to = new Date();
		from = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
	}
	const procs = parseList('processes') as ProcessType[] | null;
	return {
		from,
		to,
		processTypes: procs && procs.length ? procs : null,
		operatorIds: parseList('operators'),
		robotIds: parseList('robots'),
		equipmentIds: parseList('equipment'),
		assayIds: parseList('assays'),
		inputLotBarcodes: parseList('lots'),
		shifts: (parseList('shifts') as any) ?? null
	};
}

export const load: PageServerLoad = async ({ locals, url }) => {
	if (!locals.user) redirect(302, '/login');
	requirePermission(locals.user, 'manufacturing:read');
	await connectDB();

	const filters = parseFilters(url);

	// === Fetch in parallel everything the page needs ===
	const [
		runs, robots, equipment, assays,
		specLimits, fmeaRecords, spcSignals, causeEffectDiagrams,
		manualEvents, settingsDoc
	] = await Promise.all([
		loadUnifiedRuns(filters),
		OpentronsRobot.find({ isActive: { $ne: false } }).select('_id name').lean().catch(() => []),
		Equipment.find({ isActive: { $ne: false } }).select('_id name barcode equipmentType').lean().catch(() => []),
		AssayDefinition.find({ isActive: true }).select('_id name skuCode').lean().catch(() => []),
		SpecLimit.find({ active: true }).lean().catch(() => []),
		FmeaRecord.find({ status: { $in: ['draft', 'active'] } }).sort({ rpn: -1 }).lean().catch(() => []),
		SpcSignal.find({}).sort({ detectedAt: -1 }).limit(200).lean().catch(() => []),
		CauseEffectDiagram.find({ active: true }).lean().catch(() => []),
		ProcessAnalyticsEvent.find(eventFilter(filters)).sort({ occurredAt: -1 }).limit(500).lean().catch(() => []),
		ManufacturingSettings.findById('default').lean().catch(() => null)
	]);

	// Distinct operator list (from union of run operators + manual events)
	const operatorSet = new Map<string, string>();
	for (const r of runs) if (r.operatorId && r.operator) operatorSet.set(r.operatorId, r.operator);
	for (const e of manualEvents as any[]) if (e.operator?._id && e.operator?.username) operatorSet.set(e.operator._id, e.operator.username);
	const operators = Array.from(operatorSet.entries()).map(([id, username]) => ({ id, username }));

	// === Tab aggregations ===
	const overview = buildOverview(runs, spcSignals as any[]);
	const cycleTime = buildCycleTime(runs, specLimits as any[]);
	const yieldFailures = buildYieldFailures(runs, manualEvents as any[]);
	const materialFlow = buildMaterialFlow(runs);
	const compare = buildComparison(runs);
	const signals = buildSpcSummary(spcSignals as any[]);
	const fmeaSummary = buildFmeaSummary(fmeaRecords as any[]);

	// Rejection reason codes (for manual input form + taxonomy editor)
	const rejectionReasonCodes = (((settingsDoc as any)?.rejectionReasonCodes ?? []) as any[]).map((r: any) => ({
		id: r._id ? String(r._id) : r.code ?? '',
		code: r.code ?? '',
		label: r.label ?? '',
		processType: r.processType ?? null,
		category: r.category ?? null,
		severity: r.severity ?? null,
		sortOrder: r.sortOrder ?? 0
	}));

	return {
		filters: {
			...filters,
			from: filters.from?.toISOString() ?? null,
			to: filters.to?.toISOString() ?? null
		},
		filterOptions: {
			processes: PROCESS_TYPES.map(p => ({ id: p, label: PROCESS_LABELS[p] })),
			operators: operators.sort((a, b) => a.username.localeCompare(b.username)),
			robots: (robots as any[]).map(r => ({ id: String(r._id), name: r.name ?? String(r._id) })),
			equipment: (equipment as any[]).map(e => ({ id: String(e._id), name: e.name ?? e.barcode ?? String(e._id), type: e.equipmentType ?? '' })),
			assays: (assays as any[]).map(a => ({ id: String(a._id), name: a.name ?? String(a._id), skuCode: a.skuCode ?? '' }))
		},
		overview,
		cycleTime,
		yieldFailures,
		materialFlow,
		compare,
		spcSignals: signals,
		fmeaSummary,
		manualEvents: (manualEvents as any[]).map(serializeEvent),
		causeEffectDiagrams: (causeEffectDiagrams as any[]).map(serializeCauseEffect),
		specLimits: (specLimits as any[]).map(serializeSpecLimit),
		rejectionReasonCodes,
		runs: runs.map(serializeRun)
	};
};

// ============================================================================
// Filter helpers
// ============================================================================

function eventFilter(f: GlobalFilters): any {
	const q: any = {};
	if (f.from || f.to) q.occurredAt = {};
	if (f.from) q.occurredAt.$gte = f.from;
	if (f.to) q.occurredAt.$lte = f.to;
	if (f.processTypes && f.processTypes.length) q.processType = { $in: f.processTypes };
	if (f.operatorIds && f.operatorIds.length) q['operator._id'] = { $in: f.operatorIds };
	return q;
}

// ============================================================================
// Tab builders
// ============================================================================

function buildOverview(runs: UnifiedRun[], signals: any[]) {
	const totalRuns = runs.length;
	const totalProduced = runs.reduce((s, r) => s + (r.acceptedCount ?? r.actualCount ?? 0), 0);
	const totalScrapped = runs.reduce((s, r) => s + (r.scrapCount ?? 0), 0);
	const totalRejected = runs.reduce((s, r) => s + (r.rejectedCount ?? 0), 0);
	const totalInspected = runs.reduce((s, r) => s + ((r.acceptedCount ?? 0) + (r.rejectedCount ?? 0)), 0);
	const overallFpy = totalInspected > 0 ? (totalInspected - totalRejected) / totalInspected : null;

	// Per-process FPY for RTY
	const stageMap = new Map<ProcessType, { accepted: number; rejected: number }>();
	for (const r of runs) {
		const acc = r.acceptedCount ?? 0, rej = r.rejectedCount ?? 0;
		if (acc + rej === 0) continue;
		const cur = stageMap.get(r.processType) ?? { accepted: 0, rejected: 0 };
		cur.accepted += acc;
		cur.rejected += rej;
		stageMap.set(r.processType, cur);
	}
	const stageYields: { process: ProcessType; fpy: number; n: number }[] = [];
	for (const [p, c] of stageMap) {
		const total = c.accepted + c.rejected;
		stageYields.push({ process: p, fpy: fpy(c.accepted, total), n: total });
	}
	const rtyValue = rty(stageYields.map(s => s.fpy).filter(y => y > 0));

	const openSignals = signals.filter(s => s.status === 'open' || s.status === 'acknowledged' || s.status === 'investigating').length;

	const runsPerProcess: Record<string, number> = {};
	for (const r of runs) runsPerProcess[r.processType] = (runsPerProcess[r.processType] ?? 0) + 1;

	return {
		totalRuns, totalProduced, totalScrapped, totalRejected, totalInspected,
		overallFpy, rty: rtyValue,
		stageYields,
		runsPerProcess,
		openSignals
	};
}

function buildCycleTime(runs: UnifiedRun[], specLimits: any[]) {
	const byProcess = new Map<ProcessType, number[]>();
	for (const r of runs) {
		if (r.cycleTimeMin == null) continue;
		const arr = byProcess.get(r.processType) ?? [];
		arr.push(r.cycleTimeMin);
		byProcess.set(r.processType, arr);
	}
	const perProcess: any[] = [];
	for (const [proc, values] of byProcess) {
		const specs = specLimits.find(s => s.processType === proc && s.metric === 'cycleTime');
		perProcess.push({
			processType: proc,
			label: PROCESS_LABELS[proc],
			descriptive: describe(values),
			histogram: histogram(values, 20),
			imr: imrChart(values),
			capability: capability(values, { LSL: specs?.LSL ?? null, USL: specs?.USL ?? null, target: specs?.target ?? null }),
			specLimits: specs ? { LSL: specs.LSL, USL: specs.USL, target: specs.target, cpkMin: specs.cpkMin ?? 1.33 } : null,
			n: values.length
		});
	}
	return perProcess.sort((a, b) => b.n - a.n);
}

function buildYieldFailures(runs: UnifiedRun[], events: any[]) {
	// Pareto of abort reasons + manual-event rejection codes
	const counts = new Map<string, number>();
	for (const r of runs) {
		if (r.abortReason) counts.set(r.abortReason, (counts.get(r.abortReason) ?? 0) + 1);
	}
	for (const e of events) {
		if (e.rejectionReasonCode) counts.set(e.rejectionReasonCode, (counts.get(e.rejectionReasonCode) ?? 0) + 1);
	}
	const pareto = paretoFromCounts(counts);

	// p-chart: rejection rate per day (wax + reagent carts)
	const byDay = new Map<string, { defects: number; sample: number }>();
	for (const r of runs) {
		if (r.processType !== 'wax' && r.processType !== 'reagent') continue;
		if (!r.startTime) continue;
		const key = r.startTime.toISOString().slice(0, 10);
		const cur = byDay.get(key) ?? { defects: 0, sample: 0 };
		cur.defects += r.rejectedCount ?? 0;
		cur.sample += (r.acceptedCount ?? 0) + (r.rejectedCount ?? 0);
		byDay.set(key, cur);
	}
	const dailySamples = Array.from(byDay.entries())
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([day, s]) => ({ day, defects: s.defects, sampleSize: s.sample }));
	const pChartOut = pChart(dailySamples);

	return {
		pareto,
		dailyRejectionPChart: pChartOut,
		dailyRejectionDays: dailySamples.map(d => d.day)
	};
}

function buildMaterialFlow(runs: UnifiedRun[]) {
	// Map of input lot → runs that consumed it
	const lotUsage = new Map<string, { material: string | null; runs: string[]; totalProduced: number; totalScrapped: number }>();
	for (const r of runs) {
		for (const inp of r.inputLots ?? []) {
			if (!inp.barcode) continue;
			const cur = lotUsage.get(inp.barcode) ?? { material: inp.material ?? null, runs: [], totalProduced: 0, totalScrapped: 0 };
			cur.runs.push(r.runId);
			cur.totalProduced += r.actualCount ?? 0;
			cur.totalScrapped += r.scrapCount ?? 0;
			lotUsage.set(inp.barcode, cur);
		}
	}
	const entries = Array.from(lotUsage.entries()).map(([barcode, data]) => ({
		barcode,
		material: data.material,
		runCount: data.runs.length,
		totalProduced: data.totalProduced,
		totalScrapped: data.totalScrapped,
		yield: data.totalProduced > 0 ? (data.totalProduced - data.totalScrapped) / data.totalProduced : null
	})).sort((a, b) => b.runCount - a.runCount);

	return { lotUsage: entries };
}

function buildComparison(runs: UnifiedRun[]) {
	// Cycle time by operator, by robot
	const byOperator = new Map<string, number[]>();
	const byRobot = new Map<string, number[]>();
	for (const r of runs) {
		if (r.cycleTimeMin == null) continue;
		if (r.operator) {
			const arr = byOperator.get(r.operator) ?? [];
			arr.push(r.cycleTimeMin);
			byOperator.set(r.operator, arr);
		}
		if (r.robotName) {
			const arr = byRobot.get(r.robotName) ?? [];
			arr.push(r.cycleTimeMin);
			byRobot.set(r.robotName, arr);
		}
	}
	const operatorGroups = Array.from(byOperator.entries()).map(([name, values]) => ({ name, descriptive: describe(values) }));
	const robotGroups = Array.from(byRobot.entries()).map(([name, values]) => ({ name, descriptive: describe(values) }));
	const opAnova = operatorGroups.length >= 2 ? oneWayAnova(Array.from(byOperator.values())) : null;
	const robotAnova = robotGroups.length >= 2 ? oneWayAnova(Array.from(byRobot.values())) : null;
	return { operatorGroups, robotGroups, operatorAnova: opAnova, robotAnova };
}

function buildSpcSummary(signals: any[]) {
	const byStatus: Record<string, number> = { open: 0, acknowledged: 0, investigating: 0, closed: 0, dismissed: 0 };
	for (const s of signals) byStatus[s.status] = (byStatus[s.status] ?? 0) + 1;
	const byRule: Record<string, number> = {};
	for (const s of signals) {
		const k = `Rule ${s.rule?.number ?? '?'}`;
		byRule[k] = (byRule[k] ?? 0) + 1;
	}
	return {
		byStatus,
		byRule,
		recent: signals.slice(0, 50).map(s => ({
			id: String(s._id),
			processType: s.processType,
			metric: s.metric,
			chartType: s.chartType,
			ruleNumber: s.rule?.number ?? null,
			ruleDescription: s.rule?.description ?? '',
			detectedAt: s.detectedAt?.toISOString?.() ?? null,
			status: s.status,
			value: s.dataPointValue,
			centerline: s.centerline,
			ucl: s.ucl,
			lcl: s.lcl,
			assignedTo: s.assignedTo?.username ?? null,
			rootCause: s.rootCause ?? null
		}))
	};
}

function buildFmeaSummary(records: any[]) {
	const byProcess = new Map<string, { count: number; maxRpn: number; avgRpn: number; sum: number }>();
	for (const r of records) {
		const cur = byProcess.get(r.processType) ?? { count: 0, maxRpn: 0, avgRpn: 0, sum: 0 };
		cur.count++;
		cur.maxRpn = Math.max(cur.maxRpn, r.rpn ?? 0);
		cur.sum += r.rpn ?? 0;
		cur.avgRpn = cur.sum / cur.count;
		byProcess.set(r.processType, cur);
	}
	return {
		byProcess: Array.from(byProcess.entries()).map(([p, c]) => ({ process: p, ...c })),
		top10: records.slice(0, 10).map(r => ({
			id: String(r._id),
			processType: r.processType,
			failureMode: r.failureMode,
			effect: r.failureEffect ?? '',
			severity: r.severity ?? 0,
			occurrence: r.occurrence ?? 0,
			detection: r.detection ?? 0,
			rpn: r.rpn ?? 0,
			status: r.status
		})),
		all: records.map(r => ({
			id: String(r._id),
			processType: r.processType,
			processStep: r.processStep ?? '',
			failureMode: r.failureMode,
			effect: r.failureEffect ?? '',
			cause: r.cause ?? '',
			currentControls: r.currentControls ?? '',
			severity: r.severity ?? 0,
			occurrence: r.occurrence ?? 0,
			detection: r.detection ?? 0,
			rpn: r.rpn ?? 0,
			classification: r.classification ?? null,
			status: r.status,
			updatedAt: r.updatedAt?.toISOString?.() ?? null
		}))
	};
}

// ============================================================================
// Serializers
// ============================================================================

function serializeRun(r: UnifiedRun): any {
	return {
		runId: r.runId,
		processType: r.processType,
		processLabel: PROCESS_LABELS[r.processType],
		status: r.status,
		operator: r.operator,
		operatorId: r.operatorId,
		robotName: r.robotName,
		deckId: r.deckId,
		startTime: r.startTime?.toISOString() ?? null,
		endTime: r.endTime?.toISOString() ?? null,
		cycleTimeMin: r.cycleTimeMin,
		plannedCount: r.plannedCount,
		actualCount: r.actualCount,
		scrapCount: r.scrapCount,
		rejectedCount: r.rejectedCount,
		acceptedCount: r.acceptedCount,
		inputLots: r.inputLots ?? [],
		outputLotId: r.outputLotId ?? null,
		outputBucketBarcode: r.outputBucketBarcode ?? null,
		assayName: r.assayName ?? null,
		abortReason: r.abortReason ?? null,
		shift: r.startTime ? inferShift(r.startTime) : null,
		createdAt: r.createdAt.toISOString()
	};
}

function serializeEvent(e: any) {
	return {
		id: String(e._id),
		eventType: e.eventType,
		processType: e.processType,
		occurredAt: e.occurredAt?.toISOString?.() ?? null,
		operator: e.operator?.username ?? null,
		operatorId: e.operator?._id ?? null,
		linkedRunId: e.linkedRunId ?? null,
		linkedLotId: e.linkedLotId ?? null,
		linkedEquipmentId: e.linkedEquipmentId ?? null,
		linkedCartridgeIds: e.linkedCartridgeIds ?? [],
		numericValue: e.numericValue ?? null,
		numericUnit: e.numericUnit ?? null,
		categoricalValue: e.categoricalValue ?? null,
		rejectionReasonCode: e.rejectionReasonCode ?? null,
		severity: e.severity ?? null,
		notes: e.notes ?? '',
		attachments: e.attachments ?? [],
		createdAt: e.createdAt?.toISOString?.() ?? null
	};
}

function serializeCauseEffect(d: any) {
	return {
		id: String(d._id),
		processType: d.processType,
		problemStatement: d.problemStatement,
		nodes: (d.nodes ?? []).map((n: any) => ({
			category: n.category,
			cause: n.cause,
			subCauses: n.subCauses ?? [],
			weight: n.weight ?? 0,
			linkedRejectionCodes: n.linkedRejectionCodes ?? []
		})),
		updatedAt: d.updatedAt?.toISOString?.() ?? null
	};
}

function serializeSpecLimit(s: any) {
	return {
		id: String(s._id),
		processType: s.processType,
		metric: s.metric,
		metricLabel: s.metricLabel ?? s.metric,
		unit: s.unit ?? '',
		LSL: s.LSL ?? null,
		USL: s.USL ?? null,
		target: s.target ?? null,
		cpkMin: s.cpkMin ?? 1.33,
		rationale: s.rationale ?? '',
		effectiveFrom: s.effectiveFrom?.toISOString?.() ?? null,
		approvedBy: s.approvedBy?.username ?? null
	};
}
