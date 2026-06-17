/**
 * Audit script — compare backfilled lots against what a "real" walkthrough
 * through the BIMS UI would produce. Prints a diff of present vs missing
 * fields per lot. Throwaway / read-only.
 */
import mongoose from 'mongoose';
import * as dotenv from 'dotenv';
dotenv.config();

async function main() {
	await mongoose.connect(process.env.MONGODB_URI!);
	const db = mongoose.connection.db!;
	const lots = db.collection('reagent_lots');
	const tpls = db.collection('reagent_protocol_templates');

	const p2 = await lots.findOne({ lotBarcode: '1f17a574-72fc-441b-b81a-58be4344a1b5' });
	const p2tpl = await tpls.findOne({ slug: 'superqd-phase-2' });
	const ab = await lots.findOne({ lotBarcode: 'HIST-AB-CORTISOL-2025-07-11' });
	const abtpl = await tpls.findOne({ slug: 'antibody-biotinylation' });

	function summarize(lot: any, tpl: any) {
		return {
			lotBarcode: lot?.lotBarcode,
			status: lot?.status,
			operator: lot?.operator,
			parameterValues_count: (lot?.parameterValues ?? []).length,
			template_parameter_count: (tpl?.parameters ?? []).length,
			inputLots_count: (lot?.inputLots ?? []).length,
			inputLots_with_sourceId: (lot?.inputLots ?? []).filter((i: any) => i.source === 'reagent_lot').length,
			inputLots_with_barcode: (lot?.inputLots ?? []).filter((i: any) => i.barcode).length,
			stepEntries_count: (lot?.stepEntries ?? []).length,
			template_step_count: (tpl?.steps ?? []).length,
			postProtocolReadings_count: (lot?.postProtocolReadings ?? []).length,
			template_post_assay_count: (tpl?.postProtocolAssays ?? []).length,
			template_post_reading_count: (tpl?.postProtocolAssays ?? []).reduce((n: number, a: any) => n + (a.readings ?? []).length, 0),
			lotNotes_count: (lot?.lotNotes ?? []).length,
			flags_count: (lot?.flags ?? []).length,
			materialsConsumed_count: (lot?.materialsConsumed ?? []).length,
			finalOutputs_concentration: lot?.finalOutputs?.concentration,
			finalObservations_present: !!lot?.finalObservations
		};
	}

	console.log('=== P2 lot (630 Cortisol AT) ===');
	console.log(JSON.stringify(summarize(p2, p2tpl), null, 2));
	console.log('\n=== Antibody lot (Cortisol Ab) ===');
	console.log(JSON.stringify(summarize(ab, abtpl), null, 2));

	await mongoose.disconnect();
}
main().catch(e => { console.error(e); process.exit(1); });
