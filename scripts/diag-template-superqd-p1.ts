/**
 * Dumps the SuperQD Phase 1 ReagentProtocolTemplate doc so you can compare
 * parameter-by-parameter and step-by-step against the Excel SOP.
 *
 * Run: npx tsx scripts/diag-template-superqd-p1.ts
 */
import mongoose from 'mongoose';
import * as dotenv from 'dotenv';
dotenv.config();

async function main() {
	await mongoose.connect(process.env.MONGODB_URI!);
	const db = mongoose.connection.db!;

	const col = db.collection('reagent_protocol_templates');
	const tpl = await col.findOne({
		$or: [
			{ slug: 'superqd-phase-1' },
			{ slug: 'superqd-phase1' },
			{ name: /SuperQD.*Phase\s*1/i }
		]
	});

	if (!tpl) {
		console.log('No SuperQD Phase 1 template found. Available templates:');
		const all = await col.find({}, { projection: { slug: 1, name: 1, version: 1, status: 1 } }).toArray();
		for (const t of all) console.log(`  ${t.slug} | ${t.name} v${t.version} | ${t.status}`);
		await mongoose.disconnect();
		return;
	}

	console.log('================================================================');
	console.log(`Template: ${tpl.name}`);
	console.log(`Slug:     ${tpl.slug}`);
	console.log(`Version:  ${tpl.version}`);
	console.log(`Mode:     ${tpl.mode ?? '(unset)'}`);
	console.log(`Status:   ${tpl.status}`);
	console.log('================================================================');

	console.log(`\n--- PARAMETERS (${(tpl.parameters ?? []).length}) ---`);
	for (const p of tpl.parameters ?? []) {
		const range = p.min != null || p.max != null ? ` [${p.min ?? '-'}..${p.max ?? '-'}]` : '';
		const def = p.defaultValue != null ? ` = ${p.defaultValue}` : '';
		const required = p.required ? ' (req)' : '';
		const cellRef = p.cellRef ? ` <Excel:${p.cellRef}>` : '';
		console.log(`  ${p.key}  "${p.label}"  ${p.unit ?? ''}${range}${def}${required}${cellRef}`);
		if (p.options) console.log(`    options: ${JSON.stringify(p.options)}`);
	}

	console.log(`\n--- MATERIALS (${(tpl.materials ?? []).length}) ---`);
	for (const m of tpl.materials ?? []) {
		const flags: string[] = [];
		if (m.role === 'input') flags.push('INPUT-LOT');
		if (m.role === 'stock') flags.push('STOCK');
		if (m.optional) flags.push('optional');
		if (m.canSourceFromSlugs?.length) flags.push(`sources:[${m.canSourceFromSlugs.join(',')}]`);
		console.log(`  ${m.key}  "${m.label}"  ${flags.join(' ')}`);
		if (m.catalogId) console.log(`    catalog: ${m.catalogId}`);
		if (m.amountFormula) console.log(`    amount:  ${m.amountFormula}`);
	}

	console.log(`\n--- STEPS (${(tpl.steps ?? []).length}) ---`);
	for (const [i, s] of (tpl.steps ?? []).entries()) {
		console.log(`\n  [${i + 1}] ${s.name}  (key=${s.key})`);
		if (s.description) console.log(`      desc: ${s.description}`);
		if (s.targetDurationMin) console.log(`      target: ${s.targetDurationMin} min`);
		if (s.reagents?.length) {
			console.log(`      reagents:`);
			for (const r of s.reagents) {
				const v = r.volume ? ` ${r.volume}${r.volumeUnit ?? ''}` : '';
				const pip = r.pipette ? ` pipette=${r.pipette}` : '';
				const freq = r.frequency ? ` freq=${r.frequency}` : '';
				const tag = r.isIntermediate ? ' [intermediate]' : '';
				console.log(`        - ${r.materialKey ?? r.label}${v}${pip}${freq}${tag}`);
			}
		}
		if (s.qcReadings?.length) {
			console.log(`      QC:`);
			for (const q of s.qcReadings) {
				const range = q.min != null || q.max != null ? ` [${q.min ?? '-'}..${q.max ?? '-'}]` : '';
				console.log(`        - ${q.key} "${q.label}" ${q.unit ?? ''}${range}`);
			}
		}
		if (s.substeps?.length) {
			console.log(`      substeps: ${s.substeps.length}`);
			for (const ss of s.substeps) console.log(`        · ${ss.text ?? ss.label ?? '(no text)'}`);
		}
	}

	console.log(`\n--- OUTPUT SPEC ---`);
	if (tpl.outputSpec) {
		console.log(`  catalogId: ${tpl.outputSpec.catalogId}`);
		console.log(`  defaultConcentration: ${tpl.outputSpec.defaultConcentration ?? '-'} ${tpl.outputSpec.concentrationUnit ?? ''}`);
		console.log(`  defaultVolume: ${tpl.outputSpec.defaultVolume ?? '-'} ${tpl.outputSpec.volumeUnit ?? ''}`);
	}
	if (tpl.outputSpecs?.length) {
		console.log(`  Additional outputSpecs[]: ${tpl.outputSpecs.length}`);
		for (const os of tpl.outputSpecs) console.log(`    - ${os.key}: catalog=${os.catalogId}`);
	}

	console.log('\n================================================================');
	console.log('Compare ALL of the above against the Excel SOP. Gaps = template');
	console.log('needs additions (edit reagent-protocol-template seed or add via UI');
	console.log('once template-editor lands in Phase B).');
	console.log('================================================================');

	await mongoose.disconnect();
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
