/**
 * IN-MEMORY ONLY — NOTHING WRITES TO MONGO.
 *
 * Generates a full analytics-page data payload filled with fabricated runs,
 * operators, equipment, FMEA entries, SPC signals, etc. Shape matches the
 * real /manufacturing/analysis load function's return so the same
 * +page.svelte can render it verbatim.
 *
 * Deterministic (seeded RNG) so the view is stable across reloads and
 * browser sessions. Cached at module scope — first request pays the
 * generation cost, subsequent requests return the same object reference.
 */
import {
	describe, histogram, paretoFromCounts, capability, imrChart, pChart,
	oneWayAnova, fpy, rty
} from './stats.js';
import { PROCESS_LABELS, inferShift } from './types.js';
import type { ProcessType } from './types.js';

// ============================================================================
// Seeded RNG (Linear Congruential Generator) — deterministic output
// ============================================================================

function createRng(seed: number) {
	let s = seed >>> 0;
	return {
		next: () => {
			s = (Math.imul(s, 1103515245) + 12345) & 0x7fffffff;
			return s / 0x7fffffff;
		}
	};
}

const rng = createRng(2026_04_23);
const rand = () => rng.next();
const randInt = (min: number, max: number) => Math.floor(rand() * (max - min + 1)) + min;
const pick = <T>(arr: T[]): T => arr[Math.floor(rand() * arr.length)];
// Approximate normal variate via Box–Muller
function randNorm(mean: number, stdDev: number) {
	const u1 = Math.max(1e-9, rand());
	const u2 = rand();
	const z0 = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
	return mean + stdDev * z0;
}

// ============================================================================
// Static demo population
// ============================================================================

// Demo operators — first names rhyme with Nick / Nicholas / Alejandro,
// last names rhyme with Cox / Valdez. Full names displayed everywhere.
const OPERATOR_NAMES = [
	'Nick Fox',
	'Rick Knox',
	'Mick Cox',
	'Vic Brooks',
	'Nico Sanchez',
	'Leandro Valdez',
	'Alejandro Hernandez',
	'Alessandro Gonzalez',
	'Sandro Rodriguez',
	'Evandro Fernandez',
	'Dario Martinez',
	'Armando Gutierrez'
];

function operatorIdFor(name: string): string {
	return 'op-' + name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
}

const ROBOT_NAMES = Array.from({ length: 9 }, (_, i) => `Robot ${i + 1}`);
const DECK_IDS = Array.from({ length: 12 }, (_, i) => `DECK-${String(i + 1).padStart(3, '0')}`);
const TRAY_IDS = Array.from({ length: 16 }, (_, i) => `TRAY-${String(i + 1).padStart(3, '0')}`);
const OVEN_NAMES = ['Oven 1', 'Oven 2', 'Oven 3', 'Oven 4'];
const FRIDGE_NAMES = ['Fridge 1', 'Fridge 2', 'Fridge 3', 'Fridge 4', 'Fridge 5', 'Fridge 6'];
const ASSAY_NAMES = [
	{ name: 'CBC Plus Panel', skuCode: 'CBC-P-01' },
	{ name: 'Metabolic 14', skuCode: 'MET-14-02' },
	{ name: 'Thyroid Screen', skuCode: 'THY-S-03' },
	{ name: 'Lipid Profile', skuCode: 'LIP-P-04' }
];

// Rejection reason codes — Pareto-shaped (top 3 dominate)
const REJECTION_REASONS = [
	{ code: 'WAX-BUBBLE', label: 'Wax bubble defect', weight: 28, category: 'visual' },
	{ code: 'WAX-INCOMPLETE', label: 'Incomplete wax fill', weight: 22, category: 'visual' },
	{ code: 'WAX-OVERFILL', label: 'Wax overfill', weight: 18, category: 'visual' },
	{ code: 'REAGENT-VOLUME', label: 'Reagent volume out of spec', weight: 10, category: 'dimensional' },
	{ code: 'SEAL-GAP', label: 'Top seal gap', weight: 8, category: 'visual' },
	{ code: 'OP-ERROR', label: 'Operator error', weight: 5, category: 'operator' },
	{ code: 'CONTAMINATION', label: 'Contamination suspected', weight: 5, category: 'contamination' },
	{ code: 'EQUIP-FAULT', label: 'Equipment fault mid-run', weight: 2, category: 'equipment' },
	{ code: 'BARCODE-UNREAD', label: 'Barcode unreadable', weight: 2, category: 'operator' }
];

