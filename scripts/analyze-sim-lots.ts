/**
 * Read-back analysis of the simulated lots — exercises the same queries
 * the list, compare, and lot-detail pages run.
 */
import mongoose from 'mongoose';
import * as dotenv from 'dotenv';
dotenv.config();

async function main() {
	await mongoose.connect(process.env.MONGODB_URI!);
	const db = mongoose.connection.db!;
	const lots = db.collection('reagent_lots');

	console.log('--- 1) List query (mimics the list page) ---');
	const list = await lots.find({ lotBarcode: { $regex: '^SIM-sim-' }, status: { $ne: 'deleted' } })
		.project({ lotBarcode: 1, templateName: 1, status: 1, 'operator.username': 1, flags: 1, finalOutputs: 1 })
		.sort({ createdAt: -1 })
		.toArray();
	for (const l of list) {
		const flagCount = (l.flags ?? []).length;
		const out = l.finalOutputs?.concentration != null ? `${l.finalOutputs.concentration} ${l.finalOutputs.concentrationUnit ?? ''}` : '—';
		console.log(`  ${l.lotBarcode.padEnd(28)} ${l.templateName?.padEnd(38)} flags=${flagCount}  out=${out}`);
	}

	console.log('\n--- 2) Lineage walk from sim-tracer-a ---');
	async function walkLineage(barcode: string, depth = 0, seen = new Set<string>()): Promise<void> {
		if (depth > 4) return;
		const lot = await lots.findOne({ lotBarcode: barcode });
		if (!lot) { console.log(`${'  '.repeat(depth)}? ${barcode} not found`); return; }
		if (seen.has(String(lot._id))) { console.log(`${'  '.repeat(depth)}↺ cycle on ${barcode}`); return; }
		seen.add(String(lot._id));
		console.log(`${'  '.repeat(depth)}${barcode}  (${lot.templateName})`);
		for (const il of lot.inputLots ?? []) {
			if (il.source === 'reagent_lot' && il.sourceId) {
				const parent = await lots.findOne({ _id: il.sourceId });
				if (parent) await walkLineage(parent.lotBarcode, depth + 1, seen);
				else console.log(`${'  '.repeat(depth + 1)}? upstream missing for ${il.materialKey}`);
			}
		}
	}
	await walkLineage('SIM-sim-tracer-a');

	console.log('\n--- 3) Compare query (sim P1 lots side-by-side) ---');
	const comparePair = await lots.find({ lotBarcode: { $in: ['SIM-sim-p1-480-a', 'SIM-sim-p1-630-a'] } }).toArray();
	for (const l of comparePair) {
		const wavelength = (l.parameterValues ?? []).find((p: any) => p.key === 'carboxylQdWavelength')?.value;
		const ch1 = (l.stepEntries ?? []).find((s: any) => s.stepKey === 'measure-qd-fluorescence');
		const ch2 = (l.stepEntries ?? []).find((s: any) => s.stepKey === 'measure-superqd-fluorescence');
		const supColor = ch2?.observations?.find((o: any) => o.promptKey === 'supernatant-color')?.body;
		const ch1Int = ch1?.qcReadings?.find((r: any) => r.checkpointKey === 'qd-fluorescence-intensity')?.value;
		const ch2Int = ch2?.qcReadings?.find((r: any) => r.checkpointKey === 'superqd-fluorescence-intensity')?.value;
		const supInt = ch2?.qcReadings?.find((r: any) => r.checkpointKey === 'supernatant-fluorescence-intensity')?.value;
		console.log(`  ${l.lotBarcode}  λ=${wavelength}nm  QD-stock=${ch1Int}  SuperQD=${ch2Int}  supernatant=${supInt}`);
		if (supColor) console.log(`    obs: "${supColor}"`);
	}

	console.log('\n--- 4) Flag surfacing on sim-ab-goat ---');
	const goat = await lots.findOne({ lotBarcode: 'SIM-sim-ab-goat' });
	for (const f of goat?.flags ?? []) {
		console.log(`  [${f.source}] step=${f.stepKey ?? '—'}  reason: ${f.reason}`);
	}

	console.log('\n--- 5) Step-completion progress per lot ---');
	const allSim = await lots.find({ lotBarcode: { $regex: '^SIM-sim-' } }).toArray();
	for (const l of allSim) {
		const tpl = await db.collection('reagent_protocol_templates').findOne({ _id: l.templateId });
		const tplSteps = (tpl?.steps ?? []).length;
		const doneSteps = (l.stepEntries ?? []).filter((s: any) => s.completedAt).length;
		const observations = (l.stepEntries ?? []).reduce((n: number, s: any) => n + (s.observations?.length ?? 0), 0);
		const readings = (l.stepEntries ?? []).reduce((n: number, s: any) => n + (s.qcReadings?.length ?? 0), 0);
		console.log(`  ${l.lotBarcode.padEnd(28)} steps ${doneSteps}/${tplSteps}  readings=${readings}  observations=${observations}`);
	}

	await mongoose.disconnect();
}
main().catch(e => { console.error(e); process.exit(1); });
