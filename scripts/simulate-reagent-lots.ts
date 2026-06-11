/**
 * Simulation: walk through every protocol end-to-end, storing realistic
 * QC readings, observations, step notes, and final outputs. Builds a small
 * pool of lots so the compare view has something to chew on and so I can
 * critique the UX from a "what would I actually want to do here?" lens.
 *
 * Lots are tagged SIM-<slug>-<n>-<date> for easy cleanup via the
 * admin-password delete UI.
 *
 * Run: npx tsx scripts/simulate-reagent-lots.ts
 */
import mongoose from 'mongoose';
import { nanoid } from 'nanoid';
import * as dotenv from 'dotenv';
dotenv.config();

const URI = process.env.MONGODB_URI;
if (!URI) {
	console.error('MONGODB_URI not set');
	process.exit(1);
}

const SIM_OPERATOR = { _id: 'sim-claude', username: 'sim-claude' };
const NOW = new Date();

// Mirror of the client-side flag computation (saveStep would also re-flag
// on save; pre-computing here so the doc matches what the UI builds).
function flagFor(value: any, c: any): 'in-range' | 'out-of-range' | 'unmeasured' | 'qualitative' {
	if (c.type !== 'quantitative') return value ? 'qualitative' : 'unmeasured';
	if (value === '' || value === null || value === undefined) return 'unmeasured';
	const n = Number(value);
	if (Number.isNaN(n)) return 'unmeasured';
	if ((c.expectedMin !== undefined && n < c.expectedMin) || (c.expectedMax !== undefined && n > c.expectedMax)) return 'out-of-range';
	return 'in-range';
}

type Reading = { checkpointKey: string; value: any; note?: string };
type Obs = { promptKey: string; body: string };
type StepData = { stepKey: string; readings?: Reading[]; observations?: Obs[]; note?: string; complete?: boolean };
type LotSpec = {
	slug: string;
	tag: string;
	startedDaysAgo: number;
	params: Record<string, any>;
	inputs: Array<{ materialKey: string; source: 'manual' | 'reagent_lot'; barcode?: string; sourceLotTag?: string; concentration?: number; concentrationUnit?: string }>;
	steps: StepData[];
	postProtocol?: Reading[];
	lotNotes?: string[];
	finalObs?: string;
	outputs: { concentration?: number; concentrationUnit?: string; volume?: number; volumeUnit?: string; notes?: string };
};

// — Specs per protocol (lifted from the template defaults; varied per lot) —