// ============================================================================
// Generate runs (~600 across 30 days)
// ============================================================================

interface DemoRun {
	runId: string;
	processType: ProcessType;
	processLabel: string;
	status: string;
	operator: string | null;
	operatorId: string | null;
	robotName: string | null;
	robotId: string | null;
	deckId: string | null;
	startTime: string | null;
	endTime: string | null;
	cycleTimeMin: number | null;
	plannedCount: number | null;
	actualCount: number | null;
	scrapCount: number | null;
	rejectedCount: number | null;
	acceptedCount: number | null;
	inputLots: { material: string; barcode: string }[];
	outputLotId: string | null;
	outputBucketBarcode: string | null;
	assayName: string | null;
	abortReason: string | null;
	shift: 'morning' | 'afternoon' | 'night' | null;
	createdAt: string;
}

function fakeRunId() {
	const chars = '0123456789abcdefghijklmnopqrstuvwxyz-';
	let id = '';
	for (let i = 0; i < 36; i++) {
		if (i === 8 || i === 13 || i === 18 || i === 23) id += '-';
		else id += chars[randInt(0, chars.length - 1)];
	}
	return id;
}

function fakeLotBarcode(prefix: string) {
	return `${prefix}-${randInt(10000, 99999)}`;
}

function generateRuns(): DemoRun[] {
	const now = Date.now();
	const thirtyDaysAgo = now - 30 * 24 * 60 * 60 * 1000;
	const runs: DemoRun[] = [];

	// Process mix is sized so cartridges flow coherently through the pipeline.
	// Starting target: ~5,000 backed cartridges/month (∼167/day). Each downstream
	// stage is sized to consume what the upstream stage accepted, minus ~1-5%
	// attrition per stage. Numbers chosen so per-stage math passes
	// scripts/audit-demo-consistency.ts.
	//
	//   WI-01 backed     ~5,040  (105 × 48)
	//   Wax in            5,060  (230 × 22)       ≈ matches upstream
	//   Wax accepted      ~4,810 (5% reject)
	//   Reagent in        4,770  (265 × 18)
	//   Reagent accepted  ~4,580 (4% reject)
	//   Top-seal in       4,560  (190 × 24)
	//   Top-seal out      ~4,470
	//   QA-QC in          4,500  (150 × 30)
	//
	// Supporting (sheet production):
	//   Laser cut         ~5,040  (63 × 80)     covers WI-01 thermoseal
	//   Cut thermoseal    ~2,000  (40 × 50)     parallel/backup supply
	//   Cut top seal      ~4,600  (92 × 50)     covers top-seal application
	const processMix: { type: ProcessType; count: number; meanCycleMin: number; sdCycleMin: number; meanBatch: number }[] = [
		{ type: 'laser-cut', count: 63, meanCycleMin: 22, sdCycleMin: 4, meanBatch: 80 },
		{ type: 'cut-thermoseal', count: 40, meanCycleMin: 14, sdCycleMin: 3, meanBatch: 50 },
		{ type: 'cut-top-seal', count: 92, meanCycleMin: 12, sdCycleMin: 2, meanBatch: 50 },
		{ type: 'wi-01', count: 105, meanCycleMin: 75, sdCycleMin: 12, meanBatch: 48 },
		{ type: 'wax', count: 230, meanCycleMin: 58, sdCycleMin: 9, meanBatch: 22 },
		{ type: 'reagent', count: 265, meanCycleMin: 44, sdCycleMin: 8, meanBatch: 18 },
		{ type: 'top-seal', count: 180, meanCycleMin: 18, sdCycleMin: 3, meanBatch: 24 },
		{ type: 'qa-qc', count: 140, meanCycleMin: 26, sdCycleMin: 5, meanBatch: 30 }
	];

	const cartridgeLots = ['PT-CT-104-A2', 'PT-CT-104-B7', 'PT-CT-104-C1'];
	const thermosealLots = ['PT-CT-112-L9', 'PT-CT-112-M3'];
	const barcodeLots = ['PT-CT-106-Q1', 'PT-CT-106-Q2', 'PT-CT-106-R4'];
	const waxLots = ['WAX-5561', 'WAX-5612', 'WAX-5640'];

	for (const mix of processMix) {
		for (let i = 0; i < mix.count; i++) {
			const start = thirtyDaysAgo + rand() * (now - thirtyDaysAgo);
			const cycleMin = Math.max(1, randNorm(mix.meanCycleMin, mix.sdCycleMin));
			const end = start + cycleMin * 60_000;
			const planned = Math.max(1, Math.round(randNorm(mix.meanBatch, mix.meanBatch * 0.1)));
			const actual = Math.max(1, planned - randInt(0, 2));
			// Rejection rate mean ~3%, heavier in wax (5%), lighter in backing (1%)
			const rejRate = mix.type === 'wax' ? 0.05
				: mix.type === 'reagent' ? 0.04
				: mix.type === 'wi-01' ? 0.01
				: 0.02;
			const rejected = mix.type === 'wax' || mix.type === 'reagent'
				? Math.max(0, Math.round(actual * rejRate + randNorm(0, 1.5)))
				: 0;
			const scrapped = mix.type === 'wi-01'
				? Math.max(0, Math.round(actual * 0.015 + randNorm(0, 1)))
				: 0;
			const accepted = Math.max(0, actual - rejected);

			const robotName = ['wax', 'reagent'].includes(mix.type) ? pick(ROBOT_NAMES) : null;
			const deckId = robotName ? pick(DECK_IDS) : null;
			const operator = pick(OPERATOR_NAMES);
			const abort = rand() < 0.03 ? pick(REJECTION_REASONS).label : null;
			const inputs: { material: string; barcode: string }[] = [];
			if (mix.type === 'wi-01') {
				inputs.push({ material: 'Cartridge', barcode: pick(cartridgeLots) });
				inputs.push({ material: 'Thermoseal Laser Cut Sheet', barcode: pick(thermosealLots) });
				inputs.push({ material: 'Barcode', barcode: pick(barcodeLots) });
			} else if (mix.type === 'laser-cut') {
				inputs.push({ material: 'Thermoseal Roll', barcode: 'TS-ROLL-' + randInt(100, 999) });
			} else if (mix.type === 'wax') {
				inputs.push({ material: 'Wax', barcode: pick(waxLots) });
				inputs.push({ material: 'Backing Bucket', barcode: `BUCKET-${randInt(1000, 9999)}` });
			} else if (mix.type === 'reagent') {
				const assay = pick(ASSAY_NAMES);
				for (let r = 0; r < 4; r++) {
					inputs.push({ material: assay.name + ' Reagent ' + (r + 1), barcode: `RG-${assay.skuCode}-${randInt(1000, 9999)}` });
				}
			}

			const run: DemoRun = {
				runId: fakeRunId(),
				processType: mix.type,
				processLabel: PROCESS_LABELS[mix.type],
				status: abort ? 'aborted' : 'completed',
				operator,
				operatorId: operatorIdFor(operator),
				robotName,
				robotId: robotName ? `robot-${robotName.toLowerCase().replace(/ /g, '-')}` : null,
				deckId,
				startTime: new Date(start).toISOString(),
				endTime: new Date(end).toISOString(),
				cycleTimeMin: Number(cycleMin.toFixed(2)),
				plannedCount: planned,
				actualCount: actual,
				scrapCount: scrapped,
				rejectedCount: rejected,
				acceptedCount: accepted,
				inputLots: inputs,
				outputLotId: mix.type === 'wi-01' ? fakeLotBarcode('LOT') : null,
				outputBucketBarcode: mix.type === 'wi-01' ? fakeLotBarcode('BUCKET') : null,
				assayName: mix.type === 'reagent' ? pick(ASSAY_NAMES).name : null,
				abortReason: abort,
				shift: inferShift(new Date(start)),
				createdAt: new Date(start).toISOString()
			};
			runs.push(run);
		}
	}
	return runs.sort((a, b) => (b.startTime ?? '').localeCompare(a.startTime ?? ''));
}

