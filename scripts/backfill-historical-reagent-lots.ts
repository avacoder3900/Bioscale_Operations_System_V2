/**
 * One-shot: backfill 10 historical reagent lots from the source spreadsheets
 * the user shared 2026-05-14:
 *   - SuperQD Phase 1 × 4 (AT 480, AT 630, JQ 480, JQ 630), dated 2026-05-05
 *   - SuperQD Phase 2 × 4 (480 Chicken AT/JQ, 630 Cortisol AT/JQ), 2026-05-06
 *   - Antibody Biotinylation × 2 (cortisol Ab, goat anti-chicken Ab), v2 7-11-25
 *
 * Each lot ends up status='finalized' with parameter values, stock-material
 * barcodes, post-protocol fluorescence readings (where available), and a
 * top-level lotNote pointing back at the source spreadsheet.
 *
 * P2 lots are linked back to their corresponding P1 lots via inputLots
 * (the spreadsheet says "used all from phase 1" — convention: same operator
 * + matching wavelength).
 *
 * Idempotent on lotBarcode — re-runs upsert without duplicating.
 *
 * Run: npx tsx scripts/backfill-historical-reagent-lots.ts
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

const operator = { _id: 'backfill', username: 'backfill' };

// Lot-specific values extracted from the workbooks. Everything not listed
// here comes from the template defaults (the seed script already populated
// those). The lotBarcode for P1 wasn't in the spreadsheets (cell C8 blank),
// so we mint one with a stable, deterministic prefix per lot for idempotency.

const p1Lots = [
	{ tag: 'p1-480-at', op: 'AT',  wavelength: 480, lotBarcode: 'HIST-P1-480-AT-2026-05-05', startedAt: '2026-05-05T00:00:00.000Z' },
	{ tag: 'p1-630-at', op: 'AT',  wavelength: 630, lotBarcode: 'HIST-P1-630-AT-2026-05-05', startedAt: '2026-05-05T00:00:00.000Z' },
	{ tag: 'p1-480-jq', op: 'JQ',  wavelength: 480, lotBarcode: 'HIST-P1-480-JQ-2026-05-05', startedAt: '2026-05-05T00:00:00.000Z' },
	{ tag: 'p1-630-jq', op: 'JQ',  wavelength: 630, lotBarcode: 'HIST-P1-630-JQ-2026-05-05', startedAt: '2026-05-05T00:00:00.000Z' }
];

// Stock material barcodes appear in the spreadsheet Materials Used table
// (Carboxyl QD has separate barcodes for 480 vs 630). Same lot UUIDs across
// all P1 sheets — these were the bottles in use on 2026-05-05.
const p1StockBarcodes = {
	silica: 'dc6da1ae-f0b4-411d-a27d-3405c995eb3f',
	carboxylQd480: '038d404d-203d-4f38-a27b-7605868d0a46',
	carboxylQd630: 'c6d21e56-b012-4d33-94a3-9e7fa1b504f0',
	edc: '2a7afef3-b133-48a3-8644-dd4ce159e7c6',
	nhs: '23d690a2-7154-4114-9f5c-76ae54d80ad8',
	aptms: 'fb1fa96c-39f2-4960-919f-991654f2fe17',
	teos: '4aa96b9a-2ac6-4fd3-aaf2-c72961a71f18',
	ethanol: 'a537172b-86ce-40f6-847b-5f7c154390f9',
	ipa: '8164a279-85ac-4aba-a1e7-5021c48d29b7',
	nh4oh: 'b6a8d5d4-b720-4530-85c8-bffb5dafc887',
	water: 'd9366a79-df68-4151-8c29-828f3eedc277',
	mes: 'ab99b028-d793-4edf-9f53-e5fb4dba036e',
	pbs: '76e69855-ac24-4bdf-a40a-555f71da5e98'
};

// P2 lots — lot-specific solution barcodes from cell C8. The 630-Cortisol-AT
// lot is the one with the famous "AT had colored supernatant" observation.
const p2Lots = [
	{ tag: 'p2-480-chk-at',  op: 'AT', label: '480 Chicken AT', wavelength: 480, proteinRatio: 2,
	  lotBarcode: '3801e9f6-a583-43ba-b6cf-4763e241356b', startedAt: '2026-05-06T00:00:00.000Z',
	  p1ParentTag: 'p1-480-at' },
	{ tag: 'p2-480-chk-jq',  op: 'JQ', label: '480 Chicken JQ', wavelength: 480, proteinRatio: 2,
	  lotBarcode: '592687d1-c865-455a-ba88-1c82e2aa5c71', startedAt: '2026-05-06T00:00:00.000Z',
	  p1ParentTag: 'p1-480-jq' },
	{ tag: 'p2-630-crt-at',  op: 'AT', label: '630 Cortisol AT', wavelength: 630, proteinRatio: 1,
	  lotBarcode: '1f17a574-72fc-441b-b81a-58be4344a1b5', startedAt: '2026-05-06T00:00:00.000Z',
	  p1ParentTag: 'p1-630-at',
	  observation: 'AT lot had a colored supernatant at the end of phase 1 while the JQ lot had a clear supernatant. After that they were identical.' },
	{ tag: 'p2-630-crt-jq',  op: 'JQ', label: '630 Cortisol JQ', wavelength: 630, proteinRatio: 1,
	  lotBarcode: '6a44b917-177b-4af0-b106-5fe952c0f2ca', startedAt: '2026-05-06T00:00:00.000Z',
	  p1ParentTag: 'p1-630-jq' }
];

const p2StockBarcodes = {
	silanePegNhs: '70c611a9-cb90-4f10-9ac5-a49d418554cc',
	proteinSolution: '032dcc9d-ebfc-4e57-bc0d-c7b566368c10',
	ethanol: 'ea190c2c-b980-4a33-b134-6419625055ed',
	storageBuffer: '41aaaa34-02e3-4fef-87e0-5befcbe4bb0a',
	tris: '2aa6a0cd-10de-477e-acf5-93ca34451ffb',
	pbs: '76e69855-ac24-4bdf-a40a-555f71da5e98'
};

// Per-lot fluorescence readings from the Scan sheet (gain 70 for emission
// at the QD's color; standard is the "590 standard" used to normalize).
const p2Fluorescence: Record<string, { intensity: number; standardRef: number; label: string }> = {
	'p2-480-chk-at': { intensity: 13634, standardRef: 336, label: '480 emission, gain 70' },
	'p2-480-chk-jq': { intensity: 12849, standardRef: 336, label: '480 emission, gain 70' },
	'p2-630-crt-at': { intensity: 21041, standardRef: 1,   label: '630 emission, gain 70' },
	'p2-630-crt-jq': { intensity: 21178, standardRef: 1,   label: '630 emission, gain 70' }
};

// Antibody Biotinylation lots — extracted from the cortisol-Ab and goat-Ab
// sheets in the LP2 workbook. Stock-antibody barcode is the supplier lot.
// Post-Nano-Orange concentrations come from Sheet1 of the workbook (per-lot
// measured biotinylated-Ab concentrations after the 3× concentrator scrub).
const antibodyLots = [
	{ tag: 'ab-cortisol', op: 'AT', label: 'Cortisol Ab', stockConc: 4.734, desiredVolume: 2900,
	  stockAbBarcode: '9c53cc77-f31e-48fb-b296-fd8b05106904',
	  lotBarcode: 'HIST-AB-CORTISOL-2025-07-11',
	  measuredConc: 1.183 },
	{ tag: 'ab-goat',     op: 'AT', label: 'Goat anti-chicken Ab', stockConc: 1.119, desiredVolume: 1525,
	  stockAbBarcode: 'fa780d0b-8372-474e-be2c-8f79cc8ffac5',
	  lotBarcode: 'HIST-AB-GOAT-2025-07-11',
	  measuredConc: 1.083 }
];

async function main() {
	await mongoose.connect(URI!);
	const db = mongoose.connection.db!;
	const templates = db.collection('reagent_protocol_templates');
	const lots = db.collection('reagent_lots');
	const audit = db.collection('audit_log');

	// Resolve template ids by slug
	const tplBySlug: Record<string, any> = {};
	for (const slug of ['superqd-phase-1', 'superqd-phase-2', 'antibody-biotinylation']) {
		const t = await templates.findOne({ slug, status: 'active' });
		if (!t) throw new Error(`Template not seeded: ${slug}`);
		tplBySlug[slug] = t;
	}

	const created: Record<string, string> = {}; // tag → lot _id

	async function upsertLot(doc: any, tag: string) {
		const existing = await lots.findOne({ lotBarcode: doc.lotBarcode });
		if (existing) {
			await lots.updateOne({ _id: existing._id }, { $set: doc });
			created[tag] = String(existing._id);
			console.log(`↻ Updated ${tag} → ${doc.lotBarcode}`);
		} else {
			const id = nanoid(21);
			await lots.insertOne({ _id: id, ...doc } as any);
			await audit.insertOne({
				_id: nanoid(21),
				tableName: 'reagent_lots',
				recordId: id,
				action: 'INSERT',
				changedBy: 'backfill-historical',
				changedAt: new Date(),
				newData: { lotBarcode: doc.lotBarcode, source: 'historical-spreadsheet' }
			} as any);
			created[tag] = id;
			console.log(`✓ Seeded ${tag} → ${doc.lotBarcode} (${id})`);
		}
	}

	// — P1 lots —
	for (const l of p1Lots) {
		const tpl = tplBySlug['superqd-phase-1'];
		const qdBarcode = l.wavelength === 480 ? p1StockBarcodes.carboxylQd480 : p1StockBarcodes.carboxylQd630;
		const qdConc = l.wavelength === 480 ? 4.17 : 3.12;
		const startedAt = new Date(l.startedAt);
		const finalizedAt = new Date(new Date(l.startedAt).getTime() + 1000 * 60 * 60 * 18); // ~overnight react
		await upsertLot({
			lotBarcode: l.lotBarcode,
			templateId: tpl._id,
			templateSlug: tpl.slug,
			templateName: tpl.name,
			templateVersion: tpl.version,
			operator: { _id: `historic-${l.op.toLowerCase()}`, username: l.op },
			startedAt,
			finalizedAt,
			status: 'finalized',
			parameterValues: [
				{ key: 'silicaParticleMass', value: 2, unit: 'mg' },
				{ key: 'carboxylQdWavelength', value: l.wavelength, unit: 'nm' },
				{ key: 'desiredFinalConc', value: 20, unit: 'nM' },
				{ key: 'targetShellThickness', value: 15, unit: 'nm' },
				{ key: 'checkpoint1Conc', value: 1, unit: 'nM' },
				{ key: 'checkpoint1Volume', value: 5000, unit: 'uL' },
				{ key: 'checkpoint2Conc', value: 1, unit: 'nM' },
				{ key: 'checkpoint2Volume', value: 32, unit: 'uL' }
			],
			inputLots: [
				{ materialKey: 'silica',      source: 'manual', barcode: p1StockBarcodes.silica,   concentration: 10,    concentrationUnit: 'mg/mL', recordedAt: startedAt },
				{ materialKey: 'carboxylQd',  source: 'manual', barcode: qdBarcode,                concentration: qdConc, concentrationUnit: 'uM',   recordedAt: startedAt },
				{ materialKey: 'edc',         source: 'manual', barcode: p1StockBarcodes.edc,      recordedAt: startedAt },
				{ materialKey: 'nhs',         source: 'manual', barcode: p1StockBarcodes.nhs,      recordedAt: startedAt },
				{ materialKey: 'aptms',       source: 'manual', barcode: p1StockBarcodes.aptms,    concentration: 97, concentrationUnit: '%', recordedAt: startedAt },
				{ materialKey: 'teos',        source: 'manual', barcode: p1StockBarcodes.teos,     concentration: 98, concentrationUnit: '%', recordedAt: startedAt },
				{ materialKey: 'ethanol',     source: 'manual', barcode: p1StockBarcodes.ethanol,  concentration: 99.5, concentrationUnit: '%', recordedAt: startedAt },
				{ materialKey: 'ipa',         source: 'manual', barcode: p1StockBarcodes.ipa,      concentration: 99, concentrationUnit: '%', recordedAt: startedAt },
				{ materialKey: 'nh4oh',       source: 'manual', barcode: p1StockBarcodes.nh4oh,    concentration: 28, concentrationUnit: '%', recordedAt: startedAt },
				{ materialKey: 'water',       source: 'manual', barcode: p1StockBarcodes.water,    recordedAt: startedAt },
				{ materialKey: 'mes',         source: 'manual', barcode: p1StockBarcodes.mes,      recordedAt: startedAt },
				{ materialKey: 'pbs',         source: 'manual', barcode: p1StockBarcodes.pbs,      recordedAt: startedAt }
			],
			stepEntries: [],
			postProtocolReadings: [],
			finalOutputs: {
				concentration: 20, concentrationUnit: 'nM',
				notes: `Backfilled from "SuperQD - Phase1 TEOS Updated April 21, 2026" workbook, sheet "SuperQD-Phase1 ${l.wavelength} ${l.op} lot". Step-by-step QC data was not captured per-step in the source spreadsheet.`
			},
			lotNotes: [{
				_id: nanoid(21),
				body: `Historical lot — backfilled 2026-05-14 from the original Excel workbook. Operator ${l.op}, ${l.wavelength} nm. Fluorescence checkpoint values not recorded in the source sheet; only the planned/target volumes and material barcodes are preserved here.`,
				author: operator,
				createdAt: new Date(), updatedAt: new Date()
			}],
			finalObservations: '',
			flags: [],
			corrections: [],
			createdAt: startedAt, updatedAt: finalizedAt
		}, l.tag);
	}

	// — P2 lots — link to P1 parents by tag —
	for (const l of p2Lots) {
		const tpl = tplBySlug['superqd-phase-2'];
		const startedAt = new Date(l.startedAt);
		const finalizedAt = new Date(new Date(l.startedAt).getTime() + 1000 * 60 * 60 * 5);
		const parentLotId = created[l.p1ParentTag];
		const flu = p2Fluorescence[l.tag];
		const inputLots: any[] = [
			{ materialKey: 'superqd',      source: 'reagent_lot', sourceId: parentLotId, label: `HIST P1 (${l.p1ParentTag})`, recordedAt: startedAt },
			{ materialKey: 'silanePegNhs', source: 'manual', barcode: p2StockBarcodes.silanePegNhs, recordedAt: startedAt },
			{ materialKey: 'protein',      source: 'manual', barcode: p2StockBarcodes.proteinSolution, concentration: 6.388, concentrationUnit: 'mg/mL', recordedAt: startedAt },
			{ materialKey: 'tris',         source: 'manual', barcode: p2StockBarcodes.tris, recordedAt: startedAt },
			{ materialKey: 'pbs',          source: 'manual', barcode: p2StockBarcodes.pbs, recordedAt: startedAt },
			{ materialKey: 'ethanol',      source: 'manual', barcode: p2StockBarcodes.ethanol, concentration: 99.5, concentrationUnit: '%', recordedAt: startedAt },
			{ materialKey: 'storageBuffer', source: 'manual', barcode: p2StockBarcodes.storageBuffer, recordedAt: startedAt }
		];
		const lotNotes: any[] = [{
			_id: nanoid(21),
			body: `Historical lot — backfilled 2026-05-14 from "Super QD - Phase 2 TEOS Updated April 21, 2026" workbook, sheet "${l.label}". Lot solution barcode is the spreadsheet's recorded UUID (cell C8). Linked to P1 parent ${l.p1ParentTag}.`,
			author: operator,
			createdAt: new Date(), updatedAt: new Date()
		}];
		if (l.observation) {
			lotNotes.push({
				_id: nanoid(21),
				body: `Operator observation captured in source spreadsheet (row 17 free-text): "${l.observation}"`,
				author: operator,
				createdAt: new Date(), updatedAt: new Date()
			});
		}
		await upsertLot({
			lotBarcode: l.lotBarcode,
			templateId: tpl._id,
			templateSlug: tpl.slug,
			templateName: tpl.name,
			templateVersion: tpl.version,
			operator: { _id: `historic-${l.op.toLowerCase()}`, username: l.op },
			startedAt,
			finalizedAt,
			status: 'finalized',
			parameterValues: [
				{ key: 'superqdMass', value: 2, unit: 'mg' },
				{ key: 'superqdVolumeIn', value: 1268.59, unit: 'uL' },
				{ key: 'superqdConcIn', value: 20, unit: 'nM' },
				{ key: 'desiredFinalConc', value: 10, unit: 'nM' },
				{ key: 'checkpoint3Conc', value: 1, unit: 'nM' },
				{ key: 'checkpoint3Volume', value: 30, unit: 'uL' }
			],
			inputLots,
			stepEntries: [],
			postProtocolReadings: flu ? [
				{ checkpointKey: 'superqd-protein-fluorescence-intensity', label: 'SuperQD-Protein Fluorescence Intensity', value: flu.intensity, unit: 'AU', flag: 'qualitative', note: `Tecan reading, ${flu.label}, normalized standard ${flu.standardRef}`, enteredBy: operator, enteredAt: finalizedAt }
			] : [],
			finalOutputs: {
				concentration: 10, concentrationUnit: 'nM',
				notes: `Backfilled from Phase 2 workbook sheet "${l.label}". Parent Phase 1 lot: ${l.p1ParentTag}. QD:Protein ratio used = 1:${l.proteinRatio}.`
			},
			lotNotes,
			finalObservations: '',
			flags: [],
			corrections: [],
			createdAt: startedAt, updatedAt: finalizedAt
		}, l.tag);
	}

	// — Antibody Biotinylation lots —
	for (const l of antibodyLots) {
		const tpl = tplBySlug['antibody-biotinylation'];
		const startedAt = new Date('2025-07-11T00:00:00.000Z');
		const finalizedAt = new Date(startedAt.getTime() + 1000 * 60 * 60 * 4);
		await upsertLot({
			lotBarcode: l.lotBarcode,
			templateId: tpl._id,
			templateSlug: tpl.slug,
			templateName: tpl.name,
			templateVersion: tpl.version,
			operator: { _id: `historic-${l.op.toLowerCase()}`, username: l.op },
			startedAt,
			finalizedAt,
			status: 'finalized',
			parameterValues: [
				{ key: 'stockAntibodyConc', value: l.stockConc, unit: 'mg/mL' },
				{ key: 'desiredVolume', value: l.desiredVolume, unit: 'uL' },
				{ key: 'biotinAbRatio', value: 12 },
				{ key: 'biotinylationConc', value: 2, unit: 'mg/mL' },
				{ key: 'finalConc', value: 1.5, unit: 'mg/mL' },
				{ key: 'finalProclinPct', value: 0.02, unit: '%' }
			],
			inputLots: [
				{ materialKey: 'stockAntibody', source: 'manual', barcode: l.stockAbBarcode, concentration: l.stockConc, concentrationUnit: 'mg/mL', recordedAt: startedAt }
			],
			stepEntries: [],
			postProtocolReadings: [
				{ checkpointKey: 'measured-protein-conc', label: 'Measured Protein Concentration', value: l.measuredConc, unit: 'mg/mL', flag: l.measuredConc >= 1.0 && l.measuredConc <= 2.0 ? 'in-range' : 'out-of-range', note: 'Post-Nano-Orange (A280-A310) reading after 3× concentrator scrub', enteredBy: operator, enteredAt: finalizedAt }
			],
			finalOutputs: {
				concentration: l.measuredConc, concentrationUnit: 'mg/mL',
				notes: `Backfilled from "Antibody Biotinylation v2 (2)" workbook, sheet "Ab Biotinylation (${l.tag === 'ab-cortisol' ? 'cortisol' : 'goat'})". Real measured concentration after Nano Orange (target was 1.5 mg/mL).`
			},
			lotNotes: [{
				_id: nanoid(21),
				body: `Historical lot — backfilled 2026-05-14 from LP2 workbook (v2 7-11-25). Stock antibody supplier-lot barcode in inputLots[]. Post-protocol Nano-Orange concentration was ${l.measuredConc} mg/mL.`,
				author: operator,
				createdAt: new Date(), updatedAt: new Date()
			}],
			finalObservations: '',
			flags: [],
			corrections: [],
			createdAt: startedAt, updatedAt: finalizedAt
		}, l.tag);
	}

	console.log(`\nDone — ${Object.keys(created).length} lots in place.`);
	await mongoose.disconnect();
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