const p1Specs: LotSpec[] = [
	{
		slug: 'superqd-phase-1', tag: 'sim-p1-480-a', startedDaysAgo: 2,
		params: { silicaParticleMass: 2, carboxylQdWavelength: 480, desiredFinalConc: 20, targetShellThickness: 15, checkpoint1Conc: 1, checkpoint1Volume: 5000, checkpoint2Conc: 1, checkpoint2Volume: 32 },
		inputs: [
			{ materialKey: 'silica', source: 'manual', barcode: 'SIM-SI-2026-05-A', concentration: 10, concentrationUnit: 'mg/mL' },
			{ materialKey: 'carboxylQd', source: 'manual', barcode: 'SIM-QD480-A', concentration: 4.17, concentrationUnit: 'uM' },
			{ materialKey: 'edc', source: 'manual', barcode: 'SIM-EDC-2026-05' },
			{ materialKey: 'nhs', source: 'manual', barcode: 'SIM-NHS-2026-05' }
		],
		steps: [
			{ stepKey: 'wash-silica', readings: [{ checkpointKey: 'wash-target-conc', value: 2.0 }], note: 'Silica pelleted cleanly after 1 hr at 2.8g. Pearlescent sheen visible after resuspension.', complete: true },
			{ stepKey: 'measure-qd-fluorescence', readings: [{ checkpointKey: 'qd-fluorescence-intensity', value: 510 }, { checkpointKey: 'qd-fluorescence-scan', value: 525 }], complete: true },
			{ stepKey: 'dilute-qd-mes', readings: [{ checkpointKey: 'activation-target-conc', value: 2 }], complete: true },
			{ stepKey: 'prep-edc', complete: true },
			{ stepKey: 'prep-nhs', complete: true },
			{ stepKey: 'activate-qd', observations: [{ promptKey: 'activation-mixing', body: 'Well mixed throughout. Gentle vortex at 5 and 15 min — particles stayed suspended.' }], note: 'Reaction ran 20 min RT.', complete: true },
			{ stepKey: 'filter-qd', note: 'Two rounds at 5g, 10 min each. Retained vol ~35 uL each round.', complete: true },
			{ stepKey: 'mix-qd-silica', observations: [{ promptKey: 'qd-silica-mixing', body: 'Stayed well-mixed at 820 rpm. Sonicated briefly at 40 min for a tighter resuspension.' }], complete: true },
			{ stepKey: 'prep-aptms-int1', complete: true },
			{ stepKey: 'prep-aptms-int2', complete: true },
			{ stepKey: 'prep-teos-int', complete: true },
			{ stepKey: 'add-aptms', complete: true },
			{ stepKey: 'wash-superqd-stober', complete: true },
			{ stepKey: 'add-teos', note: '6 aliquots × 10 min, magnetic stir 820 rpm. Overnight react covered. No visible aggregation in the morning.', complete: true },
			{ stepKey: 'wash-final', complete: true },
			{ stepKey: 'measure-superqd-fluorescence',
				readings: [
					{ checkpointKey: 'superqd-fluorescence-intensity', value: 13634 },
					{ checkpointKey: 'superqd-fluorescence-scan', value: 13980 },
					{ checkpointKey: 'supernatant-fluorescence-intensity', value: 510, note: 'low — minimal QD leakage' },
					{ checkpointKey: 'supernatant-fluorescence-scan', value: 540 }
				],
				observations: [{ promptKey: 'supernatant-color', body: 'Clear supernatant — no visible color, looks like a clean wash.' }],
				complete: true }
		],
		outputs: { concentration: 20, concentrationUnit: 'nM', volume: 1268.59, volumeUnit: 'uL', notes: 'On-target. Ready to feed Phase 2.' },
		lotNotes: ['Sim lot — all steps walked, baseline 480 nm SuperQD prep, ran clean.'],
		finalObs: 'Pellet was easy to see after final spin. Sample re-suspended cleanly.'
	},
	{
		slug: 'superqd-phase-1', tag: 'sim-p1-630-a', startedDaysAgo: 2,
		params: { silicaParticleMass: 2, carboxylQdWavelength: 630, desiredFinalConc: 20, targetShellThickness: 15, checkpoint1Conc: 1, checkpoint1Volume: 5000, checkpoint2Conc: 1, checkpoint2Volume: 32 },
		inputs: [
			{ materialKey: 'silica', source: 'manual', barcode: 'SIM-SI-2026-05-A', concentration: 10, concentrationUnit: 'mg/mL' },
			{ materialKey: 'carboxylQd', source: 'manual', barcode: 'SIM-QD630-A', concentration: 3.12, concentrationUnit: 'uM' }
		],
		steps: [
			{ stepKey: 'wash-silica', readings: [{ checkpointKey: 'wash-target-conc', value: 2.0 }], complete: true },
			{ stepKey: 'measure-qd-fluorescence', readings: [{ checkpointKey: 'qd-fluorescence-intensity', value: 23580 }, { checkpointKey: 'qd-fluorescence-scan', value: 24100 }], complete: true },
			{ stepKey: 'dilute-qd-mes', readings: [{ checkpointKey: 'activation-target-conc', value: 2 }], complete: true },
			{ stepKey: 'prep-edc', complete: true },
			{ stepKey: 'prep-nhs', complete: true },
			{ stepKey: 'activate-qd', complete: true },
			{ stepKey: 'filter-qd', complete: true },
			{ stepKey: 'mix-qd-silica', complete: true },
			{ stepKey: 'prep-aptms-int1', complete: true },
			{ stepKey: 'prep-aptms-int2', complete: true },
			{ stepKey: 'prep-teos-int', complete: true },
			{ stepKey: 'add-aptms', complete: true },
			{ stepKey: 'wash-superqd-stober', complete: true },
			{ stepKey: 'add-teos', complete: true },
			{ stepKey: 'wash-final', complete: true },
			{ stepKey: 'measure-superqd-fluorescence',
				readings: [
					{ checkpointKey: 'superqd-fluorescence-intensity', value: 21041 },
					{ checkpointKey: 'superqd-fluorescence-scan', value: 21500 },
					{ checkpointKey: 'supernatant-fluorescence-intensity', value: 2400, note: 'noticeable — slight color in supernatant' },
					{ checkpointKey: 'supernatant-fluorescence-scan', value: 2450 }
				],
				observations: [{ promptKey: 'supernatant-color', body: 'Pale red-orange tint to the final wash supernatant. Not clear but not deeply colored either.' }],
				complete: true }
		],
		outputs: { concentration: 20, concentrationUnit: 'nM', volume: 1268.59, volumeUnit: 'uL' },
		lotNotes: ['Sim lot — 630 nm variant. Slight color in last wash supernatant — flagged for follow-up if it correlates with low conjugation yield in Phase 2.'],
		finalObs: 'Yield looks acceptable but the colored supernatant is something to watch.'
	}
];