// ============================================================================
// Manual events
// ============================================================================

function generateManualEvents() {
	const events: any[] = [];
	const eventTypes = ['observation', 'deviation', 'environmental', 'msa_measurement', 'corrective_action', 'visual_defect', 'maintenance', 'calibration'];
	const processes: ProcessType[] = ['wi-01', 'wax', 'reagent', 'laser-cut', 'qa-qc', 'general'];
	const sampleNotes = [
		'Ambient humidity climbed to 58% during shift. No deviation from spec (limit 65%) but trending up.',
		'Observed slight bubble formation on 2 cartridges in deck position 3 and 7. Tagged, not scrapped.',
		'MSA — wax bead height measurement on standard part. 5 repeats.',
		'Corrective action closed: barcode printer recalibrated per WI-07. Verified on 10 labels.',
		'Calibration of Oven 2 thermocouple completed. Deviation 0.3°C, within tolerance.',
		'Preventive maintenance on Robot 4 — pipette tip holder cleaned. No impact.',
		'Training refresher: new operator shadowed full wax run for familiarization.',
		'Deviation: Tray TRAY-007 arrived out of sequence from sterilization. Isolated.'
	];
	for (let i = 0; i < 80; i++) {
		const type = pick(eventTypes);
		const proc = pick(processes);
		const when = Date.now() - rand() * 30 * 24 * 60 * 60 * 1000;
		events.push({
			id: `evt-${i}-${randInt(1000, 9999)}`,
			eventType: type,
			processType: proc,
			occurredAt: new Date(when).toISOString(),
			operator: pick(OPERATOR_NAMES),
			operatorId: null,
			linkedRunId: rand() < 0.3 ? fakeRunId() : null,
			linkedLotId: rand() < 0.2 ? fakeLotBarcode('LOT') : null,
			linkedEquipmentId: rand() < 0.15 ? pick(ROBOT_NAMES) : null,
			linkedCartridgeIds: [],
			numericValue: type === 'msa_measurement' ? Number(randNorm(2.4, 0.08).toFixed(3)) : type === 'environmental' ? randInt(45, 62) : null,
			numericUnit: type === 'msa_measurement' ? 'mm' : type === 'environmental' ? '%RH' : null,
			categoricalValue: null,
			rejectionReasonCode: type === 'visual_defect' ? pick(REJECTION_REASONS).code : null,
			severity: type === 'deviation' ? pick(['minor', 'major', 'critical']) : null,
			notes: pick(sampleNotes),
			attachments: [],
			createdAt: new Date(when).toISOString()
		});
	}
	return events.sort((a, b) => b.occurredAt.localeCompare(a.occurredAt));
}