const p2Specs: LotSpec[] = [
	{
		slug: 'superqd-phase-2', tag: 'sim-p2-480-a', startedDaysAgo: 1,
		params: { superqdMass: 2, superqdVolumeIn: 1268.59, superqdConcIn: 20, desiredFinalConc: 10, checkpoint3Conc: 1, checkpoint3Volume: 30 },
		inputs: [
			{ materialKey: 'superqd', source: 'reagent_lot', sourceLotTag: 'sim-p1-480-a' },
			{ materialKey: 'silanePegNhs', source: 'manual', barcode: 'SIM-SPN-2026-05' },
			{ materialKey: 'protein', source: 'manual', barcode: 'SIM-IGY-2026-05', concentration: 6.388, concentrationUnit: 'mg/mL' },
			{ materialKey: 'tris', source: 'manual', barcode: 'SIM-TRIS-A' }
		],
		steps: [
			{ stepKey: 'prep-silane-peg', complete: true, note: 'Dissolved fully in 3 min — no particles.' },
			{ stepKey: 'add-silane-peg', observations: [{ promptKey: 'rxn-mixing-1', body: 'Solution stayed well-mixed on the rotary. Sonicated at 20, 40, 60 min.' }], complete: true },
			{ stepKey: 'wash-superqd-1', complete: true },
			{ stepKey: 'add-protein', observations: [{ promptKey: 'protein-rxn-mixing', body: 'Mixed cleanly. Particles redispersed every check. No high-vortex used.' }], complete: true },
			{ stepKey: 'quench-tris', complete: true },
			{ stepKey: 'wash-superqd-2', complete: true },
			{ stepKey: 'measure-fluorescence',
				readings: [
					{ checkpointKey: 'superqd-protein-fluorescence-intensity', value: 13980 },
					{ checkpointKey: 'superqd-protein-fluorescence-scan', value: 14210 }
				],
				complete: true }
		],
		outputs: { concentration: 10, concentrationUnit: 'nM', volume: 2530, volumeUnit: 'uL', notes: 'Yield matches expectations. Conjugation looks complete based on fluorescence retention.' },
		lotNotes: ['Sim lot — 480 chicken IgY conjugation built on sim-p1-480-a.']
	},
	{
		slug: 'superqd-phase-2', tag: 'sim-p2-630-a', startedDaysAgo: 1,
		params: { superqdMass: 2, superqdVolumeIn: 1268.59, superqdConcIn: 20, desiredFinalConc: 10, checkpoint3Conc: 1, checkpoint3Volume: 30 },
		inputs: [
			{ materialKey: 'superqd', source: 'reagent_lot', sourceLotTag: 'sim-p1-630-a' },
			{ materialKey: 'silanePegNhs', source: 'manual', barcode: 'SIM-SPN-2026-05' },
			{ materialKey: 'protein', source: 'reagent_lot', sourceLotTag: 'sim-ab-cortisol' }
		],
		steps: [
			{ stepKey: 'prep-silane-peg', complete: true },
			{ stepKey: 'add-silane-peg', complete: true },
			{ stepKey: 'wash-superqd-1', complete: true, note: 'Pelleted easily after 12.4g spin.' },
			{ stepKey: 'add-protein', observations: [{ promptKey: 'protein-rxn-mixing', body: 'Some sticking on the tube wall at 60 min — gently knocked the tube and re-sonicated 2s. Resolved.' }], complete: true },
			{ stepKey: 'quench-tris', complete: true },
			{ stepKey: 'wash-superqd-2', complete: true },
			{ stepKey: 'measure-fluorescence',
				readings: [
					{ checkpointKey: 'superqd-protein-fluorescence-intensity', value: 18800, note: 'Lower than 480 sister lot at similar dilution — investigating' },
					{ checkpointKey: 'superqd-protein-fluorescence-scan', value: 19200 }
				],
				complete: true }
		],
		outputs: { concentration: 9.2, concentrationUnit: 'nM', volume: 2530, volumeUnit: 'uL', notes: 'Slightly under target. May tie back to the colored Phase 1 supernatant observation on sim-p1-630-a.' },
		lotNotes: [
			'Sim lot — 630 cortisol conjugation. Yield below target.',
			'Possible link to sim-p1-630-a phase-1 wash issue (colored supernatant). Worth comparing fluorescence ratios across the two 630 lots.'
		]
	}
];