// ============================================================================
// FMEA entries
// ============================================================================

function generateFmea() {
	const entries: any[] = [];
	const defs: [ProcessType, string, string, string, string, string, [number, number, number]][] = [
		['wax', 'wax_dispense', 'Incomplete wax fill', 'Cartridge unusable downstream', 'Pipette tip partial clog', 'Visual QC post-run + wax bead photo', [7, 4, 5]],
		['wax', 'cooling', 'Premature tray removal', 'Soft wax smears', 'Operator rushes next run', 'Tray lock-out timer + audible alarm', [6, 3, 4]],
		['wax', 'wax_dispense', 'Overfill — spillover', 'Contamination of adjacent wells', 'Calibration drift', 'Daily dispense-volume calibration', [8, 2, 3]],
		['reagent', 'volumetric_fill', 'Reagent volume out of spec', 'Assay invalid', 'Tube leak / air bubble', 'Pre-run tube inspection + post-run gravimetric', [9, 3, 4]],
		['reagent', 'inspection', 'False-negative on visual QC', 'Defect ships to customer', 'Lighting variation at inspection station', 'Standardized lightbox + CV backup', [10, 2, 6]],
		['wi-01', 'deck_loading', 'Wrong thermoseal lot scanned', 'Traceability break', 'Two lots open at station', 'Lot-match server validation at scan', [8, 2, 3]],
		['wi-01', 'backing', 'Cartridge misalignment in bucket', 'Uneven cure', 'Operator loads by feel', 'Bucket geometry fixture', [5, 4, 5]],
		['laser-cut', 'cut', 'Laser focus drift', 'Cut edge burr', 'Lens contamination', 'Weekly lens clean + cut-quality sample', [6, 3, 4]],
		['top-seal', 'seal', 'Top seal gap', 'Evaporation in storage', 'Seal head temperature', 'Seal head temp monitor + alarm', [8, 3, 3]],
		['qa-qc', 'release', 'Released cartridge fails analyte test', 'Customer complaint', 'Sampling plan too sparse', 'Increase QC sample % + investigate', [9, 2, 5]],
		['wax', 'wax_dispense', 'Contamination from prior run', 'Assay invalid', 'Deck not cleaned between runs', 'Deck-clean SOP checklist', [9, 2, 2]],
		['reagent', 'volumetric_fill', 'Operator skips pipette calibration check', 'Volumetric drift undetected', 'Checklist fatigue', 'Mandatory daily cal at login', [7, 4, 6]],
		['laser-cut', 'queue', 'Wrong roll loaded', 'Thermoseal type mismatch', 'Roll labels unclear', 'Color-coded labels + server validation', [8, 2, 3]],
		['wi-01', 'oven_placement', 'Bucket placed in wrong oven', 'Cure time mis-tracked', 'Multiple active ovens', 'Oven-scan required at placement', [6, 3, 2]],
		['wax', 'cooling_tray', 'Tray assigned to two runs in parallel', 'Traceability overlap', 'Race condition in legacy code', 'Tray uniqueness DB index', [9, 1, 2]],
		['top-seal', 'batching', 'Seal batch incomplete when expired', 'Wasted cartridges', 'Deadline timer unclear', 'Countdown UI + alerts', [5, 4, 5]]
	];
	for (let i = 0; i < defs.length; i++) {
		const [proc, step, mode, effect, cause, controls, [s, o, d]] = defs[i];
		entries.push({
			id: `fmea-${i}`,
			processType: proc,
			processStep: step,
			failureMode: mode,
			effect,
			cause,
			currentControls: controls,
			severity: s,
			occurrence: o,
			detection: d,
			rpn: s * o * d,
			classification: pick(['safety', 'quality', 'compliance', 'productivity']),
			status: rand() < 0.15 ? 'draft' : 'active',
			updatedAt: new Date(Date.now() - randInt(1, 30) * 24 * 3600_000).toISOString()
		});
	}
	return entries.sort((a, b) => b.rpn - a.rpn);
}

// ============================================================================
// SPC signals
// ============================================================================

function generateSpcSignals() {
	const signals: any[] = [];
	const ruleDescs = [
		{ n: 1, d: 'Point beyond 3σ from centerline' },
		{ n: 2, d: '9 consecutive points on same side of centerline' },
		{ n: 3, d: '6 consecutive points trending' },
		{ n: 5, d: '2 of 3 points beyond 2σ (same side)' },
		{ n: 6, d: '4 of 5 points beyond 1σ (same side)' }
	];
	const statuses = ['open', 'open', 'acknowledged', 'investigating', 'closed', 'closed', 'dismissed'];
	const processes: ProcessType[] = ['wax', 'reagent', 'wi-01', 'laser-cut'];
	const metrics = ['cycleTime', 'rejectionRate', 'scrapRate'];
	for (let i = 0; i < 18; i++) {
		const rule = pick(ruleDescs);
		const proc = pick(processes);
		const metric = pick(metrics);
		const chart = metric === 'cycleTime' ? 'i_mr' : 'p';
		const cl = metric === 'cycleTime' ? randNorm(50, 8) : 0.03;
		const sigma = cl * 0.1 + 0.001;
		const v = cl + (rand() < 0.5 ? -1 : 1) * sigma * randInt(3, 5);
		const status = pick(statuses);
		signals.push({
			id: `spc-${i}`,
			processType: proc,
			metric,
			chartType: chart,
			ruleNumber: rule.n,
			ruleDescription: rule.d,
			detectedAt: new Date(Date.now() - randInt(1, 30) * 24 * 3600_000).toISOString(),
			status,
			value: Number(v.toFixed(3)),
			centerline: Number(cl.toFixed(3)),
			ucl: Number((cl + 3 * sigma).toFixed(3)),
			lcl: Number((cl - 3 * sigma).toFixed(3)),
			assignedTo: status === 'open' ? null : pick(OPERATOR_NAMES),
			rootCause: status === 'closed' ? pick(['Tip contamination investigated and replaced', 'Operator retrained on SOP', 'Calibration drift — re-cal scheduled']) : null
		});
	}
	return signals;
}

// ============================================================================
// Spec limits — enough to light up Cp/Cpk for cycle time on each process
// ============================================================================

function generateSpecLimits() {
	return [
		{ id: 'spec-wax-ct', processType: 'wax' as ProcessType, metric: 'cycleTime', metricLabel: 'Cycle Time', unit: 'min', LSL: null, USL: 75, target: 58, cpkMin: 1.33, rationale: 'Validated off 30-run baseline Oct 2026; USL set at 3σ+target.', approvedBy: 'k.chen', effectiveFrom: '2026-04-01T00:00:00Z' },
		{ id: 'spec-reagent-ct', processType: 'reagent' as ProcessType, metric: 'cycleTime', metricLabel: 'Cycle Time', unit: 'min', LSL: null, USL: 60, target: 44, cpkMin: 1.33, rationale: 'Throughput target for 8-hr shift capacity.', approvedBy: 'k.chen', effectiveFrom: '2026-04-01T00:00:00Z' },
		{ id: 'spec-wi01-ct', processType: 'wi-01' as ProcessType, metric: 'cycleTime', metricLabel: 'Cycle Time', unit: 'min', LSL: null, USL: 100, target: 75, cpkMin: 1.33, rationale: 'Backing oven prep + load time budget.', approvedBy: 'a.patel', effectiveFrom: '2026-04-01T00:00:00Z' },
		{ id: 'spec-laser-ct', processType: 'laser-cut' as ProcessType, metric: 'cycleTime', metricLabel: 'Cycle Time', unit: 'min', LSL: null, USL: 30, target: 22, cpkMin: 1.33, rationale: 'Laser dwell-time design spec.', approvedBy: 'a.patel', effectiveFrom: '2026-04-01T00:00:00Z' }
	];
}