const abSpecs: LotSpec[] = [
	{
		slug: 'antibody-biotinylation', tag: 'sim-ab-cortisol', startedDaysAgo: 4,
		params: { stockAntibodyConc: 4.734, desiredVolume: 2900, biotinAbRatio: 12, biotinylationConc: 2, finalConc: 1.5, finalProclinPct: 0.02 },
		inputs: [
			{ materialKey: 'stockAntibody', source: 'manual', barcode: 'SIM-AB-CORTISOL-001', concentration: 4.734, concentrationUnit: 'mg/mL' },
			{ materialKey: 'biotinLinker', source: 'manual', barcode: 'SIM-NHS-PEG4-A' }
		],
		steps: [
			{ stepKey: 'make-2mg-ml-ab', complete: true },
			{ stepKey: 'reconstitute-biotin', complete: true, note: 'Mixed steady 2 min — no clumps remained.' },
			{ stepKey: 'biotin-working-solution', complete: true },
			{ stepKey: 'biotinylate', observations: [{ promptKey: 'biotinylation-mixing', body: 'Homogeneous throughout 20 min. Vortexed at 5, 10, 15 min low speed.' }], complete: true },
			{ stepKey: 'quench-tris', complete: true },
			{ stepKey: 'concentrator-3x', readings: [{ checkpointKey: 'retained-volume', value: 18, note: 'within 15-20 uL window all 3 rounds' }], complete: true },
			{ stepKey: 'resuspend-1-5', complete: true }
		],
		postProtocol: [
			{ checkpointKey: 'a280', value: 0.3467 },
			{ checkpointKey: 'a310', value: 0.0412 },
			{ checkpointKey: 'measured-protein-conc', value: 1.51, note: 'Almost exactly on target' },
			{ checkpointKey: 'haba-fluorescence', value: 12086 },
			{ checkpointKey: 'biotin-per-ab', value: 11.8, note: 'Within 10-14 target range' }
		],
		outputs: { concentration: 1.51, concentrationUnit: 'mg/mL', volume: 1933, volumeUnit: 'uL', notes: 'On-target biotinylation. Ready for cortisol Phase 2 conjugation.' },
		lotNotes: ['Sim lot — cortisol Ab biotinylation, on-target.']
	},
	{
		slug: 'antibody-biotinylation', tag: 'sim-ab-goat', startedDaysAgo: 4,
		params: { stockAntibodyConc: 1.119, desiredVolume: 1525, biotinAbRatio: 12, biotinylationConc: 2, finalConc: 1.5, finalProclinPct: 0.02 },
		inputs: [
			{ materialKey: 'stockAntibody', source: 'manual', barcode: 'SIM-AB-GOAT-001', concentration: 1.119, concentrationUnit: 'mg/mL' }
		],
		steps: [
			{ stepKey: 'make-2mg-ml-ab', complete: true },
			{ stepKey: 'reconstitute-biotin', complete: true },
			{ stepKey: 'biotin-working-solution', complete: true },
			{ stepKey: 'biotinylate', complete: true },
			{ stepKey: 'quench-tris', complete: true },
			{ stepKey: 'concentrator-3x', readings: [{ checkpointKey: 'retained-volume', value: 13, note: 'low — slightly below the 15-20 uL window on round 2' }], complete: true },
			{ stepKey: 'resuspend-1-5', complete: true }
		],
		postProtocol: [
			{ checkpointKey: 'measured-protein-conc', value: 0.91, note: 'Below the 1.0 lower bound — out-of-range flag expected' },
			{ checkpointKey: 'biotin-per-ab', value: 10.4, note: 'Just inside the lower end of the 10-14 target' }
		],
		outputs: { concentration: 0.91, concentrationUnit: 'mg/mL', volume: 1525, volumeUnit: 'uL', notes: 'Below target concentration after Nano Orange. Goat stock conc was already low (1.119 vs 4.7 mg/mL) so reduced final yield was expected.' },
		lotNotes: ['Sim lot — goat anti-chicken biotinylation, below target conc. Stock antibody was already dilute.']
	}
];