// ============================================================================
// Cause-effect diagrams
// ============================================================================

function generateCauseEffectDiagrams() {
	return [
		{
			id: 'ce-wax-reject',
			processType: 'wax' as ProcessType,
			problemStatement: 'Why do cartridges fail wax QC?',
			nodes: [
				{ category: 'Man', cause: 'Operator rushing on shift change', subCauses: [], weight: 3, linkedRejectionCodes: ['OP-ERROR'] },
				{ category: 'Man', cause: 'New operator unfamiliar with tip seating', subCauses: [], weight: 2, linkedRejectionCodes: [] },
				{ category: 'Machine', cause: 'Pipette tip partial clog', subCauses: [], weight: 5, linkedRejectionCodes: ['WAX-INCOMPLETE'] },
				{ category: 'Machine', cause: 'Dispense volume calibration drift', subCauses: [], weight: 4, linkedRejectionCodes: ['WAX-OVERFILL'] },
				{ category: 'Material', cause: 'Wax tube thermal cycling between lots', subCauses: [], weight: 3, linkedRejectionCodes: ['WAX-BUBBLE'] },
				{ category: 'Method', cause: 'Warm-up step skipped when switching lots', subCauses: [], weight: 3, linkedRejectionCodes: ['WAX-BUBBLE'] },
				{ category: 'Measurement', cause: 'Visual QC lighting inconsistent', subCauses: [], weight: 2, linkedRejectionCodes: [] },
				{ category: 'Environment', cause: 'Lab temperature drift above 25°C', subCauses: [], weight: 2, linkedRejectionCodes: [] }
			],
			updatedAt: new Date(Date.now() - 5 * 24 * 3600_000).toISOString()
		},
		{
			id: 'ce-reagent-reject',
			processType: 'reagent' as ProcessType,
			problemStatement: 'Why do reagent inspections fail?',
			nodes: [
				{ category: 'Man', cause: 'Visual grading subjectivity', subCauses: [], weight: 4, linkedRejectionCodes: [] },
				{ category: 'Machine', cause: 'Tube carousel jitter', subCauses: [], weight: 3, linkedRejectionCodes: ['REAGENT-VOLUME'] },
				{ category: 'Material', cause: 'Reagent lot viscosity variation', subCauses: [], weight: 4, linkedRejectionCodes: [] },
				{ category: 'Method', cause: 'Seal timing drift', subCauses: [], weight: 3, linkedRejectionCodes: ['SEAL-GAP'] },
				{ category: 'Measurement', cause: 'Gage R&R on inspection not current', subCauses: [], weight: 2, linkedRejectionCodes: [] },
				{ category: 'Environment', cause: 'Humidity spikes during afternoon', subCauses: [], weight: 2, linkedRejectionCodes: [] }
			],
			updatedAt: new Date(Date.now() - 12 * 24 * 3600_000).toISOString()
		}
	];
}

// ============================================================================
// Build page payload
// ============================================================================