const bufferSpecs: LotSpec[] = [
	{
		slug: 'hepes-cortisol-buffer', tag: 'sim-buffer-a', startedDaysAgo: 5,
		params: { desiredVolume: 40000, desiredBsaPct: 1.5, desiredP188Pct: 0.2, desiredProclinPct: 0.05, lArginineMm: 20, desiredGlycerolPct: 2 },
		inputs: [
			{ materialKey: 'bufferBase', source: 'manual', barcode: 'SIM-HEPES-BASE' },
			{ materialKey: 'bsa', source: 'manual', barcode: 'SIM-BSA-001' }
		],
		steps: [
			{ stepKey: 'dissolve-bsa', observations: [{ promptKey: 'bsa-dissolved', body: 'BSA fully dissolved in ~12 min with gentle inversion. Minimal foaming.' }], complete: true },
			{ stepKey: 'add-p188', complete: true },
			{ stepKey: 'add-l-arginine', complete: true },
			{ stepKey: 'add-glycerol', complete: true },
			{ stepKey: 'add-proclin', complete: true },
			{ stepKey: 'ph-adjust', readings: [{ checkpointKey: 'naoh-added', value: 1620 }, { checkpointKey: 'final-ph', value: 8.0 }], complete: true },
			{ stepKey: 'label-store', complete: true }
		],
		outputs: { volume: 40000, volumeUnit: 'uL', notes: 'Standard buffer prep — pH on target.' },
		lotNotes: ['Sim lot — HEPES cortisol buffer baseline batch.']
	}
];

const beadMixSpecs: LotSpec[] = [
	{
		slug: 'cortisol-bead-mix', tag: 'sim-beadmix-a', startedDaysAgo: 3,
		params: { desiredVolume: 1000, totalBolusMass: 50, beadsStockConc: 10, wellVolume: 19 },
		inputs: [
			{ materialKey: 'cortisolBeads', source: 'manual', barcode: 'SIM-CORT-BEADS-001', concentration: 10, concentrationUnit: 'mg/mL' },
			{ materialKey: 'cortisolBuffer', source: 'reagent_lot', sourceLotTag: 'sim-buffer-a' }
		],
		steps: [
			{ stepKey: 'vortex-beads', observations: [{ promptKey: 'bead-resuspension', body: 'Used magnetic resuspension after vortex — beads fully off the wall.' }], complete: true },
			{ stepKey: 'prepare-bead-suspension', complete: true },
			{ stepKey: 'remove-supernatant', complete: true },
			{ stepKey: 'add-buffer', complete: true },
			{ stepKey: 'final-vortex-label', complete: true }
		],
		outputs: { volume: 1000, volumeUnit: 'uL', notes: 'Bead mix ready for cartridge well 2.' },
		lotNotes: ['Sim lot — bead mix using sim-buffer-a as buffer source.']
	}
];