function build(): any {
	const runs = generateRuns();
	const manualEvents = generateManualEvents();
	const fmea = generateFmea();
	const spcSignalsList = generateSpcSignals();
	const specLimits = generateSpecLimits();
	const ceDiagrams = generateCauseEffectDiagrams();

	// --- Overview ---
	const totalRuns = runs.length;
	const totalProduced = runs.reduce((s, r) => s + (r.acceptedCount ?? 0), 0);
	const totalScrapped = runs.reduce((s, r) => s + (r.scrapCount ?? 0), 0);
	const totalRejected = runs.reduce((s, r) => s + (r.rejectedCount ?? 0), 0);
	const totalInspected = runs.reduce((s, r) => s + ((r.acceptedCount ?? 0) + (r.rejectedCount ?? 0)), 0);
	const overallFpy = totalInspected > 0 ? (totalInspected - totalRejected) / totalInspected : null;
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
	const runsPerProcess: Record<string, number> = {};
	for (const r of runs) runsPerProcess[r.processType] = (runsPerProcess[r.processType] ?? 0) + 1;
	const openSignals = spcSignalsList.filter(s => s.status === 'open' || s.status === 'acknowledged' || s.status === 'investigating').length;

	// --- Cycle time per process (with spec limits applied so Cp/Cpk fires) ---
	const cycleTime: any[] = [];
	const byProcess = new Map<ProcessType, number[]>();
	for (const r of runs) {
		if (r.cycleTimeMin == null) continue;
		const arr = byProcess.get(r.processType) ?? [];
		arr.push(r.cycleTimeMin);
		byProcess.set(r.processType, arr);
	}
	for (const [proc, values] of byProcess) {
		const specs = specLimits.find(s => s.processType === proc && s.metric === 'cycleTime');
		cycleTime.push({
			processType: proc,
			label: PROCESS_LABELS[proc],
			descriptive: describe(values),
			histogram: histogram(values, 20),
			imr: imrChart(values.slice(0, 60)), // cap for chart readability
			capability: capability(values, { LSL: specs?.LSL ?? null, USL: specs?.USL ?? null, target: specs?.target ?? null }),
			specLimits: specs ? { LSL: specs.LSL, USL: specs.USL, target: specs.target, cpkMin: specs.cpkMin ?? 1.33 } : null,
			n: values.length
		});
	}
	cycleTime.sort((a, b) => b.n - a.n);

	// --- Pareto of rejection reasons ---
	const counts = new Map<string, number>();
	// seed runs' rejected counts across reasons proportional to weights
	for (const r of runs) {
		const n = r.rejectedCount ?? 0;
		for (let i = 0; i < n; i++) {
			// weighted pick
			const totalW = REJECTION_REASONS.reduce((s, x) => s + x.weight, 0);
			let t = rand() * totalW;
			for (const rr of REJECTION_REASONS) {
				t -= rr.weight;
				if (t <= 0) {
					counts.set(rr.label, (counts.get(rr.label) ?? 0) + 1);
					break;
				}
			}
		}
		if (r.abortReason) counts.set(r.abortReason, (counts.get(r.abortReason) ?? 0) + 1);
	}
	const pareto = paretoFromCounts(counts);

	// --- p-chart daily ---
	const byDay = new Map<string, { defects: number; sample: number }>();
	for (const r of runs) {
		if (r.processType !== 'wax' && r.processType !== 'reagent') continue;
		if (!r.startTime) continue;
		const key = r.startTime.slice(0, 10);
		const cur = byDay.get(key) ?? { defects: 0, sample: 0 };
		cur.defects += r.rejectedCount ?? 0;
		cur.sample += (r.acceptedCount ?? 0) + (r.rejectedCount ?? 0);
		byDay.set(key, cur);
	}
	const dailySamples = Array.from(byDay.entries())
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([day, s]) => ({ day, defects: s.defects, sampleSize: s.sample }));
	const dailyRejectionPChart = pChart(dailySamples);

	// --- Material flow ---
	const lotUsage = new Map<string, { material: string | null; runs: string[]; totalProduced: number; totalScrapped: number }>();
	for (const r of runs) {
		for (const inp of r.inputLots) {
			const cur = lotUsage.get(inp.barcode) ?? { material: inp.material, runs: [], totalProduced: 0, totalScrapped: 0 };
			cur.runs.push(r.runId);
			cur.totalProduced += r.actualCount ?? 0;
			cur.totalScrapped += r.scrapCount ?? 0;
			lotUsage.set(inp.barcode, cur);
		}
	}
	const lotUsageArr = Array.from(lotUsage.entries()).map(([barcode, data]) => ({
		barcode,
		material: data.material,
		runCount: data.runs.length,
		totalProduced: data.totalProduced,
		totalScrapped: data.totalScrapped,
		yield: data.totalProduced > 0 ? (data.totalProduced - data.totalScrapped) / data.totalProduced : null
	})).sort((a, b) => b.runCount - a.runCount);

	// --- Compare operator + robot (cycle time) ---
	const byOp = new Map<string, number[]>();
	const byRobot = new Map<string, number[]>();
	for (const r of runs) {
		if (r.cycleTimeMin == null) continue;
		if (r.operator) {
			const arr = byOp.get(r.operator) ?? [];
			arr.push(r.cycleTimeMin);
			byOp.set(r.operator, arr);
		}
		if (r.robotName) {
			const arr = byRobot.get(r.robotName) ?? [];
			arr.push(r.cycleTimeMin);
			byRobot.set(r.robotName, arr);
		}
	}
	const operatorGroups = Array.from(byOp.entries()).map(([name, values]) => ({ name, descriptive: describe(values) }));
	const robotGroups = Array.from(byRobot.entries()).map(([name, values]) => ({ name, descriptive: describe(values) }));
	const operatorAnova = operatorGroups.length >= 2 ? oneWayAnova(Array.from(byOp.values())) : null;
	const robotAnova = robotGroups.length >= 2 ? oneWayAnova(Array.from(byRobot.values())) : null;

	// --- SPC summary ---
	const byStatus: Record<string, number> = { open: 0, acknowledged: 0, investigating: 0, closed: 0, dismissed: 0 };
	for (const s of spcSignalsList) byStatus[s.status] = (byStatus[s.status] ?? 0) + 1;
	const byRule: Record<string, number> = {};
	for (const s of spcSignalsList) {
		const k = `Rule ${s.ruleNumber ?? '?'}`;
		byRule[k] = (byRule[k] ?? 0) + 1;
	}

	// --- FMEA summary ---
	const fmeaByProcess = new Map<string, { count: number; maxRpn: number; avgRpn: number; sum: number }>();
	for (const r of fmea) {
		const cur = fmeaByProcess.get(r.processType) ?? { count: 0, maxRpn: 0, avgRpn: 0, sum: 0 };
		cur.count++;
		cur.maxRpn = Math.max(cur.maxRpn, r.rpn ?? 0);
		cur.sum += r.rpn ?? 0;
		cur.avgRpn = cur.sum / cur.count;
		fmeaByProcess.set(r.processType, cur);
	}

	// --- Filter options ---
	const filterOptions = {
		processes: Object.keys(PROCESS_LABELS).map(p => ({ id: p, label: PROCESS_LABELS[p as ProcessType] })),
		operators: OPERATOR_NAMES.map(n => ({ id: operatorIdFor(n), username: n })),
		robots: ROBOT_NAMES.map(n => ({ id: `robot-${n.toLowerCase().replace(/ /g, '-')}`, name: n })),
		equipment: [
			...DECK_IDS.map(d => ({ id: `eq-${d}`, name: d, type: 'deck' })),
			...TRAY_IDS.map(t => ({ id: `eq-${t}`, name: t, type: 'cooling_tray' })),
			...OVEN_NAMES.map(o => ({ id: `eq-${o}`, name: o, type: 'oven' })),
			...FRIDGE_NAMES.map(f => ({ id: `eq-${f}`, name: f, type: 'fridge' }))
		],
		assays: ASSAY_NAMES.map((a, i) => ({ id: `assay-${i}`, name: a.name, skuCode: a.skuCode }))
	};

	const nowIso = new Date().toISOString();
	const thirtyDaysIso = new Date(Date.now() - 30 * 24 * 3600_000).toISOString();

	return {
		filters: {
			from: thirtyDaysIso, to: nowIso,
			processTypes: null, operatorIds: null, robotIds: null,
			equipmentIds: null, assayIds: null, inputLotBarcodes: null, shifts: null
		},
		filterOptions,
		overview: {
			totalRuns, totalProduced, totalScrapped, totalRejected, totalInspected,
			overallFpy, rty: rtyValue,
			stageYields, runsPerProcess, openSignals
		},
		cycleTime,
		yieldFailures: {
			pareto,
			dailyRejectionPChart,
			dailyRejectionDays: dailySamples.map(d => d.day)
		},
		materialFlow: { lotUsage: lotUsageArr },
		compare: { operatorGroups, robotGroups, operatorAnova, robotAnova },
		spcSignals: {
			byStatus,
			byRule,
			recent: spcSignalsList.slice(0, 50)
		},
		fmeaSummary: {
			byProcess: Array.from(fmeaByProcess.entries()).map(([p, c]) => ({ process: p, ...c })),
			top10: fmea.slice(0, 10),
			all: fmea
		},
		manualEvents,
		causeEffectDiagrams: ceDiagrams,
		specLimits,
		rejectionReasonCodes: REJECTION_REASONS.map((r, i) => ({
			id: `rr-${i}`, code: r.code, label: r.label, processType: null, category: r.category, severity: null, sortOrder: i
		})),
		runs
	};
}

// Cache — generated once per server process
let cached: any = null;
export function getDemoAnalyticsPageData() {
	if (cached) return cached;
	cached = build();
	return cached;
}