const tracerSpecs: LotSpec[] = [
	{
		slug: 'cortisol-tracer', tag: 'sim-tracer-a', startedDaysAgo: 3,
		params: { desiredVolume: 18, desiredCortisolTracerConc: 0.25, desiredReferenceTracerConc: 0.5, stockCortisolSqdConc: 10, stockReferenceSqdConc: 10, sampleDilution: 0.5 },
		inputs: [
			{ materialKey: 'cortisolBuffer', source: 'reagent_lot', sourceLotTag: 'sim-buffer-a' },
			{ materialKey: 'cortisolSqd', source: 'reagent_lot', sourceLotTag: 'sim-p2-630-a' },
			{ materialKey: 'referenceSqd', source: 'reagent_lot', sourceLotTag: 'sim-p2-480-a' }
		],
		steps: [
			{ stepKey: 'sonicate-sqds', complete: true, note: 'Stocks sonicated and vortexed before pipetting.' },
			{ stepKey: 'mix-tracer', complete: true },
			{ stepKey: 'final-vortex-label', complete: true }
		],
		outputs: { volume: 18, volumeUnit: 'uL', notes: 'Tracer mixed from sim-p2 lots and sim-buffer-a.' },
		lotNotes: ['Sim lot — tracer mix combining 480 + 630 phase-2 lots.']
	}
];

async function main() {
	await mongoose.connect(URI!);
	const db = mongoose.connection.db!;
	const templates = db.collection('reagent_protocol_templates');
	const lots = db.collection('reagent_lots');

	// Pre-fetch all templates we need
	const tplMap: Record<string, any> = {};
	for (const slug of ['superqd-phase-1', 'superqd-phase-2', 'antibody-biotinylation', 'hepes-cortisol-buffer', 'cortisol-bead-mix', 'cortisol-tracer']) {
		const t = await templates.findOne({ slug, status: 'active' });
		if (!t) throw new Error(`Template missing: ${slug}`);
		tplMap[slug] = t;
	}

	const lotIdByTag: Record<string, string> = {};

	async function buildLot(spec: LotSpec) {
		const tpl = tplMap[spec.slug];
		const startedAt = new Date(NOW.getTime() - spec.startedDaysAgo * 24 * 3600 * 1000);
		const stepEntries: any[] = [];

		let cursor = startedAt.getTime();
		const flags: any[] = [];

		for (const sd of spec.steps) {
			const tplStep = tpl.steps.find((s: any) => s.key === sd.stepKey);
			if (!tplStep) {
				console.warn(`!! step missing in template ${spec.slug}: ${sd.stepKey}`);
				continue;
			}
			cursor += 1000 * 60 * 8; // 8 min per step
			const stepStart = new Date(cursor - 1000 * 60 * 5);
			const stepDone = new Date(cursor);

			const readings = (sd.readings ?? []).map((r) => {
				const c = (tplStep.qcCheckpoints ?? []).find((cp: any) => cp.key === r.checkpointKey);
				const flag = c ? flagFor(r.value, c) : 'unmeasured';
				if (flag === 'out-of-range' && c) {
					flags.push({
						_id: nanoid(21),
						source: 'qc', stepKey: sd.stepKey, checkpointKey: r.checkpointKey,
						reason: `${c.label} = ${r.value}${c.unit ?? ''} outside expected range`,
						createdAt: stepDone
					});
				}
				return { checkpointKey: r.checkpointKey, label: c?.label, value: r.value, unit: c?.unit, flag, note: r.note, enteredBy: SIM_OPERATOR, enteredAt: stepDone };
			});

			const observations = (sd.observations ?? []).map((o) => ({
				_id: nanoid(21), promptKey: o.promptKey, body: o.body, enteredBy: SIM_OPERATOR, enteredAt: stepDone, updatedAt: stepDone
			}));

			stepEntries.push({
				_id: nanoid(21),
				stepKey: sd.stepKey,
				stepNumber: tplStep.number,
				stepTitle: tplStep.title,
				startedAt: stepStart,
				completedAt: sd.complete ? stepDone : undefined,
				qcReadings: readings,
				observations,
				note: sd.note ?? '',
				flagged: readings.some((r: any) => r.flag === 'out-of-range')
			});
		}

		const inputLots = spec.inputs.map((i) => ({
			materialKey: i.materialKey,
			source: i.source,
			sourceId: i.source === 'reagent_lot' ? (i.sourceLotTag ? lotIdByTag[i.sourceLotTag] : undefined) : undefined,
			label: i.source === 'reagent_lot' && i.sourceLotTag ? `SIM (${i.sourceLotTag})` : undefined,
			barcode: i.barcode,
			concentration: i.concentration,
			concentrationUnit: i.concentrationUnit,
			recordedAt: startedAt
		}));

		const postProtocolReadings = (spec.postProtocol ?? []).map((r) => {
			const assay = (tpl.postProtocolAssays ?? []).find((a: any) => (a.readings ?? []).some((rd: any) => rd.key === r.checkpointKey));
			const cp = assay?.readings?.find((rd: any) => rd.key === r.checkpointKey);
			const flag = cp ? flagFor(r.value, cp) : 'qualitative';
			if (flag === 'out-of-range' && cp) {
				flags.push({ _id: nanoid(21), source: 'post-protocol', checkpointKey: r.checkpointKey, reason: `${cp.label} = ${r.value}${cp.unit ?? ''} outside expected range`, createdAt: new Date(cursor) });
			}
			return { checkpointKey: r.checkpointKey, label: cp?.label, value: r.value, unit: cp?.unit, flag, note: r.note, enteredBy: SIM_OPERATOR, enteredAt: new Date(cursor) };
		});

		const finalizedAt = new Date(cursor + 1000 * 60 * 15);
		const id = nanoid(21);
		const lotDoc: any = {
			_id: id,
			lotBarcode: `SIM-${spec.tag}`,
			templateId: tpl._id,
			templateSlug: tpl.slug,
			templateName: tpl.name,
			templateVersion: tpl.version,
			operator: SIM_OPERATOR,
			startedAt,
			finalizedAt,
			status: 'finalized',
			parameterValues: Object.entries(spec.params).map(([k, v]) => {
				const def = (tpl.parameters ?? []).find((p: any) => p.key === k);
				return { key: k, value: v, unit: def?.unit };
			}),
			inputLots,
			stepEntries,
			postProtocolReadings,
			finalOutputs: spec.outputs,
			lotNotes: (spec.lotNotes ?? []).map((b) => ({ _id: nanoid(21), body: b, author: SIM_OPERATOR, createdAt: finalizedAt, updatedAt: finalizedAt })),
			finalObservations: spec.finalObs ?? '',
			flags,
			corrections: [],
			createdAt: startedAt, updatedAt: finalizedAt
		};

		const existing = await lots.findOne({ lotBarcode: lotDoc.lotBarcode });
		if (existing) {
			await lots.updateOne({ _id: existing._id }, { $set: lotDoc });
			lotIdByTag[spec.tag] = String(existing._id);
			console.log(`↻ ${spec.tag}  flags=${flags.length}`);
		} else {
			await lots.insertOne(lotDoc as any);
			lotIdByTag[spec.tag] = id;
			console.log(`✓ ${spec.tag}  flags=${flags.length}  (${id})`);
		}
	}

	// Order matters — children reference parents through lotIdByTag.
	const all: LotSpec[] = [
		...abSpecs,        // antibody first (cortisol Ab feeds 630 P2)
		...bufferSpecs,
		...p1Specs,
		...p2Specs,
		...beadMixSpecs,
		...tracerSpecs
	];
	for (const s of all) await buildLot(s);

	console.log(`\nSimulated lots: ${all.length}`);
	await mongoose.disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
